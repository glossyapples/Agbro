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

    // Headline = stocks + cash from the broker, full stop. NOT
    // range-dependent. The chart's last sampled equity may differ by
    // a few hundred dollars because Alpaca samples portfolio_history
    // at 5-min/1-hour/1-day intervals depending on range, so the most
    // recent point is always slightly stale — that's fine for the
    // line but wrong for the headline.
    const currentEquity =
      broker != null
        ? Number(broker.portfolioValueCents) / 100
        : portfolio[portfolio.length - 1]?.equity ?? null;

    // Range P&L = the dollar change Alpaca's portfolio_history records
    // over the window, with the deposit-adjusted profit_loss field
    // preferred when present (real Alpaca accounts excludes external
    // deposits/withdrawals from this number; paper accounts may not).
    // Fall back to raw equity diff if profit_loss is missing or zero.
    const last = portfolio[portfolio.length - 1] ?? null;
    const first = portfolio[0] ?? null;
    const rangePnl = (() => {
      if (last == null || first == null) return null;
      // Prefer profit_loss when alpaca returned a non-trivial value —
      // it's the deposit-adjusted number on real accounts. Equity diff
      // includes deposits.
      if (Math.abs(last.profitLoss) > 0.01) return last.profitLoss;
      return last.equity - first.equity;
    })();

    // % gain measured against invested capital (currentEquity − rangePnl),
    // i.e. backwards-derived "what you put in" given the current value
    // and the gain. This avoids the divide-by-tiny-first-bar bug where
    // Alpaca's first non-null equity for a new account is sometimes a
    // pre-deposit transient (a few thousand dollars), making a real
    // $400 gain render as +11.54%.
    const investedCapital =
      currentEquity != null && rangePnl != null ? currentEquity - rangePnl : null;
    const rangePnlPct =
      investedCapital != null && investedCapital > 0 && rangePnl != null
        ? (rangePnl / investedCapital) * 100
        : 0;

    // Chart line: per-point % return relative to the same invested-capital
    // basis the headline uses. Anchored so the right edge of the line
    // equals the headline rangePnlPct (chart and headline can't disagree).
    const portfolioSeries =
      first != null && investedCapital != null && investedCapital > 0
        ? portfolio.map((p) => {
            const pl = Math.abs(p.profitLoss) > 0.01 ? p.profitLoss : p.equity - first.equity;
            return {
              t: p.timestampMs,
              v: p.equity,
              pct: (pl / investedCapital) * 100,
            };
          })
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
