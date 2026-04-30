// Alpaca crypto API. Uses the same SDK client as equities (the SDK routes
// by symbol format — "BTC/USD" is crypto, "AAPL" is equity) but exposes a
// narrower surface for clarity. Paper / live mode is inherited from the
// main alpaca.ts client config.
//
// v1 uses a minimal set of endpoints: account (shared with equities),
// positions filtered to crypto symbols, latest bar per symbol, and order
// placement. Bars are pulled via the v1beta3 crypto endpoint because the
// SDK's getBarsV2 targets equities.

import { getAlpaca } from '@/lib/alpaca';
import { log } from '@/lib/logger';

// Alpaca crypto symbols come in two formats depending on broker config and
// SDK path: the canonical "BTC/USD" with a slash, and the legacy concat
// form "BTCUSD" (visible in paper-trading position listings). We accept
// both — the slashless form needs a regex check because we can't just
// scan for "USD" anywhere (would catch made-up equities); the constraint
// is "all letters/digits, ending in a fiat stable suffix, plausible
// crypto length". US equity tickers are 1-5 chars and never end in USDT/
// USDC; the only collision risk is a fictitious 5+char equity ending in
// USD, which the SEC ticker space doesn't currently contain.
export function isCryptoSymbol(symbol: string): boolean {
  if (symbol.includes('/')) return true;
  return /^[A-Z0-9]{2,9}(USDT|USDC|USD)$/.test(symbol);
}

export type CryptoPosition = {
  symbol: string; // "BTC/USD"
  qty: number;
  avgEntryPriceCents: bigint;
  marketValueCents: bigint;
  currentPrice: number;
};

// List open crypto positions only (filters from the shared positions list).
export async function getCryptoPositions(): Promise<CryptoPosition[]> {
  const a = getAlpaca();
  type RawPosition = {
    symbol?: string;
    qty?: string;
    avg_entry_price?: string;
    market_value?: string;
    current_price?: string;
  };
  const all = (await a.getPositions()) as RawPosition[];
  return all
    .filter((p) => typeof p.symbol === 'string' && isCryptoSymbol(p.symbol))
    .map((p) => ({
      symbol: String(p.symbol),
      qty: Number(p.qty ?? 0),
      avgEntryPriceCents: BigInt(Math.round(Number(p.avg_entry_price ?? 0) * 100)),
      marketValueCents: BigInt(Math.round(Number(p.market_value ?? 0) * 100)),
      currentPrice: Number(p.current_price ?? 0),
    }));
}

// Latest trade price for a crypto pair. Alpaca's crypto data endpoint lives
// at /v1beta3/crypto/us/latest/trades — separate from equities. We go
// direct fetch rather than through the SDK because SDK coverage is patchy.
export async function getCryptoLatestPrice(symbol: string): Promise<number | null> {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!keyId || !secretKey) return null;
  const url = `https://data.alpaca.markets/v1beta3/crypto/us/latest/trades?symbols=${encodeURIComponent(symbol)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secretKey,
      },
    });
    if (!res.ok) {
      log.warn('crypto.latest_price_failed', { symbol, status: res.status });
      return null;
    }
    const data = (await res.json()) as { trades?: Record<string, { p: number }> };
    const trade = data.trades?.[symbol];
    return trade?.p ?? null;
  } catch (err) {
    log.error('crypto.latest_price_exception', err, { symbol });
    return null;
  }
}

export type CryptoBar = {
  timestampMs: number;
  close: number;
};

// Alpaca's supported crypto bar timeframes. Finer than 1Hour is essential
// for sane intraday charts on a 24/7 market — hourly closes give 24 ticks
// per day, which can't represent the kind of moves crypto produces between
// hours. Coarser is fine for multi-month/multi-year ranges where we want
// fewer points to avoid overplotting.
export type CryptoBarTimeframe =
  | '1Min'
  | '5Min'
  | '15Min'
  | '30Min'
  | '1Hour'
  | '2Hour'
  | '4Hour'
  | '6Hour'
  | '8Hour'
  | '12Hour'
  | '1Day';

// Historical crypto bars. Alpaca's crypto data endpoint is separate from
// equities (different base URL, different auth header semantics). Used by
// the /crypto performance chart to reconstruct book value at high
// resolution + render the BTC benchmark line.
export async function getCryptoBars(
  symbol: string,
  timeframe: CryptoBarTimeframe,
  startMs: number,
  endMs: number
): Promise<CryptoBar[]> {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!keyId || !secretKey) return [];
  const start = new Date(startMs).toISOString();
  const end = new Date(endMs).toISOString();
  const url = `https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(
    symbol
  )}&timeframe=${timeframe}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=10000`;
  try {
    const res = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secretKey,
      },
    });
    if (!res.ok) {
      log.warn('crypto.bars_failed', { symbol, status: res.status });
      return [];
    }
    const data = (await res.json()) as {
      bars?: Record<string, Array<{ t: string; c: number }>>;
    };
    const raw = data.bars?.[symbol] ?? [];
    return raw.map((b) => ({ timestampMs: new Date(b.t).getTime(), close: b.c }));
  } catch (err) {
    log.error('crypto.bars_exception', err, { symbol });
    return [];
  }
}

export type CryptoOrderArgs = {
  symbol: string; // "BTC/USD"
  side: 'buy' | 'sell';
  // Alpaca crypto accepts either qty (coin quantity) OR notional (USD).
  // For DCA, notional is cleanest (e.g. "$50 of BTC"). Use one, not both.
  qty?: number;
  notionalUsd?: number;
  timeInForce?: 'ioc' | 'gtc'; // crypto only supports these
  // Idempotency token. Alpaca dedupes orders that share a client_order_id
  // within ~24h, so a deterministic per-leg hash protects us from
  // duplicate buys when the engine retries after a network drop on the
  // response (the broker accepted the order, but our process never saw
  // the ack). Audit C7.
  clientOrderId?: string;
};

export async function placeCryptoOrder(args: CryptoOrderArgs) {
  const a = getAlpaca();
  if ((args.qty == null) === (args.notionalUsd == null)) {
    throw new Error('placeCryptoOrder: specify exactly one of qty or notionalUsd');
  }
  const body: Record<string, unknown> = {
    symbol: args.symbol,
    side: args.side,
    type: 'market',
    time_in_force: args.timeInForce ?? 'gtc',
  };
  if (args.qty != null) body.qty = String(args.qty);
  if (args.notionalUsd != null) body.notional = String(args.notionalUsd.toFixed(2));
  if (args.clientOrderId) body.client_order_id = args.clientOrderId;
  // SDK's createOrder will accept arbitrary fields.
  const order = (await (a as unknown as {
    createOrder: (o: Record<string, unknown>) => Promise<{ id: string; status: string; symbol: string }>;
  }).createOrder(body));
  return order;
}
