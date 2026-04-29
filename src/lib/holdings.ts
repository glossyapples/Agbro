// Enriched positions readers for the holdings detail pages. Returns
// per-symbol rows with everything the UI needs — market value, cost
// basis, P/L in dollars and percent, today's change, a small
// sparkline of recent closes — so the list component stays pure.
//
// Two entry points with a parallel shape:
//   fetchStockHoldings(userId)  → equities from Alpaca getPositions
//   fetchCryptoHoldings(userId) → crypto from Alpaca getCryptoPositions
//
// Both write through one Promise.all across symbols for the
// sparkline bars. Per-symbol bar failures degrade to an empty
// sparkline — the row still renders with value + P/L.

import { getBars, getPositions } from '@/lib/alpaca';
import { getCryptoPositions, getCryptoBars, isCryptoSymbol } from '@/lib/alpaca-crypto';
import { log } from '@/lib/logger';

export type Holding = {
  symbol: string;
  qty: number;
  // Current live state.
  currentPrice: number;
  marketValueCents: bigint;
  // Cost basis = qty × avg_entry_price. Alpaca doesn't return this
  // directly — we compute to make "total return" trivial.
  costBasisCents: bigint;
  avgEntryPrice: number;
  // Total return since acquisition.
  unrealizedPlCents: bigint;
  unrealizedPlPct: number;
  // Today's move. lastdayPrice is the previous close; changeToday is
  // (currentPrice - lastdayPrice). When Alpaca doesn't provide it we
  // fall back to 0 rather than omit the row.
  changeTodayCents: bigint;
  changeTodayPct: number;
  // Tiny history for the inline sparkline. Daily closes over the
  // past 7 trading days (or the 48 most recent hourly bars for
  // crypto). Empty array = "no data", UI renders a flat line.
  sparkline: number[];
};

// How far back the sparkline reaches. Per-symbol parallel fetch.
const STOCK_SPARK_DAYS = 7;
const CRYPTO_SPARK_HOURS = 48;

async function stocksSparkline(symbol: string): Promise<number[]> {
  try {
    const startMs = Date.now() - STOCK_SPARK_DAYS * 86_400_000;
    const bars = await getBars(symbol, '1Day', startMs);
    return bars.map((b) => b.close);
  } catch (err) {
    log.warn('holdings.stock_sparkline_failed', { symbol, err: (err as Error).message });
    return [];
  }
}

async function cryptoSparkline(symbol: string): Promise<number[]> {
  try {
    const startMs = Date.now() - CRYPTO_SPARK_HOURS * 3_600_000;
    const bars = await getCryptoBars(symbol, '1Hour', startMs, Date.now());
    return bars.map((b) => b.close);
  } catch (err) {
    log.warn('holdings.crypto_sparkline_failed', { symbol, err: (err as Error).message });
    return [];
  }
}

// Pure enrichment step shared by both paths. Takes the raw Alpaca
// position fields (all strings) and promotes them to the Holding
// shape. Exported for unit tests so we don't have to mock bar
// fetches when we just want to pin the arithmetic.
export function enrichPosition(raw: {
  symbol: string;
  qty: string | number;
  avg_entry_price?: string | number;
  current_price?: string | number;
  market_value?: string | number;
  unrealized_pl?: string | number;
  unrealized_plpc?: string | number;
  lastday_price?: string | number;
  change_today?: string | number;
}): Omit<Holding, 'sparkline'> {
  const n = (v: string | number | undefined): number =>
    v == null ? 0 : typeof v === 'string' ? Number(v) : v;
  const qty = n(raw.qty);
  const avgEntryPrice = n(raw.avg_entry_price);
  const currentPrice = n(raw.current_price);
  const marketValue = n(raw.market_value) || qty * currentPrice;
  const costBasis = qty * avgEntryPrice;
  const unrealizedPl = raw.unrealized_pl != null ? n(raw.unrealized_pl) : marketValue - costBasis;
  // Alpaca reports unrealized_plpc as a decimal (0.123 = 12.3%).
  const unrealizedPlPctDecimal =
    raw.unrealized_plpc != null
      ? n(raw.unrealized_plpc)
      : costBasis > 0
        ? (marketValue - costBasis) / costBasis
        : 0;
  const lastday = n(raw.lastday_price);
  // change_today is usually a decimal percent (0.05 = 5%). Cross-check
  // against (current - lastday) / lastday if available.
  const changeTodayPctDecimal =
    raw.change_today != null
      ? n(raw.change_today)
      : lastday > 0
        ? (currentPrice - lastday) / lastday
        : 0;
  // Absolute daily change in dollars.
  const changeTodayCents =
    lastday > 0
      ? BigInt(Math.round((currentPrice - lastday) * qty * 100))
      : BigInt(Math.round(marketValue * changeTodayPctDecimal * 100));
  return {
    symbol: raw.symbol,
    qty,
    currentPrice,
    marketValueCents: BigInt(Math.round(marketValue * 100)),
    costBasisCents: BigInt(Math.round(costBasis * 100)),
    avgEntryPrice,
    unrealizedPlCents: BigInt(Math.round(unrealizedPl * 100)),
    unrealizedPlPct: unrealizedPlPctDecimal * 100,
    changeTodayCents,
    changeTodayPct: changeTodayPctDecimal * 100,
  };
}

export async function fetchStockHoldings(): Promise<Holding[]> {
  const raw = (await getPositions().catch(() => [])) as Array<Record<string, unknown>>;
  // Crypto comes through the same Alpaca positions endpoint. Earlier
  // logic excluded only slash-form symbols ("BTC/USD"), but Alpaca's
  // paper-trading API returns the legacy concat form ("BTCUSD") that
  // slipped through and showed up in the stocks list. isCryptoSymbol
  // now recognises both formats; this page uses it to keep stocks
  // strictly equity.
  const stocks = raw.filter(
    (p) => typeof p.symbol === 'string' && !isCryptoSymbol(p.symbol as string)
  );
  const enriched = stocks.map((p) =>
    enrichPosition(p as Parameters<typeof enrichPosition>[0])
  );
  const sparks = await Promise.all(enriched.map((h) => stocksSparkline(h.symbol)));
  return enriched.map((h, i) => ({ ...h, sparkline: sparks[i] }));
}

export async function fetchCryptoHoldings(): Promise<Holding[]> {
  const raw = await getCryptoPositions().catch(() => []);
  // getCryptoPositions already returns a typed shape, but enrichPosition
  // wants raw Alpaca strings — quickly re-wrap. It's an in-memory
  // translation, no extra fetch.
  const enriched = raw.map((p) =>
    enrichPosition({
      symbol: p.symbol,
      qty: p.qty,
      avg_entry_price: Number(p.avgEntryPriceCents) / 100,
      current_price: p.currentPrice,
      market_value: Number(p.marketValueCents) / 100,
    })
  );
  const sparks = await Promise.all(enriched.map((h) => cryptoSparkline(h.symbol)));
  return enriched.map((h, i) => ({ ...h, sparkline: sparks[i] }));
}
