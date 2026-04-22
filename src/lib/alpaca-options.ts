// Alpaca options API — the SDK's Node client doesn't cover options yet, so
// we go direct to the REST endpoints. Paper vs. live base URL is toggled
// via ALPACA_PAPER exactly like the equities client.
//
// Three endpoints we rely on:
//   1. GET /v2/options/contracts                — list contracts by filters
//   2. GET /v1beta1/options/snapshots/{sym}     — quote + greeks
//   3. POST /v2/orders                           — same endpoint as equities,
//                                                  Alpaca routes by symbol
//
// Account-level options approval happens inside Alpaca's dashboard; we
// surface their error if an order is rejected for lack of permission.

import { log } from '@/lib/logger';

function paperMode(): boolean {
  return (process.env.ALPACA_PAPER ?? 'true') !== 'false';
}

function tradingBase(): string {
  return paperMode()
    ? 'https://paper-api.alpaca.markets'
    : 'https://api.alpaca.markets';
}

const DATA_BASE = 'https://data.alpaca.markets';

function authHeaders(): Record<string, string> {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!keyId || !secretKey) {
    throw new Error('Alpaca credentials missing. Set ALPACA_KEY_ID and ALPACA_SECRET_KEY.');
  }
  return {
    'APCA-API-KEY-ID': keyId,
    'APCA-API-SECRET-KEY': secretKey,
  };
}

export type OptionContract = {
  id: string;
  symbol: string; // OCC symbol
  underlying_symbol: string;
  type: 'call' | 'put';
  strike_price: string;
  expiration_date: string; // YYYY-MM-DD
  style?: 'american' | 'european';
  status?: string;
  close_price?: string;
};

export type GetOptionContractsParams = {
  underlying: string;
  type?: 'call' | 'put';
  expirationDateGte?: string; // YYYY-MM-DD
  expirationDateLte?: string;
  strikePriceGte?: number;
  strikePriceLte?: number;
  limit?: number;
};

export async function getOptionContracts(
  params: GetOptionContractsParams
): Promise<OptionContract[]> {
  const qs = new URLSearchParams();
  qs.set('underlying_symbols', params.underlying.toUpperCase());
  qs.set('status', 'active');
  if (params.type) qs.set('type', params.type);
  if (params.expirationDateGte) qs.set('expiration_date_gte', params.expirationDateGte);
  if (params.expirationDateLte) qs.set('expiration_date_lte', params.expirationDateLte);
  if (params.strikePriceGte != null) qs.set('strike_price_gte', String(params.strikePriceGte));
  if (params.strikePriceLte != null) qs.set('strike_price_lte', String(params.strikePriceLte));
  qs.set('limit', String(params.limit ?? 100));
  const url = `${tradingBase()}/v2/options/contracts?${qs.toString()}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`alpaca options contracts ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    option_contracts?: OptionContract[];
    contracts?: OptionContract[];
  };
  return data.option_contracts ?? data.contracts ?? [];
}

export type OptionSnapshot = {
  symbol: string;
  latestQuote?: { bidPrice: number; askPrice: number; bidSize: number; askSize: number };
  latestTrade?: { price: number; size: number };
  greeks?: { delta: number; gamma: number; theta: number; vega: number; rho?: number };
  impliedVolatility?: number;
};

export async function getOptionSnapshot(optionSymbol: string): Promise<OptionSnapshot | null> {
  const url = `${DATA_BASE}/v1beta1/options/snapshots/${encodeURIComponent(optionSymbol)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    log.warn('alpaca.option_snapshot_failed', { optionSymbol, status: res.status });
    return null;
  }
  const data = (await res.json()) as {
    snapshot?: {
      latestQuote?: { bp: number; ap: number; bs: number; as: number };
      latestTrade?: { p: number; s: number };
      greeks?: { delta: number; gamma: number; theta: number; vega: number };
      impliedVolatility?: number;
    };
  };
  const s = data.snapshot;
  if (!s) return null;
  return {
    symbol: optionSymbol,
    latestQuote: s.latestQuote
      ? {
          bidPrice: s.latestQuote.bp,
          askPrice: s.latestQuote.ap,
          bidSize: s.latestQuote.bs,
          askSize: s.latestQuote.as,
        }
      : undefined,
    latestTrade: s.latestTrade ? { price: s.latestTrade.p, size: s.latestTrade.s } : undefined,
    greeks: s.greeks,
    impliedVolatility: s.impliedVolatility,
  };
}

export type PlaceOptionOrderArgs = {
  optionSymbol: string;
  side: 'buy' | 'sell';
  qty: number;
  orderType: 'limit' | 'market';
  limitPrice?: number;
  timeInForce?: 'day' | 'gtc';
  // 'opening' for sell-to-open (CC, CSP); 'closing' for buy-to-close (not
  // used in v1 but plumbed for future).
  positionIntent: 'opening' | 'closing';
};

export async function placeOptionOrder(args: PlaceOptionOrderArgs) {
  const body: Record<string, unknown> = {
    symbol: args.optionSymbol,
    side: args.side,
    qty: String(args.qty),
    type: args.orderType,
    time_in_force: args.timeInForce ?? 'day',
    position_intent: args.positionIntent === 'opening' ? 'buy_to_open' : 'buy_to_close',
  };
  // Alpaca uses these intent values: buy_to_open, sell_to_open, buy_to_close, sell_to_close.
  // v1 only sells to open (CC, CSP), so derive from args.side + args.positionIntent.
  if (args.side === 'sell' && args.positionIntent === 'opening') body.position_intent = 'sell_to_open';
  if (args.side === 'sell' && args.positionIntent === 'closing') body.position_intent = 'sell_to_close';
  if (args.side === 'buy' && args.positionIntent === 'opening') body.position_intent = 'buy_to_open';
  if (args.side === 'buy' && args.positionIntent === 'closing') body.position_intent = 'buy_to_close';
  if (args.limitPrice != null) body.limit_price = String(args.limitPrice);
  const res = await fetch(`${tradingBase()}/v2/orders`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`alpaca option order ${res.status}: ${txt.slice(0, 300)}`);
  }
  return (await res.json()) as { id: string; status: string; symbol: string };
}

// Parse an OCC-format option symbol into its components. Example:
//   AAPL250117C00200000 → { underlying: 'AAPL', expiration: '2025-01-17',
//                            type: 'call', strike: 200 }
// Returns null if the input doesn't match the expected grammar.
export function parseOccSymbol(sym: string): {
  underlying: string;
  expiration: string;
  type: 'call' | 'put';
  strike: number;
} | null {
  // Underlying: 1-6 alphanum (covers SPX, BRK.B rarely appears since broker
  // uses different notation for share classes in options, but handle dots
  // defensively). Then YY MM DD, C/P, and 8-digit strike × 1000.
  const m = sym.match(/^([A-Z0-9]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  return {
    underlying: m[1],
    expiration: `20${m[2]}-${m[3]}-${m[4]}`,
    type: m[5] === 'C' ? 'call' : 'put',
    strike: parseInt(m[6], 10) / 1000,
  };
}
