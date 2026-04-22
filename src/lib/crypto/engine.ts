// Crypto automation engine — deterministic, rule-based. No LLM involvement
// anywhere in this file. The user's CryptoConfig is the full input:
// allowlist, target allocations, DCA cadence + amount. The engine's job is
// to decide, on each cron tick, whether a DCA is due and if so to submit
// the orders.
//
// v1: DCA only. Rebalancing (sell overweights, buy underweights) is
// intentionally deferred — it adds realized-gain complexity and isn't
// strictly necessary for accumulating a long-term crypto allocation.

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { getBrokerAccount } from '@/lib/alpaca';
import { placeCryptoOrder, getCryptoLatestPrice } from '@/lib/alpaca-crypto';

export type CycleResult = {
  userId: string;
  ranDca: boolean;
  dcaTrades: Array<{ symbol: string; notionalUsd: number; orderId: string }>;
  skippedReason?: string;
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

export async function runCryptoCycleForUser(userId: string): Promise<CycleResult> {
  const [account, config] = await Promise.all([
    prisma.account.findUnique({ where: { userId } }),
    prisma.cryptoConfig.findUnique({ where: { userId } }),
  ]);

  if (!account) {
    return { userId, ranDca: false, dcaTrades: [], skippedReason: 'no account' };
  }
  if (!account.cryptoEnabled) {
    return { userId, ranDca: false, dcaTrades: [], skippedReason: 'crypto disabled' };
  }
  if (account.isPaused || account.isStopped) {
    return { userId, ranDca: false, dcaTrades: [], skippedReason: 'account paused or stopped' };
  }
  if (!config) {
    return { userId, ranDca: false, dcaTrades: [], skippedReason: 'no config' };
  }
  if (config.allowlist.length === 0) {
    return { userId, ranDca: false, dcaTrades: [], skippedReason: 'empty allowlist' };
  }
  if (config.dcaAmountCents <= BigInt(0)) {
    return { userId, ranDca: false, dcaTrades: [], skippedReason: 'dca amount is 0' };
  }

  // Cadence check.
  const now = new Date();
  if (config.lastDcaAt) {
    const daysSince = (now.getTime() - config.lastDcaAt.getTime()) / 86_400_000;
    if (daysSince < config.dcaCadenceDays) {
      return {
        userId,
        ranDca: false,
        dcaTrades: [],
        skippedReason: `only ${daysSince.toFixed(1)}d since last DCA; cadence is ${config.dcaCadenceDays}d`,
      };
    }
  }

  // Resolve targets. Intersection with allowlist; drop anything not allowed.
  const targets = parseTargets(config.targetAllocations);
  const validTargets: Targets = {};
  for (const sym of config.allowlist) {
    if (targets[sym] != null) validTargets[sym] = targets[sym];
  }
  const totalWeight = Object.values(validTargets).reduce((s, v) => s + v, 0);
  if (totalWeight <= 0) {
    return { userId, ranDca: false, dcaTrades: [], skippedReason: 'no valid target allocations' };
  }

  // Buying power check — don't DCA if the account is dry. Crypto uses the
  // same cash pool as equities on Alpaca paper, so sumbmitting into an
  // underfunded account just produces broker rejections.
  const broker = await getBrokerAccount().catch(() => null);
  const cashUsd = broker ? Number(broker.cashCents) / 100 : 0;
  const dcaUsd = Number(config.dcaAmountCents) / 100;
  if (cashUsd < dcaUsd) {
    return {
      userId,
      ranDca: false,
      dcaTrades: [],
      skippedReason: `not enough cash ($${cashUsd.toFixed(0)}) for DCA ($${dcaUsd.toFixed(0)})`,
    };
  }

  // Split the DCA amount across targets proportionally.
  const orders: CycleResult['dcaTrades'] = [];
  for (const [symbol, weight] of Object.entries(validTargets)) {
    const notionalUsd = (dcaUsd * weight) / totalWeight;
    // Alpaca crypto minimum order is $1 on paper; skip dust.
    if (notionalUsd < 1) continue;
    try {
      const order = await placeCryptoOrder({
        symbol,
        side: 'buy',
        notionalUsd,
        timeInForce: 'gtc',
      });
      // Best-effort price capture for the trade row.
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
          // Crypto trades skip the bull/bear/thesis triad — they're
          // rule-based, not LLM-driven. A short rule-summary lives in
          // thesis so audit trails read cleanly.
          bullCase: null,
          bearCase: null,
          thesis: `DCA: ${weight.toFixed(1)}% of $${dcaUsd.toFixed(0)} weekly crypto buy (rule-based)`,
          confidence: null,
        },
      });
      orders.push({ symbol, notionalUsd, orderId: order.id });
      log.info('crypto.dca_submitted', {
        userId,
        symbol,
        notionalUsd: notionalUsd.toFixed(2),
        orderId: order.id,
      });
    } catch (err) {
      log.error('crypto.dca_order_failed', err, { userId, symbol });
      // Continue with other symbols — one failed leg shouldn't block the
      // rest of the DCA split.
    }
  }

  // Only bump lastDcaAt if at least one order went through; otherwise the
  // next cron tick retries.
  if (orders.length > 0) {
    await prisma.cryptoConfig.update({
      where: { userId },
      data: { lastDcaAt: now },
    });
  }

  return { userId, ranDca: orders.length > 0, dcaTrades: orders };
}

// For the cron loop: run for every user who has cryptoEnabled + a config.
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
    } catch (err) {
      log.error('crypto.cycle_exception', err, { userId: u.id });
      out.push({
        userId: u.id,
        ranDca: false,
        dcaTrades: [],
        skippedReason: (err as Error).message,
      });
    }
  }
  return out;
}
