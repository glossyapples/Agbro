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

// Alpaca crypto symbols use the slash form everywhere.
export function isCryptoSymbol(symbol: string): boolean {
  return symbol.includes('/');
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

export type CryptoOrderArgs = {
  symbol: string; // "BTC/USD"
  side: 'buy' | 'sell';
  // Alpaca crypto accepts either qty (coin quantity) OR notional (USD).
  // For DCA, notional is cleanest (e.g. "$50 of BTC"). Use one, not both.
  qty?: number;
  notionalUsd?: number;
  timeInForce?: 'ioc' | 'gtc'; // crypto only supports these
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
  // SDK's createOrder will accept arbitrary fields.
  const order = (await (a as unknown as {
    createOrder: (o: Record<string, unknown>) => Promise<{ id: string; status: string; symbol: string }>;
  }).createOrder(body));
  return order;
}
