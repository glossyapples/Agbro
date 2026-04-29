// Compute the user's crypto book-value series at chart resolution by
// walking their Trade history alongside Alpaca's historical bars. Replaces
// the older approach that read sparse `CryptoBookSnapshot` rows — those
// were written hourly by the scheduler when it actually ran, missing
// during the lease-bug window AND too coarse for a 24/7 market regardless.
//
// Why on-the-fly is correct here:
//  - Crypto markets move continuously. Sampling at hourly cadence misses
//    intraday volatility entirely; sampling at sub-hour cadence requires
//    a write loop more aggressive than is reasonable for a side-effecting
//    table. Read-time computation from bars + trades gives the right
//    resolution at zero write cost.
//  - The data we need is already authoritative: trade rows are immutable
//    once filled, Alpaca bars are the same data we'd be averaging into a
//    snapshot anyway. Reconstructing a series eliminates the possibility
//    of a "snapshot wasn't taken because the cron was broken" gap.
//  - Cost is bounded: per range, we make N bar fetches (one per held
//    symbol) plus the BTC overlay. Linear in symbols, independent of
//    user-facing chart density.

import { prisma } from '@/lib/db';
import { getCryptoBars, type CryptoBar, type CryptoBarTimeframe } from '@/lib/alpaca-crypto';
import { log } from '@/lib/logger';

export type Range = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | 'ALL';

export type BookSeriesPoint = { t: number; v: number; pct: number };
export type BtcSeriesPoint = { t: number; pct: number };
export type CryptoChartData = {
  range: Range;
  book: BookSeriesPoint[];
  btc: BtcSeriesPoint[];
  summary: {
    currentBookValue: number;
    rangePnl: number;
    rangePnlPct: number;
  } | null;
};

// Bar resolution per range. Trade-off: density of the chart vs API cost
// + plot complexity. 1D at 5-minute bars = 288 ticks/day, well within
// Alpaca's 10000-bar limit per request and well within any browser's
// ability to render a smooth line.
const RANGE_CONFIG: Record<
  Range,
  { lookbackMs: number | 'ytd' | 'all'; timeframe: CryptoBarTimeframe }
> = {
  '1D': { lookbackMs: 24 * 60 * 60_000, timeframe: '5Min' },
  '1W': { lookbackMs: 7 * 24 * 60 * 60_000, timeframe: '1Hour' },
  '1M': { lookbackMs: 30 * 24 * 60 * 60_000, timeframe: '4Hour' },
  '3M': { lookbackMs: 90 * 24 * 60 * 60_000, timeframe: '1Day' },
  YTD: { lookbackMs: 'ytd', timeframe: '1Day' },
  '1Y': { lookbackMs: 365 * 24 * 60 * 60_000, timeframe: '1Day' },
  ALL: { lookbackMs: 'all', timeframe: '1Day' },
};

// Trade rows store crypto symbols in whichever form the engine wrote
// them — historically that meant the Alpaca slash form ("BTC/USD") but
// paper-trading positions sometimes round-trip through the concat form
// ("BTCUSD"). The bars endpoint expects slash form. Convert defensively.
export function toAlpacaCryptoSymbol(symbol: string): string {
  if (symbol.includes('/')) return symbol;
  for (const suf of ['USDT', 'USDC', 'USD'] as const) {
    if (symbol.endsWith(suf)) {
      return `${symbol.slice(0, -suf.length)}/${suf}`;
    }
  }
  return symbol;
}

function rangeStartMs(range: Range, now: number): number {
  const cfg = RANGE_CONFIG[range];
  if (cfg.lookbackMs === 'ytd') {
    return new Date(Date.UTC(new Date(now).getUTCFullYear(), 0, 1)).getTime();
  }
  if (cfg.lookbackMs === 'all') {
    return 0;
  }
  return now - cfg.lookbackMs;
}

type FilledTrade = {
  symbol: string;
  side: string;
  qty: number;
  submittedAtMs: number;
};

// Walk the trade timeline once per symbol, advancing through ticks in
// merge-sort fashion. For each tick we know the current cumulative qty
// without re-scanning trades. O(ticks + trades) per symbol.
export function buildBookValueAtTicks(
  ticks: number[],
  trades: FilledTrade[],
  barsBySym: Map<string, CryptoBar[]>
): number[] {
  const symbols = Array.from(barsBySym.keys());
  const tradeIdx = new Map<string, number>(symbols.map((s) => [s, 0]));
  const qty = new Map<string, number>(symbols.map((s) => [s, 0]));
  const barIdx = new Map<string, number>(symbols.map((s) => [s, 0]));
  const lastPrice = new Map<string, number | null>(symbols.map((s) => [s, null]));
  const tradesBySym = new Map<string, FilledTrade[]>();
  for (const sym of symbols) tradesBySym.set(sym, []);
  for (const t of trades) {
    const list = tradesBySym.get(t.symbol);
    if (list) list.push(t);
  }

  const out: number[] = [];
  for (const tickT of ticks) {
    let book = 0;
    for (const sym of symbols) {
      const tlist = tradesBySym.get(sym) ?? [];
      let i = tradeIdx.get(sym) ?? 0;
      let q = qty.get(sym) ?? 0;
      while (i < tlist.length && tlist[i].submittedAtMs <= tickT) {
        q += tlist[i].side === 'buy' ? tlist[i].qty : -tlist[i].qty;
        i += 1;
      }
      tradeIdx.set(sym, i);
      qty.set(sym, q);
      const bars = barsBySym.get(sym) ?? [];
      let bi = barIdx.get(sym) ?? 0;
      let p = lastPrice.get(sym) ?? null;
      while (bi < bars.length && bars[bi].timestampMs <= tickT) {
        p = bars[bi].close;
        bi += 1;
      }
      barIdx.set(sym, bi);
      lastPrice.set(sym, p);
      if (q > 0 && p != null) {
        book += q * p;
      }
    }
    out.push(book);
  }
  return out;
}

export async function computeCryptoChart(
  userId: string,
  range: Range
): Promise<CryptoChartData> {
  const cfg = RANGE_CONFIG[range];
  const now = Date.now();
  const startMs = rangeStartMs(range, now);

  const trades = await prisma.trade.findMany({
    where: { userId, assetClass: 'crypto', status: 'filled' },
    orderBy: { submittedAt: 'asc' },
    select: { symbol: true, side: true, qty: true, submittedAt: true },
  });
  if (trades.length === 0) {
    return { range, book: [], btc: [], summary: null };
  }
  const filled: FilledTrade[] = trades.map((t) => ({
    symbol: t.symbol,
    side: t.side,
    qty: t.qty,
    submittedAtMs: t.submittedAt.getTime(),
  }));

  const symbols = Array.from(new Set(filled.map((t) => t.symbol)));

  const barsBySym = new Map<string, CryptoBar[]>();
  await Promise.all(
    symbols.map(async (sym) => {
      const apiSym = toAlpacaCryptoSymbol(sym);
      const bars = await getCryptoBars(apiSym, cfg.timeframe, startMs, now).catch((err) => {
        log.warn('crypto.chart_bars_failed', {
          sym,
          err: (err as Error).message,
        });
        return [] as CryptoBar[];
      });
      barsBySym.set(sym, bars);
    })
  );

  // Time axis: the symbol with the densest bars (defends against one
  // illiquid coin pulling the chart resolution down).
  const tickSym = symbols.reduce(
    (best, sym) =>
      (barsBySym.get(sym)?.length ?? 0) > (barsBySym.get(best)?.length ?? 0)
        ? sym
        : best,
    symbols[0]
  );
  const tickBars = barsBySym.get(tickSym) ?? [];
  if (tickBars.length === 0) {
    return { range, book: [], btc: [], summary: null };
  }
  const ticks = tickBars.map((b) => b.timestampMs);

  const bookValues = buildBookValueAtTicks(ticks, filled, barsBySym);
  // Anchor % return on the first tick where the user actually held
  // crypto. Otherwise a buy mid-window would divide-by-zero or report
  // an absurd % from a zero baseline.
  let basisValue: number | null = null;
  const book: BookSeriesPoint[] = [];
  for (let i = 0; i < ticks.length; i++) {
    const v = bookValues[i];
    if (basisValue == null && v > 0) basisValue = v;
    book.push({
      t: ticks[i],
      v,
      pct: basisValue && basisValue > 0 ? ((v - basisValue) / basisValue) * 100 : 0,
    });
  }

  // BTC overlay: reuse the bars we already fetched if the user holds
  // BTC, otherwise one extra request.
  const btcBars =
    barsBySym.get('BTC/USD') ??
    barsBySym.get('BTCUSD') ??
    (book.length >= 2
      ? await getCryptoBars('BTC/USD', cfg.timeframe, startMs, now).catch(
          () => [] as CryptoBar[]
        )
      : []);
  let btcAnchor: number | null = null;
  const btc: BtcSeriesPoint[] = btcBars.map((b) => {
    if (btcAnchor == null) btcAnchor = b.close;
    return {
      t: b.timestampMs,
      pct: btcAnchor && btcAnchor > 0 ? ((b.close - btcAnchor) / btcAnchor) * 100 : 0,
    };
  });

  const last = book[book.length - 1];
  const summary =
    last && basisValue != null
      ? {
          currentBookValue: last.v,
          rangePnl: last.v - basisValue,
          rangePnlPct: basisValue > 0 ? ((last.v - basisValue) / basisValue) * 100 : 0,
        }
      : null;

  return { range, book, btc, summary };
}
