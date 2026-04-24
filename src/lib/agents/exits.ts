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
import { isInEarningsBlackout } from '@/lib/data/earnings';
import { getPositions, getLatestPrice } from '@/lib/alpaca';
import { isHarvestSeason, MIN_HARVEST_LOSS_USD, MIN_HARVEST_HELD_DAYS } from '@/lib/data/tax';
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
  // Tax-loss-harvest flag. True when: (a) it's Q4, (b) the position is at
  // a meaningful unrealised loss, (c) it's been held long enough to dodge
  // a buy-side wash-sale, AND (d) the thesis is already flagged for review.
  // Advisory only — the primary signal tells the agent what to do; this is
  // context: "if you're going to sell, Dec 31 beats Jan 1 for taxes."
  // NEVER harvest a conviction position just for the write-off.
  taxHarvestCandidate?: boolean;
  unrealizedLossCents?: bigint | null;
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
  // Load everything in parallel. The orchestrator's syncPositions has already
  // reconciled the DB against the broker before this runs, so dbPositions is
  // aligned — we only need brokerPositions here for live market_value (used
  // by the portfolio-weight trim check, which Alpaca calculates for us).
  const [strategy, brokerPositions, dbPositions, account] = await Promise.all([
    prisma.strategy.findFirst({ where: { userId, isActive: true } }),
    getPositions().catch(() => [] as Array<{ symbol: string; qty: string; avg_entry_price: string }>),
    prisma.position.findMany({ where: { userId } }),
    prisma.account.findUnique({ where: { userId } }),
  ]);

  const rules: ExitRules = (strategy?.rules as ExitRules | null) ?? {};
  const maxPositionPct = account?.maxPositionPct ?? 15;

  // Thesis backfill. The existing orchestrator's syncPositions creates
  // Position rows without a thesis when it first sees a pre-AgBro Alpaca
  // position, and legacy rows from before the thesis column also come back
  // null. Any null-thesis row gets seeded here so the evaluator can flag
  // them for review on this same pass — the whole point of the backfill is
  // to surface "we own this, but we haven't documented why" to the LLM.
  const needsSeed = dbPositions.filter((p) => !p.thesis);
  if (needsSeed.length > 0) {
    const nowDate = new Date();
    await prisma.position.updateMany({
      where: { userId, symbol: { in: needsSeed.map((p) => p.symbol) } },
      data: {
        thesis: 'pre-AgBro position — thesis review needed',
        thesisReviewDueAt: nowDate,
      },
    });
    for (const p of needsSeed) {
      p.thesis = 'pre-AgBro position — thesis review needed';
      p.thesisReviewDueAt = nowDate;
    }
  }

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

  // Pre-fetch latest prices for every held symbol in parallel. The
  // loop below used to call getLatestPrice serially for each position
  // whose rules triggered a price-target or tax-harvest check — for a
  // 30-position portfolio that's 60 sequential Alpaca calls, chewing
  // through quota + adding seconds of latency. Promise.allSettled
  // means one symbol's failure doesn't poison the batch; null-on-
  // failure is already the semantic the callers expected from the
  // catch(() => null) pattern.
  const symbolsToPrice = Array.from(
    new Set(
      bp
        .filter((p) => Number(p.qty) > 0)
        .map((p) => p.symbol)
    )
  );
  const priceResults = await Promise.allSettled(
    symbolsToPrice.map((s) => getLatestPrice(s))
  );
  const priceMap = new Map<string, number | null>();
  symbolsToPrice.forEach((s, i) => {
    const r = priceResults[i];
    priceMap.set(s, r.status === 'fulfilled' ? r.value : null);
  });

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

    // Price target (Graham mean-reversion style). Price is pre-fetched
    // above in a single concurrent batch to avoid N serial Alpaca calls.
    if (rules.targetSellPct != null && dbPos) {
      const costBasis = Number(dbPos.avgCostCents) / 100;
      const price = priceMap.get(symbol) ?? null;
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
    if (rules.fundamentalsDegradationExit || rules.dividendSafetyExit) {
      const stock = await prisma.stock.findUnique({ where: { symbol } });
      if (stock) {
        if (rules.fundamentalsDegradationExit) {
          // Simple deterministic check: ROE went negative. A fuller check
          // would compare current ROE / gross margin / D/E to baseline at
          // buy time, but we don't snapshot baselines today — the agent's
          // own judgement fills the gap via the thesis review timer.
          if (stock.returnOnEquity != null && stock.returnOnEquity < 0) {
            signals.push({
              signal: 'review',
              reason: `ROE went negative (${stock.returnOnEquity.toFixed(1)}%) — fundamentals deteriorating`,
            });
          }
        }
        if (rules.dividendSafetyExit) {
          // Dividend safety is the core thesis for dividend strategies. We
          // flag 'review' rather than auto-selling because we can't tell
          // deterministically whether a zero yield means "cut" vs "stale
          // data" vs "never paid." The LLM re-fetches fundamentals and
          // decides. A cut confirmed by fresh data should then → sell.
          if (
            stock.dividendYield != null &&
            stock.dividendYield === 0 &&
            stock.dividendPerShare != null &&
            stock.dividendPerShare === 0
          ) {
            signals.push({
              signal: 'review',
              reason: `dividend appears to be zero — verify whether it was cut, suspended, or the data is stale`,
            });
          }
        }
      }
    }
    // moatBreakExit is qualitative → fully relies on the thesis review timer
    // above. No deterministic moat-erosion signal we can compute cheaply.

    // Tax-loss-harvest check (Q4-only). Advisory flag layered on top of the
    // primary signal. Fires when we're already considering exiting (thesis
    // review due) AND the position sits on a meaningful unrealised loss AND
    // we've held long enough to avoid a buy-side wash-sale. The agent's job:
    // if the thesis review concludes the position should be sold, sell it
    // NOW (this tax year) instead of Jan 1 to capture the loss. If the
    // thesis still holds, DO NOT harvest just for the write-off.
    let taxHarvestCandidate = false;
    let unrealizedLossCents: bigint | null = null;
    if (
      isHarvestSeason(new Date(now)) &&
      dbPos &&
      dbPos.openedAt &&
      dbPos.thesisReviewDueAt &&
      dbPos.thesisReviewDueAt.getTime() <= now
    ) {
      const heldDays = (now - dbPos.openedAt.getTime()) / 86_400_000;
      if (heldDays >= MIN_HARVEST_HELD_DAYS) {
        const avgCostPerShare = Number(dbPos.avgCostCents) / 100;
        // Reuse the batched price from priceMap — no extra Alpaca call.
        const currentPrice = priceMap.get(symbol) ?? null;
        if (currentPrice != null && currentPrice > 0 && avgCostPerShare > 0) {
          const unrealizedLossUsd = (avgCostPerShare - currentPrice) * qty;
          if (unrealizedLossUsd >= MIN_HARVEST_LOSS_USD) {
            taxHarvestCandidate = true;
            unrealizedLossCents = BigInt(Math.round(unrealizedLossUsd * 100));
            log.info('exits.harvest_candidate', {
              symbol,
              unrealizedLossUsd: Math.round(unrealizedLossUsd),
              heldDays: Math.floor(heldDays),
            });
          }
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
      out.push({
        symbol,
        signal: 'hold',
        reason: 'no exit triggers fired',
        thesis,
        taxHarvestCandidate,
        unrealizedLossCents,
      });
      continue;
    }
    signals.sort((a, b) => priority(b.signal) - priority(a.signal));
    const top = signals[0];
    // Append a harvest hint to the reason so the agent sees it inline.
    const reason = taxHarvestCandidate
      ? `${top.reason} — ALSO harvest candidate: $${Math.abs(Number(unrealizedLossCents) / 100).toFixed(0)} unrealised loss, Q4 tax deadline. If the review concludes sell, sell this year.`
      : top.reason;
    out.push({
      symbol,
      signal: top.signal,
      reason,
      trimQty: top.trimQty,
      thesis,
      taxHarvestCandidate,
      unrealizedLossCents,
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

