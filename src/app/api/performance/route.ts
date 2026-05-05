// GET /api/performance?range=1D|1W|1M|3M|YTD|1Y|ALL
//
// Stocks-only performance chart. The Stocks tab shows stocks; crypto
// has its own tab and its own /api/crypto/performance endpoint. Mixing
// crypto book values into this route's equity series caused the
// headline "current equity" to vary by selected range (because the
// crypto book at the last historical timestamp differed by range) and
// produced nonsensical P&L numbers, so the integration is gone.
//
// Returns:
//   - summary: { currentEquity, rangePnl, rangePnlPct, spyPnlPct }
//   - portfolio: time-series of stocks+cash equity (Alpaca's number)
//   - spy: SPY benchmark % return overlay
//
// Falls back to an empty-but-valid response if Alpaca is unreachable
// or the account is brand new (no history yet).

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
  void user;

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
      // Live broker state for the canonical current-equity scalar.
      // Same number for every range — broker reads "now", independent
      // of the selected window. Chart equity series can lag (Alpaca's
      // portfolio_history is sampled and trails real-time by minutes),
      // but the headline must not.
      getBrokerAccount().catch((err) => {
        log.warn('performance.broker_read_failed', { range }, err);
        return null;
      }),
    ]);

    // Headline = stocks + cash from the broker. Range-independent and
    // always live; we don't trust Alpaca's portfolio_history "last
    // point" because the paper-account series has been observed to
    // report stale or wrong values (e.g. a 1W last bar showing $82k
    // when the live account is $100k).
    const currentEquity =
      broker != null
        ? Number(broker.portfolioValueCents) / 100
        : portfolio[portfolio.length - 1]?.equity ?? null;

    // First "meaningful" point in the series: skip leading zero-equity
    // bars (they're "the account didn't exist yet" placeholders for
    // ranges longer than the account's age). Without this skip, the
    // 1M/3M ranges anchor on $0 and turn the entire deposit into a
    // bogus "gain".
    const firstMeaningful = portfolio.find((p) => p.equity > 0) ?? null;

    // Range P&L = (live broker equity) − (first meaningful equity in
    // range). Raw equity diff, NOT alpaca.profit_loss. profit_loss on
    // paper accounts has been observed to be wildly wrong (e.g. -$18k
    // for a week where the account only moved +$449); raw diff at
    // least matches the equity numbers the user can see in Alpaca's
    // own UI. Mid-range deposits / withdrawals will count as gains /
    // losses here — that's a real product limitation we'd need a
    // deposit ledger to fix.
    const rangePnl =
      currentEquity != null && firstMeaningful != null
        ? currentEquity - firstMeaningful.equity
        : null;

    const rangePnlPct =
      firstMeaningful != null && firstMeaningful.equity > 0 && rangePnl != null
        ? (rangePnl / firstMeaningful.equity) * 100
        : 0;

    // Chart line: per-point % return from the first meaningful equity.
    // Replace the last sample with the live broker value so the chart
    // ends at the same number the headline shows; otherwise a stale
    // last bar from Alpaca leaves the chart line dangling above or
    // below the headline.
    const portfolioSeries =
      firstMeaningful != null && firstMeaningful.equity > 0
        ? (() => {
            const meaningful = portfolio.filter((p) => p.equity > 0);
            const series = meaningful.map((p) => ({
              t: p.timestampMs,
              v: p.equity,
              pct: ((p.equity - firstMeaningful.equity) / firstMeaningful.equity) * 100,
            }));
            // Force the right edge to match the headline.
            if (series.length > 0 && currentEquity != null) {
              const last = series[series.length - 1];
              series[series.length - 1] = {
                t: last.t,
                v: currentEquity,
                pct:
                  ((currentEquity - firstMeaningful.equity) / firstMeaningful.equity) * 100,
              };
            }
            return series;
          })()
        : [];

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

    const summary =
      currentEquity != null
        ? {
            currentEquity,
            rangePnl: rangePnl ?? 0,
            rangePnlPct,
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
