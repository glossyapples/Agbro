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
    // Per-point series carrying BOTH alpaca's deposit-adjusted P&L and
    // the crypto book value, so we can compute a correct deposit-adjusted
    // total return that doesn't show fake "losses" when the user adds
    // cash to the account or transfers stocks-cash into crypto.
    const merged = portfolio.map((p) => {
      while (cryptoIdx < cryptoBook.length && cryptoBook[cryptoIdx].t <= p.timestampMs) {
        lastCrypto = cryptoBook[cryptoIdx].v;
        cryptoIdx += 1;
      }
      return {
        timestampMs: p.timestampMs,
        equity: p.equity + lastCrypto,
        // Alpaca's profit_loss is deposit-adjusted: external deposits
        // and withdrawals are excluded so this is "what the market
        // gave you" only. Adding (crypto[t] − crypto[T0]) recovers
        // crypto P&L that Alpaca can't see, while netting out the
        // stocks→crypto cash transfers it incorrectly counts as
        // outflows.
        alpacaPl: p.profitLoss,
        crypto: lastCrypto,
      };
    });

    // True deposit-adjusted P&L over the range, broken into the two
    // pieces. cryptoStart is the crypto book value at the first
    // portfolio point — anything bought before that is part of the
    // basis and shouldn't be re-counted.
    const cryptoStart = merged[0]?.crypto ?? 0;
    // Per-point % return: truePl divided by invested capital AT THAT POINT
    // (= equity − truePl). We do NOT divide by portfolio[0].equity —
    // for a freshly-funded account Alpaca's first non-null equity is
    // sometimes a few thousand dollars (a transient pre-deposit value)
    // even though the user's actual capital is $100k+. Dividing by
    // that small number produces nonsensical "gains" like +11.54% on
    // a $411 P&L.
    const portfolioSeries = merged.map((p) => {
      const truePl = p.alpacaPl + (p.crypto - cryptoStart);
      const investedAtT = p.equity - truePl;
      return {
        t: p.timestampMs,
        v: p.equity,
        pct: investedAtT > 0 ? (truePl / investedAtT) * 100 : 0,
      };
    });

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

    const last = merged[merged.length - 1];
    // Headline = total wealth (broker portfolio value + current crypto book).
    // broker.portfolioValueCents covers stocks + cash; add crypto to match
    // the chart's "total wealth" semantics.
    const lastCryptoNow = last?.crypto ?? 0;
    const currentEquity =
      broker != null
        ? Number(broker.portfolioValueCents) / 100 + lastCryptoNow
        : last?.equity ?? null;
    // Range P&L = Alpaca's deposit-adjusted profit_loss (stocks side) +
    // crypto book delta over the range. This stops external deposits
    // and stocks→crypto transfers from showing up as fake gains/losses.
    const rangePnl =
      last != null ? last.alpacaPl + (lastCryptoNow - cryptoStart) : null;
    // % gain measured against invested capital (currentEquity − rangePnl),
    // i.e. "what you put in". Avoids the divide-by-tiny-firstBarEquity
    // bug where a $411 gain rendered as +11.54% because Alpaca's first
    // recorded equity for a new account was $3,569 (pre-deposit transient).
    const investedCapital =
      currentEquity != null && rangePnl != null ? currentEquity - rangePnl : null;
    const summary =
      last && currentEquity != null
        ? {
            currentEquity,
            rangePnl: rangePnl ?? 0,
            rangePnlPct:
              investedCapital != null && investedCapital > 0
                ? ((rangePnl ?? 0) / investedCapital) * 100
                : 0,
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
