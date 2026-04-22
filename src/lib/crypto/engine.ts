// Crypto automation engine — deterministic, rule-based. No LLM involvement
// anywhere in this file. CryptoConfig is the full input: allowlist, target
// allocations, DCA cadence + amount, rebalance band + cadence. The engine
// orchestrates two operations on every tick:
//
//   1. DCA (dollar-cost average): on cadence, spend dcaAmountCents split
//      across target allocations to accumulate more exposure.
//
//   2. Rebalance: when any holding has drifted > rebalanceBandPct from its
//      target weight AND rebalanceCadenceDays have elapsed, sell
//      overweights and buy underweights to restore target ratios. Triggered
//      by price action, not the schedule — drift-based.
//
// Both operations self-rate-limit via timestamps stored on CryptoConfig.
// Hourly cron ticks are cheap when nothing is due.

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { getBrokerAccount } from '@/lib/alpaca';
import {
  placeCryptoOrder,
  getCryptoLatestPrice,
  getCryptoPositions,
  type CryptoPosition,
} from '@/lib/alpaca-crypto';
import type { Account, CryptoConfig } from '@prisma/client';

export type DcaTrade = { symbol: string; notionalUsd: number; orderId: string };
export type RebalanceTrade = {
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  orderId: string;
};

export type CycleResult = {
  userId: string;
  dca: {
    ran: boolean;
    trades: DcaTrade[];
    skippedReason?: string;
  };
  rebalance: {
    ran: boolean;
    trades: RebalanceTrade[];
    skippedReason?: string;
    maxDriftPct?: number;
  };
};

type Targets = Record<string, number>; // { "BTC/USD": 60, "ETH/USD": 40 }

function parseTargets(raw: unknown): Targets {
  if (!raw || typeof raw !== 'object') return {};
  const out: Targets = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

// Resolve target weights intersected with the allowlist. Returns the raw
// weights (not normalised) + the sum so callers can normalise if needed.
function resolveTargets(config: CryptoConfig): { validTargets: Targets; totalWeight: number } {
  const raw = parseTargets(config.targetAllocations);
  const validTargets: Targets = {};
  for (const sym of config.allowlist) {
    if (raw[sym] != null) validTargets[sym] = raw[sym];
  }
  const totalWeight = Object.values(validTargets).reduce((s, v) => s + v, 0);
  return { validTargets, totalWeight };
}

// Defensive rail: compute how many MORE dollars of crypto we're allowed to
// buy before hitting Account.maxCryptoAllocationPct. Returns 0 if we're at
// or over the cap. SELLS are always allowed regardless — they reduce the
// ratio, which is what the cap is trying to enforce.
async function getCryptoBuyHeadroomUsd(account: Account): Promise<number> {
  const broker = await getBrokerAccount().catch(() => null);
  if (!broker) return 0;
  const portfolioValueUsd = Number(broker.portfolioValueCents) / 100;
  if (portfolioValueUsd <= 0) return 0;

  const positions = await getCryptoPositions().catch(() => [] as CryptoPosition[]);
  const cryptoBookUsd = positions.reduce(
    (s, p) => s + Number(p.marketValueCents) / 100,
    0
  );
  const maxCryptoUsd = (portfolioValueUsd * account.maxCryptoAllocationPct) / 100;
  return Math.max(0, maxCryptoUsd - cryptoBookUsd);
}

// ─── DCA ─────────────────────────────────────────────────────────────────

async function tryDca(
  userId: string,
  account: Account,
  config: CryptoConfig
): Promise<CycleResult['dca']> {
  if (config.dcaAmountCents <= BigInt(0)) {
    return { ran: false, trades: [], skippedReason: 'dca amount is 0' };
  }

  const now = new Date();
  if (config.lastDcaAt) {
    const daysSince = (now.getTime() - config.lastDcaAt.getTime()) / 86_400_000;
    if (daysSince < config.dcaCadenceDays) {
      return {
        ran: false,
        trades: [],
        skippedReason: `only ${daysSince.toFixed(1)}d since last DCA; cadence is ${config.dcaCadenceDays}d`,
      };
    }
  }

  const { validTargets, totalWeight } = resolveTargets(config);
  if (totalWeight <= 0) {
    return { ran: false, trades: [], skippedReason: 'no valid target allocations' };
  }

  // Buying power check — Alpaca paper shares one cash pool across equities
  // and crypto, so submitting into a dry account just produces rejections.
  const broker = await getBrokerAccount().catch(() => null);
  const cashUsd = broker ? Number(broker.cashCents) / 100 : 0;
  const requestedDcaUsd = Number(config.dcaAmountCents) / 100;
  if (cashUsd < requestedDcaUsd) {
    return {
      ran: false,
      trades: [],
      skippedReason: `not enough cash ($${cashUsd.toFixed(0)}) for DCA ($${requestedDcaUsd.toFixed(0)})`,
    };
  }

  // Total-portfolio crypto cap. If the crypto book is already at or above
  // maxCryptoAllocationPct, skip DCA entirely — we're not in the business
  // of compounding into a concentration risk. If there's some headroom but
  // less than the full DCA, scale the DCA down to fit. Matches how a
  // disciplined allocator would treat a "satellite" position.
  const headroomUsd = await getCryptoBuyHeadroomUsd(account);
  if (headroomUsd < 1) {
    return {
      ran: false,
      trades: [],
      skippedReason: `crypto exposure at or above cap (${account.maxCryptoAllocationPct}% of portfolio); no headroom for new buys`,
    };
  }
  const dcaUsd = Math.min(requestedDcaUsd, headroomUsd);
  if (dcaUsd < requestedDcaUsd) {
    log.info('crypto.dca_scaled_by_cap', {
      userId,
      requested: requestedDcaUsd.toFixed(2),
      scaled: dcaUsd.toFixed(2),
      headroom: headroomUsd.toFixed(2),
      cap: account.maxCryptoAllocationPct,
    });
  }

  const trades: DcaTrade[] = [];
  for (const [symbol, weight] of Object.entries(validTargets)) {
    const notionalUsd = (dcaUsd * weight) / totalWeight;
    if (notionalUsd < 1) continue; // Alpaca crypto minimum is $1

    try {
      const order = await placeCryptoOrder({
        symbol,
        side: 'buy',
        notionalUsd,
        timeInForce: 'gtc',
      });
      const priceAtOrder = await getCryptoLatestPrice(symbol).catch(() => null);
      const qty = priceAtOrder ? notionalUsd / priceAtOrder : 0;
      await prisma.trade.create({
        data: {
          userId,
          alpacaOrderId: order.id,
          symbol,
          side: 'buy',
          qty,
          status: 'submitted',
          assetClass: 'crypto',
          fillPriceCents: priceAtOrder
            ? BigInt(Math.round(priceAtOrder * 100))
            : null,
          bullCase: null,
          bearCase: null,
          thesis: `DCA: ${weight.toFixed(1)}% of $${dcaUsd.toFixed(0)} crypto buy (rule-based)`,
          confidence: null,
        },
      });
      trades.push({ symbol, notionalUsd, orderId: order.id });
      log.info('crypto.dca_submitted', {
        userId,
        symbol,
        notionalUsd: notionalUsd.toFixed(2),
        orderId: order.id,
      });
    } catch (err) {
      log.error('crypto.dca_order_failed', err, { userId, symbol });
    }
  }

  // Only bump lastDcaAt when at least one leg went through; otherwise the
  // next tick retries.
  if (trades.length > 0) {
    await prisma.cryptoConfig.update({
      where: { userId },
      data: { lastDcaAt: new Date() },
    });
  }
  return {
    ran: trades.length > 0,
    trades,
    skippedReason: trades.length === 0 ? 'all legs failed at broker' : undefined,
  };
}

// ─── Rebalance ───────────────────────────────────────────────────────────

async function tryRebalance(
  userId: string,
  account: Account,
  config: CryptoConfig
): Promise<CycleResult['rebalance']> {
  // Cadence floor. Rebalancing is a drift-driven action; the cadence is the
  // soft floor that prevents thrash if targets are near band boundaries.
  const now = new Date();
  if (config.lastRebalancedAt) {
    const daysSince = (now.getTime() - config.lastRebalancedAt.getTime()) / 86_400_000;
    if (daysSince < config.rebalanceCadenceDays) {
      return {
        ran: false,
        trades: [],
        skippedReason: `only ${daysSince.toFixed(0)}d since last rebalance; cadence is ${config.rebalanceCadenceDays}d`,
      };
    }
  }

  const { validTargets, totalWeight } = resolveTargets(config);
  // Even if there are no targets, positions outside the allowlist should be
  // flagged for sell — use the allowlist as the "inside the book" set.

  let cryptoPositions: CryptoPosition[];
  try {
    cryptoPositions = await getCryptoPositions();
  } catch (err) {
    log.error('crypto.rebalance_positions_failed', err, { userId });
    return {
      ran: false,
      trades: [],
      skippedReason: `failed to fetch positions: ${(err as Error).message}`,
    };
  }

  const bookValueUsd = cryptoPositions.reduce(
    (s, p) => s + Number(p.marketValueCents) / 100,
    0
  );
  if (bookValueUsd <= 0) {
    return { ran: false, trades: [], skippedReason: 'no crypto book to rebalance' };
  }

  // Compute desired $ per symbol (normalised to 100% of book value) +
  // actual $ per symbol. Symbols in the allowlist with no position contribute
  // actual=0. Symbols in positions but not in the allowlist contribute
  // desired=0 → full sell.
  const desiredBySymbol = new Map<string, number>();
  if (totalWeight > 0) {
    for (const [sym, weight] of Object.entries(validTargets)) {
      desiredBySymbol.set(sym, (weight / totalWeight) * bookValueUsd);
    }
  }
  const actualBySymbol = new Map<string, number>();
  for (const p of cryptoPositions) {
    actualBySymbol.set(p.symbol, Number(p.marketValueCents) / 100);
  }

  const allSymbols = new Set<string>([
    ...desiredBySymbol.keys(),
    ...actualBySymbol.keys(),
  ]);

  type Drift = { symbol: string; actual: number; desired: number; diffUsd: number; diffPct: number };
  const drifts: Drift[] = [];
  let maxDriftPct = 0;
  for (const sym of allSymbols) {
    const actual = actualBySymbol.get(sym) ?? 0;
    const desired = desiredBySymbol.get(sym) ?? 0;
    const diffUsd = actual - desired; // positive = overweight → sell
    const diffPct = (Math.abs(diffUsd) / bookValueUsd) * 100;
    drifts.push({ symbol: sym, actual, desired, diffUsd, diffPct });
    if (diffPct > maxDriftPct) maxDriftPct = diffPct;
  }

  if (maxDriftPct < config.rebalanceBandPct) {
    return {
      ran: false,
      trades: [],
      skippedReason: `max drift ${maxDriftPct.toFixed(1)}% below band ${config.rebalanceBandPct}%`,
      maxDriftPct,
    };
  }

  log.info('crypto.rebalance_triggered', {
    userId,
    maxDriftPct: maxDriftPct.toFixed(2),
    bookValueUsd: bookValueUsd.toFixed(2),
    drifts: drifts.map((d) => ({ sym: d.symbol, diff: d.diffUsd.toFixed(2) })),
  });

  // Execute sells first to free up cash for the buys. Keeps sequencing
  // predictable and avoids buy rejections for insufficient funds.
  const trades: RebalanceTrade[] = [];
  const sells = drifts.filter((d) => d.diffUsd > 1);
  const buys = drifts.filter((d) => d.diffUsd < -1);

  for (const sell of sells) {
    const notionalUsd = sell.diffUsd;
    try {
      const order = await placeCryptoOrder({
        symbol: sell.symbol,
        side: 'sell',
        notionalUsd,
        timeInForce: 'gtc',
      });
      const priceAtOrder = await getCryptoLatestPrice(sell.symbol).catch(() => null);
      const qty = priceAtOrder ? notionalUsd / priceAtOrder : 0;
      await prisma.trade.create({
        data: {
          userId,
          alpacaOrderId: order.id,
          symbol: sell.symbol,
          side: 'sell',
          qty,
          status: 'submitted',
          assetClass: 'crypto',
          fillPriceCents: priceAtOrder
            ? BigInt(Math.round(priceAtOrder * 100))
            : null,
          bullCase: null,
          bearCase: null,
          thesis: `Rebalance: ${sell.symbol} was ${(sell.actual / bookValueUsd * 100).toFixed(1)}% of book vs target ${(sell.desired / bookValueUsd * 100).toFixed(1)}%; selling $${notionalUsd.toFixed(0)} to restore (rule-based)`,
          confidence: null,
        },
      });
      trades.push({ symbol: sell.symbol, side: 'sell', notionalUsd, orderId: order.id });
      log.info('crypto.rebalance_sell_submitted', {
        userId,
        symbol: sell.symbol,
        notionalUsd: notionalUsd.toFixed(2),
        orderId: order.id,
      });
    } catch (err) {
      log.error('crypto.rebalance_sell_failed', err, { userId, symbol: sell.symbol });
    }
  }

  // Apply the crypto cap to the BUY phase only. Sells already executed
  // above — they reduce exposure regardless. The cap is the maximum crypto
  // book size allowed given the user's current portfolio value; rebalance
  // buys must fit under it. If headroom is less than the sum of target
  // buys, scale each buy proportionally so the ratios between underweights
  // stay intact.
  const totalBuyUsd = buys.reduce((s, b) => s + -b.diffUsd, 0);
  let buyHeadroomUsd = totalBuyUsd;
  if (totalBuyUsd > 0) {
    const accountHeadroomUsd = await getCryptoBuyHeadroomUsd(account);
    if (accountHeadroomUsd < totalBuyUsd) {
      buyHeadroomUsd = accountHeadroomUsd;
      log.info('crypto.rebalance_buys_scaled_by_cap', {
        userId,
        totalWanted: totalBuyUsd.toFixed(2),
        headroom: accountHeadroomUsd.toFixed(2),
        cap: account.maxCryptoAllocationPct,
      });
    }
  }
  const scaleFactor = totalBuyUsd > 0 ? buyHeadroomUsd / totalBuyUsd : 0;

  for (const buy of buys) {
    // Apply cap-scaling. If scaleFactor is 0 or the scaled amount would be
    // dust, skip this leg.
    const notionalUsd = -buy.diffUsd * scaleFactor; // diffUsd is negative for underweight
    if (notionalUsd < 1) continue;
    try {
      const order = await placeCryptoOrder({
        symbol: buy.symbol,
        side: 'buy',
        notionalUsd,
        timeInForce: 'gtc',
      });
      const priceAtOrder = await getCryptoLatestPrice(buy.symbol).catch(() => null);
      const qty = priceAtOrder ? notionalUsd / priceAtOrder : 0;
      await prisma.trade.create({
        data: {
          userId,
          alpacaOrderId: order.id,
          symbol: buy.symbol,
          side: 'buy',
          qty,
          status: 'submitted',
          assetClass: 'crypto',
          fillPriceCents: priceAtOrder
            ? BigInt(Math.round(priceAtOrder * 100))
            : null,
          bullCase: null,
          bearCase: null,
          thesis: `Rebalance: ${buy.symbol} was ${(buy.actual / bookValueUsd * 100).toFixed(1)}% of book vs target ${(buy.desired / bookValueUsd * 100).toFixed(1)}%; buying $${notionalUsd.toFixed(0)} to restore (rule-based)`,
          confidence: null,
        },
      });
      trades.push({ symbol: buy.symbol, side: 'buy', notionalUsd, orderId: order.id });
      log.info('crypto.rebalance_buy_submitted', {
        userId,
        symbol: buy.symbol,
        notionalUsd: notionalUsd.toFixed(2),
        orderId: order.id,
      });
    } catch (err) {
      log.error('crypto.rebalance_buy_failed', err, { userId, symbol: buy.symbol });
    }
  }

  if (trades.length > 0) {
    await prisma.cryptoConfig.update({
      where: { userId },
      data: { lastRebalancedAt: new Date() },
    });
  }

  return {
    ran: trades.length > 0,
    trades,
    maxDriftPct,
    skippedReason: trades.length === 0 ? 'drift exceeded band but all legs failed at broker' : undefined,
  };
}

// ─── Orchestrator ────────────────────────────────────────────────────────

function earlySkip(userId: string, reason: string): CycleResult {
  return {
    userId,
    dca: { ran: false, trades: [], skippedReason: reason },
    rebalance: { ran: false, trades: [], skippedReason: reason },
  };
}

export async function runCryptoCycleForUser(userId: string): Promise<CycleResult> {
  const [account, config] = await Promise.all([
    prisma.account.findUnique({ where: { userId } }),
    prisma.cryptoConfig.findUnique({ where: { userId } }),
  ]);

  if (!account) return earlySkip(userId, 'no account');
  if (!account.cryptoEnabled) return earlySkip(userId, 'crypto disabled');
  if (account.isPaused || account.isStopped) {
    return earlySkip(userId, 'account paused or stopped');
  }
  if (!config) return earlySkip(userId, 'no config');
  if (config.allowlist.length === 0) return earlySkip(userId, 'empty allowlist');

  // DCA first, then rebalance. Order matters only mildly: DCA buys in target
  // ratios (doesn't introduce drift), rebalance corrects drift from price
  // action. Running DCA first means new contributions enter at the current
  // targets; then rebalance fixes whatever drift exists across the book.
  const dca = await tryDca(userId, account, config).catch((err) => {
    log.error('crypto.dca_exception', err, { userId });
    return {
      ran: false,
      trades: [] as DcaTrade[],
      skippedReason: (err as Error).message,
    };
  });
  // Refetch config so the lastDcaAt bump (if any) is visible to rebalance.
  const refreshedConfig = await prisma.cryptoConfig.findUnique({
    where: { userId },
  });
  const rebalance = refreshedConfig
    ? await tryRebalance(userId, account, refreshedConfig).catch((err) => {
        log.error('crypto.rebalance_exception', err, { userId });
        return {
          ran: false,
          trades: [] as RebalanceTrade[],
          skippedReason: (err as Error).message,
        };
      })
    : { ran: false, trades: [], skippedReason: 'config missing mid-cycle' };

  return { userId, dca, rebalance };
}

export async function runCryptoCycleAllUsers(): Promise<CycleResult[]> {
  const candidates = await prisma.user.findMany({
    where: {
      account: { cryptoEnabled: true, isStopped: false },
      cryptoConfig: { isNot: null },
    },
    select: { id: true },
  });
  const out: CycleResult[] = [];
  for (const u of candidates) {
    try {
      out.push(await runCryptoCycleForUser(u.id));
      // After each user's cycle runs, maybe record a daily book-value
      // snapshot for the performance chart. No-op if < 23h since the last
      // one. Isolated from the cycle's own success so a snapshot failure
      // never blocks trading.
      await maybeSnapshotCryptoBook(u.id).catch((err) => {
        log.error('crypto.snapshot_failed', err, { userId: u.id });
      });
    } catch (err) {
      log.error('crypto.cycle_exception', err, { userId: u.id });
      out.push(earlySkip(u.id, (err as Error).message));
    }
  }
  return out;
}

// Record a daily snapshot of the user's crypto book value. Rate-limited to
// once per 23h so hourly cron ticks don't over-write. The 23h (vs. 24h)
// slack prevents drift from exact tick timing.
export async function maybeSnapshotCryptoBook(userId: string): Promise<void> {
  const last = await prisma.cryptoBookSnapshot.findFirst({
    where: { userId },
    orderBy: { takenAt: 'desc' },
    select: { takenAt: true },
  });
  if (last) {
    const hoursSince = (Date.now() - last.takenAt.getTime()) / 3_600_000;
    if (hoursSince < 23) return;
  }
  const positions = await getCryptoPositions().catch(() => [] as CryptoPosition[]);
  const bookValueCents = BigInt(
    Math.round(
      positions.reduce((s, p) => s + Number(p.marketValueCents), 0)
    )
  );
  await prisma.cryptoBookSnapshot.create({
    data: { userId, bookValueCents },
  });
}
