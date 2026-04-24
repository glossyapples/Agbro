// GET /api/performance?range=1D|1W|1M|3M|YTD|1Y|ALL
//
// Returns the Robinhood-style chart payload: portfolio equity time-series
// from Alpaca's own portfolio_history (so it matches what Alpaca shows in
// their UI), plus a SPY benchmark overlay expressed as % return from the
// range start. Both series share the same y-axis (% from start) so they're
// directly comparable.
//
// Falls back to an empty-but-valid response if Alpaca is unreachable or the
// account is brand new (no history yet) — the UI renders "Waiting for data"
// instead of showing a red error. Trading-decision code is never in this
// path, so chart flakes never affect the agent.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getPortfolioHistory,
  getBars,
  getBrokerAccount,
  type PortfolioHistoryRange,
} from '@/lib/alpaca';
import { apiError, requireUser } from '@/lib/api';
import { log } from '@/lib/logger';
import { prisma } from '@/lib/db';

// For each Alpaca portfolio-history timestamp, estimate how much of the
// reported equity came from the crypto book so we can subtract it and
// surface a stocks-only view. Matches to the nearest-prior
// CryptoBookSnapshot per point; falls back to 0 for points before our
// snapshot series exists (crypto wasn't part of the portfolio yet).
function subtractCryptoAt(
  portfolioTimestampMs: number,
  snapshots: Array<{ takenAt: Date; bookValueCents: bigint }>
): number {
  if (snapshots.length === 0) return 0;
  let latest: (typeof snapshots)[number] | null = null;
  for (const s of snapshots) {
    if (s.takenAt.getTime() <= portfolioTimestampMs) latest = s;
    else break; // snapshots are sorted asc; first future one means stop
  }
  if (!latest) return 0;
  return Number(latest.bookValueCents) / 100;
}

export const runtime = 'nodejs';
export const maxDuration = 30;

const Query = z.object({
  range: z.enum(['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL']).default('1M'),
});

// Match each UX range to a SPY bar timeframe. Finer grain on short ranges
// so the overlay isn't a step function; daily bars on longer ones to keep
// the response under a few KB.
const SPY_TIMEFRAME: Record<PortfolioHistoryRange, string> = {
  '1D':  '5Min',
  '1W':  '1Hour',
  '1M':  '1Hour',
  '3M':  '1Day',
  'YTD': '1Day',
  '1Y':  '1Day',
  'ALL': '1Day',
};

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const parsed = Query.safeParse({ range: url.searchParams.get('range') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const range = parsed.data.range;

  try {
    const [portfolio, broker] = await Promise.all([
      getPortfolioHistory(range).catch((err) => {
        log.warn('performance.portfolio_history_failed', { range }, err);
        return [];
      }),
      // Live broker state for the current-equity scalar. Alpaca's
      // portfolio_history lags real-time deposits + post-close
      // movements; using portfolio_value keeps the headline honest
      // when users check outside market hours or right after a
      // deposit. Falls back to the series last point if unavailable.
      getBrokerAccount().catch((err) => {
        log.warn('performance.broker_read_failed', { range }, err);
        return null;
      }),
    ]);

    // Crypto subtraction. Alpaca's portfolio_history returns TOTAL account
    // equity (cash + stocks + options + crypto). The stocks-tab chart
    // should exclude crypto so it doesn't get polluted by a 1%–10% crypto
    // sleeve moving 5% in a day. Use our own CryptoBookSnapshot series
    // (hourly) and subtract nearest-prior snapshot value per point.
    const snapshots =
      portfolio.length > 0
        ? await prisma.cryptoBookSnapshot.findMany({
            where: {
              userId: user.id,
              takenAt: { lte: new Date(portfolio[portfolio.length - 1].timestampMs) },
            },
            orderBy: { takenAt: 'asc' },
            select: { takenAt: true, bookValueCents: true },
          })
        : [];
    const stocksPortfolio = portfolio.map((p) => ({
      timestampMs: p.timestampMs,
      equity: p.equity - subtractCryptoAt(p.timestampMs, snapshots),
    }));

    // Anchor returns to the first point so portfolio and SPY share a y-axis.
    const basis = stocksPortfolio[0]?.equity ?? null;
    const portfolioSeries = stocksPortfolio.map((p) => ({
      t: p.timestampMs,
      v: p.equity,
      // pct return from range start — this is what the chart line draws
      pct: basis && basis > 0 ? ((p.equity - basis) / basis) * 100 : 0,
    }));

    // SPY overlay — skip if we have no portfolio points to align to.
    let spySeries: Array<{ t: number; pct: number }> = [];
    if (portfolio.length > 0) {
      const startMs = portfolio[0].timestampMs;
      // Alpaca's free IEX feed has a ~15 min delay. Asking for bars past
      // that point produces the "code: undefined, message: undefined"
      // error we were seeing on 1D. Back the end off by 20 min to stay
      // safely inside the feed's available range. Negligible impact on
      // longer ranges where the last point is days/hours old anyway.
      const rawEndMs = portfolio[portfolio.length - 1].timestampMs;
      const endMs = Math.min(rawEndMs, Date.now() - 20 * 60_000);
      const bars = await getBars('SPY', SPY_TIMEFRAME[range], startMs, endMs).catch(
        (err) => {
          log.warn('performance.spy_bars_failed', { range }, err);
          return [];
        }
      );
      const spyBasis = bars[0]?.close ?? null;
      spySeries = bars.map((b) => ({
        t: b.timestampMs,
        pct: spyBasis && spyBasis > 0 ? ((b.close - spyBasis) / spyBasis) * 100 : 0,
      }));
    }

    const last = stocksPortfolio[stocksPortfolio.length - 1];
    // Prefer live broker portfolio_value (minus current crypto book)
    // for the headline; fall back to the last history point when
    // broker read fails.
    const liveCrypto = subtractCryptoAt(Date.now(), snapshots);
    const currentEquity =
      broker != null
        ? Number(broker.portfolioValueCents) / 100 - liveCrypto
        : last?.equity ?? null;
    const summary =
      last && currentEquity != null
        ? {
            currentEquity,
            rangePnl: currentEquity - (basis ?? currentEquity),
            rangePnlPct:
              basis && basis > 0 ? ((currentEquity - basis) / basis) * 100 : 0,
            spyPnlPct: spySeries[spySeries.length - 1]?.pct ?? null,
          }
        : null;

    return NextResponse.json({
      range,
      summary,
      portfolio: portfolioSeries,
      spy: spySeries,
    });
  } catch (err) {
    return apiError(err, 500, 'performance fetch failed', 'performance.get');
  }
}
