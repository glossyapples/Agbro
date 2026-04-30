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
import { computeCryptoChart, type Range as CryptoRange } from '@/lib/crypto/performance';
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

  const url = new URL(req.url);
  const parsed = Query.safeParse({ range: url.searchParams.get('range') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const range = parsed.data.range;

  try {
    const [portfolio, broker, cryptoChart] = await Promise.all([
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
      // Per-tick crypto book values for the same range, so we can
      // restore "total wealth" semantics in the chart. Alpaca's paper-
      // trading portfolio_history.equity excludes crypto, which means
      // a crypto buy shows up as a cliff in cash. Adding crypto back
      // at each timestamp nets the category shift to zero.
      computeCryptoChart(user.id, range as CryptoRange).catch(() => ({
        book: [] as Array<{ t: number; v: number; pct: number }>,
      })),
    ]);

    // Walk the crypto book in lock-step with the portfolio timestamps.
    // Both arrays are sorted asc; for each portfolio point, advance
    // through the crypto series and remember the latest book value
    // at-or-before that timestamp. Pre-purchase = +$0, post-purchase
    // = +(qty × price-at-T) computed from trades + bars.
    const cryptoBook = cryptoChart.book;
    let cryptoIdx = 0;
    let lastCrypto = 0;
    const stocksPortfolio = portfolio.map((p) => {
      while (cryptoIdx < cryptoBook.length && cryptoBook[cryptoIdx].t <= p.timestampMs) {
        lastCrypto = cryptoBook[cryptoIdx].v;
        cryptoIdx += 1;
      }
      return {
        timestampMs: p.timestampMs,
        equity: p.equity + lastCrypto,
      };
    });

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
    // Headline matches chart semantics now (total wealth incl. crypto),
    // so use broker.portfolioValueCents directly.
    const currentEquity =
      broker != null
        ? Number(broker.portfolioValueCents) / 100
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
