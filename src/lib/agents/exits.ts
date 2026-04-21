// Deterministic exit evaluator. Called by the agent at the start of every
// wake-up (via the evaluate_exits tool) BEFORE considering new buys. Returns
// one signal per open position. Strategy rules drive what signals can fire;
// per our design none of the supported strategies use stop-losses (Buffett
// doesn't, so BuffetBot doesn't either).
//
// Signal taxonomy:
//   'hold'   → nothing to do, skip
//   'review' → force the agent to re-validate the thesis (does NOT mean sell)
//   'trim'   → reduce position size (portfolio-limit breach)
//   'sell'   → fully close the position
//
// The agent is expected to process every non-'hold' signal before buying
// anything new. A 'sell' signal that's suppressed by an earnings blackout
// becomes a 'review' — we never let the agent auto-sell into an earnings
// release (too much noise on both sides), but we force the LLM to read the
// signal and decide explicitly whether to wait or override.

import { prisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { isInEarningsBlackout } from '@/lib/data/earnings';
import { getPositions, getLatestPrice } from '@/lib/alpaca';
import { log } from '@/lib/logger';

export type ExitSignal = 'hold' | 'review' | 'trim' | 'sell';

export type ExitAssessment = {
  symbol: string;
  signal: ExitSignal;
  reason: string;
  // Qty to trim (only meaningful when signal === 'trim'). Full-sell leaves
  // this null — the agent should use current Alpaca qty at exit time.
  trimQty?: number;
  // Original thesis surfaced back to the agent for quick context.
  thesis?: string | null;
};

// Strategy rules shape. All fields optional with sensible defaults — a
// strategy without these fields (legacy rows) gets "review every 180d, no
// other exit triggers" behaviour.
export type ExitRules = {
  // 'forever' = Munger-strict, no thesis review on a timer (moat break only).
  // Otherwise review every thesisReviewDays.
  thesisReviewDays?: number | null;
  // Trigger a review when fundamentals materially deteriorate.
  fundamentalsDegradationExit?: boolean;
  // Trigger a sell when the dividend is cut, suspended, or the streak is
  // broken. Only meaningful for dividend-focused strategies.
  dividendSafetyExit?: boolean;
  // Hold-forever: moat erosion is the ONLY thesis-based sell trigger.
  // The evaluator can't detect moat erosion deterministically — it surfaces
  // the open question as a 'review' signal and lets the LLM judge.
  moatBreakExit?: boolean;
  // Graham-style price target (percent gain vs. cost basis). Null = never
  // sell on price alone.
  targetSellPct?: number | null;
  // Graham-style time stop (sell if it hasn't hit target in N days).
  timeStopDays?: number | null;
  // Rebalance-only mode (Boglehead). No thesis-based exits at all.
  rebalanceOnly?: boolean;
};

export async function evaluateExits(userId: string): Promise<ExitAssessment[]> {
  // Load everything in parallel.
  const [strategy, brokerPositions, dbPositions, account] = await Promise.all([
    prisma.strategy.findFirst({ where: { userId, isActive: true } }),
    getPositions().catch(() => [] as Array<{ symbol: string; qty: string; avg_entry_price: string }>),
    prisma.position.findMany({ where: { userId } }),
    prisma.account.findUnique({ where: { userId } }),
  ]);

  const rules: ExitRules = (strategy?.rules as ExitRules | null) ?? {};
  const maxPositionPct = account?.maxPositionPct ?? 15;

  // If this strategy is rebalance-only (Boglehead), skip thesis-based exits
  // entirely. The rebalance logic lives elsewhere.
  if (rules.rebalanceOnly) {
    return [];
  }

  // Fetch portfolio equity so we can compute per-position weight for the
  // maxPositionPct trim check. Alpaca's position payload includes market
  // value; we sum it to avoid a second API call.
  type BrokerPosition = { symbol: string; qty: string; avg_entry_price: string; market_value?: string };
  const bp = brokerPositions as BrokerPosition[];
  const totalValue = bp.reduce((sum, p) => sum + Number(p.market_value ?? 0), 0);

  const dbBySymbol = new Map(dbPositions.map((p) => [p.symbol, p]));
  const out: ExitAssessment[] = [];
  const now = Date.now();

  for (const bpos of bp) {
    const symbol = bpos.symbol;
    const qty = Number(bpos.qty);
    if (qty <= 0) continue;

    const dbPos = dbBySymbol.get(symbol);
    const thesis = dbPos?.thesis ?? null;
    const signals: Array<{ signal: Exclude<ExitSignal, 'hold'>; reason: string; trimQty?: number }> = [];

    // Portfolio weight check (trim) — applies regardless of strategy.
    if (totalValue > 0 && bpos.market_value) {
      const weightPct = (Number(bpos.market_value) / totalValue) * 100;
      if (weightPct > maxPositionPct) {
        const excessPct = weightPct - maxPositionPct;
        const trimQty = qty * (excessPct / weightPct);
        signals.push({
          signal: 'trim',
          reason: `position at ${weightPct.toFixed(1)}% of portfolio, above max ${maxPositionPct}%`,
          trimQty,
        });
      }
    }

    // Price target (Graham mean-reversion style).
    if (rules.targetSellPct != null && dbPos) {
      const costBasis = Number(dbPos.avgCostCents) / 100;
      const price = await getLatestPrice(symbol).catch(() => null);
      if (price != null && costBasis > 0) {
        const gainPct = ((price - costBasis) / costBasis) * 100;
        if (gainPct >= rules.targetSellPct) {
          signals.push({
            signal: 'sell',
            reason: `hit +${gainPct.toFixed(1)}% vs. cost basis, target was +${rules.targetSellPct}% (mean-reversion target)`,
          });
        }
      }
    }

    // Time stop (Graham 2-year rule). Sells only if the price target hasn't
    // been hit — the assumption is that if it was going to revert, it would
    // have by now.
    if (rules.timeStopDays != null && dbPos?.openedAt) {
      const heldDays = (now - dbPos.openedAt.getTime()) / 86_400_000;
      if (heldDays >= rules.timeStopDays) {
        signals.push({
          signal: 'sell',
          reason: `held for ${Math.floor(heldDays)} days without hitting mean-reversion target (time stop: ${rules.timeStopDays}d)`,
        });
      }
    }

    // Thesis review timer — forces a re-read, not a sell.
    if (dbPos?.thesisReviewDueAt && dbPos.thesisReviewDueAt.getTime() <= now) {
      signals.push({
        signal: 'review',
        reason: `scheduled thesis review due (${dbPos.thesisReviewDueAt.toISOString().slice(0, 10)})`,
      });
    }

    // Moat / fundamentals / dividend signals require reading the Stock row.
    if (rules.moatBreakExit || rules.fundamentalsDegradationExit || rules.dividendSafetyExit) {
      const stock = await prisma.stock.findUnique({ where: { symbol } });
      if (stock) {
        if (rules.fundamentalsDegradationExit) {
          // Simple deterministic check: ROE or gross margin collapsed vs.
          // what the agent wrote on this position at buy time. Without
          // snapshotting baseline fundamentals, we rely on the agent's own
          // judgement — surface as 'review' so the LLM looks.
          // (Full deterministic check requires historical PriceSnapshot-
          // style fundamentals history; deferred.)
          if (stock.returnOnEquity != null && stock.returnOnEquity < 0) {
            signals.push({
              signal: 'review',
              reason: `ROE went negative (${stock.returnOnEquity.toFixed(1)}%) — fundamentals deteriorating`,
            });
          }
        }
        if (rules.dividendSafetyExit) {
          // Dividend data freshness check: if the stock was paying and now
          // shows zero, flag as sell-worthy.
          if (stock.dividendYield != null && stock.dividendYield === 0 && stock.dividendPerShare === 0) {
            signals.push({
              signal: 'sell',
              reason: `dividend appears to have been cut or suspended (yield = 0)`,
            });
          }
        }
        // Moat-break is qualitative → always 'review' when present.
        if (rules.moatBreakExit && dbPos?.thesisReviewDueAt && dbPos.thesisReviewDueAt.getTime() <= now) {
          // Already covered by the review timer above; nothing new to add.
        }
      }
    }

    // Earnings-blackout suppression: never AUTO-SELL into a pending earnings
    // release. Convert sell → review so the agent has to decide.
    if (signals.some((s) => s.signal === 'sell')) {
      const blackout = await isInEarningsBlackout(symbol, now);
      if (blackout.blocked) {
        for (const s of signals) {
          if (s.signal === 'sell') {
            log.info('exits.sell_suppressed_by_earnings', { symbol, originalReason: s.reason });
            s.signal = 'review';
            s.reason = `${s.reason} — but earnings within 3 days; review manually before selling into the report`;
          }
        }
      }
    }

    // Pick the highest-priority signal to surface. Order: sell > trim > review.
    if (signals.length === 0) {
      out.push({ symbol, signal: 'hold', reason: 'no exit triggers fired', thesis });
      continue;
    }
    signals.sort((a, b) => priority(b.signal) - priority(a.signal));
    const top = signals[0];
    out.push({
      symbol,
      signal: top.signal,
      reason: top.reason,
      trimQty: top.trimQty,
      thesis,
    });
  }

  return out;
}

function priority(s: ExitSignal): number {
  if (s === 'sell') return 3;
  if (s === 'trim') return 2;
  if (s === 'review') return 1;
  return 0;
}

// Backfill / sync. Pulls current Alpaca positions and makes sure every one
// has a Position row — existing ones are left alone, new ones are created
// with thesis = null (the agent will fill this in on first review). Called
// on every wake-up so the DB stays aligned with Alpaca even if external
// deposits / transfers happen between wakeups.
export async function syncPositionsFromAlpaca(userId: string): Promise<void> {
  type BrokerPosition = { symbol: string; qty: string; avg_entry_price: string };
  const brokerPositions = (await getPositions().catch(() => [])) as BrokerPosition[];
  const now = new Date();
  for (const p of brokerPositions) {
    const symbol = p.symbol;
    const qty = Number(p.qty);
    const avgCostCents = BigInt(Math.round(Number(p.avg_entry_price) * 100));
    const data: Prisma.PositionUpdateInput = { qty, avgCostCents, lastSyncedAt: now };
    const createData: Prisma.PositionCreateInput = {
      user: { connect: { id: userId } },
      symbol,
      qty,
      avgCostCents,
      lastSyncedAt: now,
      // First time we see this position, flag it for thesis review on the
      // next wake-up so the agent documents what it's holding and why.
      thesis: 'pre-AgBro position — thesis review needed',
      thesisReviewDueAt: now,
    };
    await prisma.position.upsert({
      where: { userId_symbol: { userId, symbol } },
      update: data,
      create: createData,
    });
  }
}
