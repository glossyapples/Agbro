// Options safety layer. Everything in this file exists to keep the agent
// from blowing up the portfolio via options. Rules enforced here (and never
// loosenable by the model via prompt):
//   1. Only two setups allowed: covered_call, cash_secured_put.
//   2. Both the Account.optionsEnabled master switch AND the active
//      strategy's rules.optionsAllowed + rules.optionStrategies must
//      permit the setup.
//   3. Covered call requires qty × 100 shares of underlying already held.
//   4. Cash-secured put requires strike × 100 × qty cash idle.
//   5. Total option notional must not exceed rules.maxOptionsBookPct of
//      current portfolio value.
//   6. DTE 30–60 days, |delta| ≤ rules.maxDeltaAbs (default 0.30).
//   7. Strike direction must match setup: CC strike ≥ current price, CSP
//      strike ≤ current price. This is the bare-minimum check — the agent
//      should pick strike against its FAIR-VALUE estimate, which only the
//      LLM knows; the server can only verify direction.

import { prisma } from '@/lib/db';
import { getBrokerAccount, getLatestPrice } from '@/lib/alpaca';
import { parseOccSymbol, getOptionSnapshot } from '@/lib/alpaca-options';

export type OptionSetup = 'covered_call' | 'cash_secured_put';

export type OptionStrategyRules = {
  optionsAllowed?: boolean;
  optionStrategies?: OptionSetup[];
  maxOptionsBookPct?: number; // default 10
  minDTE?: number;            // default 30
  maxDTE?: number;            // default 60
  maxDeltaAbs?: number;       // default 0.30
};

export type PlaceOptionValidation =
  | { ok: true; parsed: ReturnType<typeof parseOccSymbol>; currentUnderlyingPrice: number; premiumPerContractCents: bigint }
  | { ok: false; reason: string };

const DEFAULTS = {
  maxOptionsBookPct: 10,
  minDTE: 30,
  maxDTE: 60,
  maxDeltaAbs: 0.3,
};

// Returns a validation result suitable for the place_option_trade tool.
// On success, also returns the parsed OCC components and the bid mid-point
// (what we'll use as the default limit price) so the caller can persist it.
export async function validateOptionTrade(args: {
  userId: string;
  optionSymbol: string;
  setup: OptionSetup;
  qty: number;
  limitPrice?: number;
}): Promise<PlaceOptionValidation> {
  const { userId, optionSymbol, setup, qty } = args;

  if (qty <= 0 || !Number.isFinite(qty) || !Number.isInteger(qty)) {
    return { ok: false, reason: 'qty must be a positive integer (contracts)' };
  }
  if (setup !== 'covered_call' && setup !== 'cash_secured_put') {
    return { ok: false, reason: `setup must be covered_call or cash_secured_put — got ${setup}` };
  }

  const parsed = parseOccSymbol(optionSymbol);
  if (!parsed) {
    return { ok: false, reason: `optionSymbol "${optionSymbol}" is not a valid OCC-format contract` };
  }

  // Setup vs. contract type must agree.
  if (setup === 'covered_call' && parsed.type !== 'call') {
    return { ok: false, reason: 'covered_call requires a call contract' };
  }
  if (setup === 'cash_secured_put' && parsed.type !== 'put') {
    return { ok: false, reason: 'cash_secured_put requires a put contract' };
  }

  const [account, strategy, broker] = await Promise.all([
    prisma.account.findUnique({ where: { userId } }),
    prisma.strategy.findFirst({ where: { userId, isActive: true } }),
    getBrokerAccount(),
  ]);

  if (!account?.optionsEnabled) {
    return { ok: false, reason: 'options trading disabled for this account — enable under Settings first' };
  }

  const rules = (strategy?.rules ?? {}) as OptionStrategyRules;
  if (!rules.optionsAllowed) {
    return { ok: false, reason: `active strategy "${strategy?.name ?? 'none'}" does not allow options` };
  }
  if (!rules.optionStrategies?.includes(setup)) {
    return {
      ok: false,
      reason: `active strategy "${strategy?.name ?? 'none'}" does not allow the ${setup} setup`,
    };
  }

  const minDTE = rules.minDTE ?? DEFAULTS.minDTE;
  const maxDTE = rules.maxDTE ?? DEFAULTS.maxDTE;
  const maxDeltaAbs = rules.maxDeltaAbs ?? DEFAULTS.maxDeltaAbs;
  const maxBookPct = rules.maxOptionsBookPct ?? DEFAULTS.maxOptionsBookPct;

  // DTE bounds.
  const now = Date.now();
  const expMs = new Date(parsed.expiration + 'T21:00:00Z').getTime(); // ~close of trading day
  const dte = (expMs - now) / 86_400_000;
  if (dte < minDTE) {
    return { ok: false, reason: `expiration is only ${Math.floor(dte)} days out; minimum allowed is ${minDTE} (theta-decay zone too aggressive)` };
  }
  if (dte > maxDTE) {
    return { ok: false, reason: `expiration is ${Math.floor(dte)} days out; maximum allowed is ${maxDTE} (locking up collateral too long)` };
  }

  // Strike direction sanity + fetch snapshot for greeks + price.
  const [underlyingPrice, snapshot] = await Promise.all([
    getLatestPrice(parsed.underlying).catch(() => null),
    getOptionSnapshot(optionSymbol).catch(() => null),
  ]);
  if (underlyingPrice == null || underlyingPrice <= 0) {
    return { ok: false, reason: `could not fetch current price for underlying ${parsed.underlying}` };
  }
  if (setup === 'covered_call' && parsed.strike < underlyingPrice) {
    return {
      ok: false,
      reason: `covered call strike $${parsed.strike} is BELOW current price $${underlyingPrice.toFixed(2)} — you\'d be selling shares at a loss relative to market. Pick a strike at or above current price, and preferably at or above your fair-value estimate.`,
    };
  }
  if (setup === 'cash_secured_put' && parsed.strike > underlyingPrice) {
    return {
      ok: false,
      reason: `cash-secured put strike $${parsed.strike} is ABOVE current price $${underlyingPrice.toFixed(2)} — you\'d be agreeing to overpay on assignment. Pick a strike at or below current price, preferably at or below your desired buy-target.`,
    };
  }

  // Delta ceiling (best-effort — Alpaca may not populate greeks for every
  // contract). Enforced only when we got a number; otherwise we trust the
  // prompt guardrail.
  const delta = snapshot?.greeks?.delta;
  if (delta != null && Math.abs(delta) > maxDeltaAbs) {
    return {
      ok: false,
      reason: `contract |delta|=${Math.abs(delta).toFixed(2)} exceeds strategy max of ${maxDeltaAbs}. Pick a further-OTM strike (lower probability of assignment).`,
    };
  }

  // Premium estimate — use bid for sell-to-open (we\'re the seller, we get
  // the bid in a market fill; use midpoint as a reasonable limit price).
  const bid = snapshot?.latestQuote?.bidPrice ?? 0;
  const ask = snapshot?.latestQuote?.askPrice ?? 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid > 0 ? bid : ask;
  if (mid <= 0) {
    return {
      ok: false,
      reason: `no bid/ask available for ${optionSymbol} — cannot safely write this contract without a quote`,
    };
  }
  // Option premium is quoted per-share; each contract covers 100 shares.
  const premiumPerContractCents = BigInt(Math.round(mid * 100 * 100));
  const totalCreditCents = premiumPerContractCents * BigInt(qty);

  // Setup-specific collateral checks.
  if (setup === 'covered_call') {
    const position = await prisma.position.findUnique({
      where: { userId_symbol: { userId, symbol: parsed.underlying } },
    });
    const requiredShares = qty * 100;
    if (!position || position.qty < requiredShares) {
      return {
        ok: false,
        reason: `covered call needs ${requiredShares} shares of ${parsed.underlying}; you hold ${position?.qty ?? 0}. Covered calls are never naked under AgBro.`,
      };
    }
    // Also make sure we're not shorting more calls than we have remaining
    // share coverage (existing open CCs on the same underlying).
    const existingCCContracts = await prisma.optionPosition.aggregate({
      where: { userId, underlyingSymbol: parsed.underlying, setup: 'covered_call', status: 'open' },
      _sum: { quantity: true },
    });
    const alreadyCoveredShares = (existingCCContracts._sum.quantity ?? 0) * 100;
    if (alreadyCoveredShares + requiredShares > position.qty) {
      return {
        ok: false,
        reason: `you already have ${alreadyCoveredShares} shares of ${parsed.underlying} committed to open covered calls; can\'t commit another ${requiredShares}`,
      };
    }
  } else {
    // CSP: cash required = strike × 100 × qty.
    const cashNeededDollars = parsed.strike * 100 * qty;
    const cashAvailable = Number(broker.cashCents) / 100;
    if (cashAvailable < cashNeededDollars) {
      return {
        ok: false,
        reason: `cash-secured put needs $${cashNeededDollars.toFixed(0)} idle cash; account has $${cashAvailable.toFixed(0)}. CSPs are never naked under AgBro.`,
      };
    }
  }

  // Book cap — sum notional of all open option positions plus this new one,
  // compared against portfolio value.
  const openNotional = await sumOpenOptionNotionalCents(userId);
  const newNotionalCents = BigInt(Math.round(parsed.strike * 100 * qty * 100));
  const portfolioValueCents = Number(broker.portfolioValueCents);
  if (portfolioValueCents > 0) {
    const pct =
      (Number(openNotional + newNotionalCents) / portfolioValueCents) * 100;
    if (pct > maxBookPct) {
      return {
        ok: false,
        reason: `this contract would push your options book to ${pct.toFixed(1)}% of portfolio, above strategy cap of ${maxBookPct}%`,
      };
    }
  }

  return {
    ok: true,
    parsed,
    currentUnderlyingPrice: underlyingPrice,
    premiumPerContractCents,
  };
}

// Sum notional (strike × 100 × qty) of all open short-option positions for
// the user, in cents. Used by the book-cap check.
async function sumOpenOptionNotionalCents(userId: string): Promise<bigint> {
  const rows = await prisma.optionPosition.findMany({
    where: { userId, status: 'open' },
    select: { strikeCents: true, quantity: true },
  });
  let total = BigInt(0);
  for (const r of rows) {
    total += r.strikeCents * BigInt(100) * BigInt(r.quantity);
  }
  return total;
}
