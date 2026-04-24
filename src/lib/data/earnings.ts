// Next-earnings-date lookup via Perplexity. Earnings dates are stable,
// publicly-announced facts that LLM-backed search finds reliably. We refresh
// per-symbol at most once per 30 days (the reporting cadence is ~90 days so
// 30 gives headroom to pick up confirmed dates after the company announces).
//
// Budget math: ~30 watchlist symbols × 4 refreshes/yr ≈ 120 Perplexity calls
// per year. At Perplexity sonar-pro pricing, that's well under $1/yr.

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { perplexitySearch } from '@/lib/research/perplexity';

const EARNINGS_REFRESH_STALE_DAYS = 30;

const EARNINGS_SYSTEM =
  'You answer with exactly one ISO date (YYYY-MM-DD) when the next earnings report for the given US-listed public company is expected. Return "UNKNOWN" if you cannot find a confirmed or strongly-estimated date. No prose, no explanation — just the date or UNKNOWN.';

// Matches YYYY-MM-DD anywhere in the response so we tolerate stray markdown.
const DATE_RE = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/;

export async function refreshEarningsDate(symbol: string): Promise<Date | null> {
  const stock = await prisma.stock.findUnique({
    where: { symbol },
    select: { earningsCheckedAt: true, nextEarningsAt: true },
  });
  const now = new Date();
  // Skip if we checked recently AND the date we have is still in the future.
  // A past nextEarningsAt is always considered stale (the earnings happened).
  if (
    stock?.earningsCheckedAt &&
    stock.nextEarningsAt &&
    stock.nextEarningsAt > now &&
    now.getTime() - stock.earningsCheckedAt.getTime() <
      EARNINGS_REFRESH_STALE_DAYS * 86_400_000
  ) {
    return stock.nextEarningsAt;
  }

  // Post-B2.x: the Stock catalog is no longer the authoritative per-user
  // surface — the per-user UserWatchlist is. A symbol can appear on the
  // agent's desk (via research, a candidate promotion, a post-placement
  // position sync) without ever being in Stock. Use upsert instead of
  // update so the earnings-refresh path seeds a minimal Stock row when
  // it's missing, rather than throwing P2025 noise through every tick.
  async function writeEarnings(data: {
    nextEarningsAt?: Date | null;
    earningsCheckedAt: Date;
    earningsSource: string;
  }): Promise<void> {
    await prisma.stock.upsert({
      where: { symbol },
      update: data,
      create: {
        symbol,
        // Symbol is the only field we know at this point; the name
        // backfills whenever the screener / EDGAR path touches this row.
        name: symbol,
        ...data,
      },
    });
  }

  try {
    const res = await perplexitySearch(
      `When is the next earnings report date for ${symbol}? Respond with only the date in YYYY-MM-DD format, or UNKNOWN.`,
      { system: EARNINGS_SYSTEM }
    );
    const match = res.summary.match(DATE_RE);
    if (!match) {
      log.info('earnings.unknown', { symbol, response: res.summary.slice(0, 100) });
      await writeEarnings({ earningsCheckedAt: now, earningsSource: 'perplexity' });
      return null;
    }
    const parsed = new Date(`${match[0]}T21:00:00Z`); // 4pm ET typical AMC release, close enough for blackout math
    // Reject dates in the past or absurdly far out (> 180 days) — likely a
    // hallucination from the model.
    if (parsed < now || parsed.getTime() > now.getTime() + 180 * 86_400_000) {
      log.warn('earnings.out_of_range', { symbol, parsed: parsed.toISOString() });
      await writeEarnings({ earningsCheckedAt: now, earningsSource: 'perplexity' });
      return null;
    }
    await writeEarnings({
      nextEarningsAt: parsed,
      earningsCheckedAt: now,
      earningsSource: 'perplexity',
    });
    log.info('earnings.refreshed', { symbol, date: match[0] });
    return parsed;
  } catch (err) {
    log.error('earnings.refresh_failed', err, { symbol });
    return null;
  }
}

// Check whether a symbol is inside its earnings blackout window. Blackout
// starts 3 trading days before earnings and ends the day after the call.
// Called from the place_trade tool before a BUY; sells/trims are always
// allowed (you never want to be stuck in a broken thesis waiting on a call).
export async function isInEarningsBlackout(
  symbol: string,
  nowMs: number = Date.now()
): Promise<{ blocked: boolean; nextEarningsAt: Date | null; reason?: string }> {
  const stock = await prisma.stock.findUnique({
    where: { symbol },
    select: { nextEarningsAt: true },
  });
  if (!stock?.nextEarningsAt) return { blocked: false, nextEarningsAt: null };
  const diffDays = (stock.nextEarningsAt.getTime() - nowMs) / 86_400_000;
  // 3 calendar days covers ~3 trading days in the worst case (Thu earnings →
  // Monday). Slight over-block is fine — better than under-block.
  if (diffDays < -1) return { blocked: false, nextEarningsAt: stock.nextEarningsAt };
  if (diffDays <= 3) {
    return {
      blocked: true,
      nextEarningsAt: stock.nextEarningsAt,
      reason: `earnings in ${Math.max(0, Math.ceil(diffDays))} day(s); buys are blocked until after the report`,
    };
  }
  return { blocked: false, nextEarningsAt: stock.nextEarningsAt };
}
