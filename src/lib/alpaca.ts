// Alpaca Markets wrapper. Paper trading by default; live only when
// ALPACA_PAPER === "false" AND the account is not paused/stopped.

import Alpaca from '@alpacahq/alpaca-trade-api';
import { log } from '@/lib/logger';

let _client: Alpaca | null = null;

export function getAlpaca(): Alpaca {
  if (_client) return _client;
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  const paper = (process.env.ALPACA_PAPER ?? 'true') !== 'false';
  if (!keyId || !secretKey) {
    throw new Error('Alpaca credentials missing. Set ALPACA_KEY_ID and ALPACA_SECRET_KEY.');
  }
  _client = new Alpaca({
    keyId,
    secretKey,
    paper,
    feed: 'iex',
  });
  return _client;
}

export type BrokerAccount = {
  cashCents: bigint;
  portfolioValueCents: bigint;
  equityCents: bigint;
  buyingPowerCents: bigint;
  daytradeCount: number;
};

const dollarsToCents = (x: string | number): bigint =>
  BigInt(Math.round(Number(x) * 100));

export async function getBrokerAccount(): Promise<BrokerAccount> {
  const a = getAlpaca();
  const acct = await a.getAccount();
  return {
    cashCents: dollarsToCents(acct.cash),
    portfolioValueCents: dollarsToCents(acct.portfolio_value),
    equityCents: dollarsToCents(acct.equity),
    buyingPowerCents: dollarsToCents(acct.buying_power),
    daytradeCount: Number(acct.daytrade_count ?? 0),
  };
}

export async function getPositions() {
  const a = getAlpaca();
  return a.getPositions();
}

export async function getLatestPrice(symbol: string): Promise<number | null> {
  const a = getAlpaca();
  try {
    const quote = await a.getLatestTrade(symbol);
    const price = (quote as { Price?: number; price?: number })?.Price ?? (quote as { price?: number })?.price;
    return price ?? null;
  } catch {
    return null;
  }
}

export type PlaceOrderArgs = {
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  orderType?: 'market' | 'limit';
  limitPrice?: number;
  timeInForce?: 'day' | 'gtc';
};

export async function placeOrder(args: PlaceOrderArgs) {
  const a = getAlpaca();
  return a.createOrder({
    symbol: args.symbol,
    qty: args.qty,
    side: args.side,
    type: args.orderType ?? 'market',
    time_in_force: args.timeInForce ?? 'day',
    limit_price: args.limitPrice,
  });
}

export async function cancelAllOrders() {
  const a = getAlpaca();
  return a.cancelAllOrders();
}

// Best-effort cancel by Alpaca order ID. Used when a DB write fails after a
// successful order submission so we don't leave a phantom order at the broker.
export async function cancelOrder(orderId: string): Promise<boolean> {
  const a = getAlpaca();
  try {
    await a.cancelOrder(orderId);
    return true;
  } catch (err) {
    log.error('alpaca.cancel_order_failed', err, { orderId });
    return false;
  }
}

export async function isMarketOpen(): Promise<boolean> {
  const a = getAlpaca();
  const clock = await a.getClock();
  return Boolean(clock.is_open);
}

// ─── Performance charting ────────────────────────────────────────────────
// Alpaca exposes the exact equity-over-time series it shows in its own UI
// via /v2/account/portfolio/history. We read from there (instead of
// snapshotting ourselves) because the broker is the source of truth for
// unrealized P&L and intraday marks.

export type PortfolioHistoryPoint = {
  timestampMs: number;
  equity: number;
  profitLoss: number;
  profitLossPct: number;
};

export type PortfolioHistoryRange = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | 'ALL';

// Alpaca period strings and bar timeframe for each UX range. YTD isn't a
// native Alpaca period, so we compute the start date ourselves and request
// a date-bounded history instead.
// Alpaca rejects period/timeframe pairs that produce too many bars
// (returns 422). 1M with 1H bars is over the limit; drop to 1D bars
// for any range >= 1M. The drawdown safety rail only needs daily
// granularity over a 30-day window, so this is no functional loss
// — and it's what kept the agent silent for two weeks (every tick
// hit kill_switch:data_unavailable from the 422). 1W stays at 1H
// because that combination IS within Alpaca's bar-count cap.
const RANGE_PARAMS: Record<PortfolioHistoryRange, { period?: string; timeframe: string; ytd?: boolean }> = {
  '1D':  { period: '1D',  timeframe: '5Min'  },
  '1W':  { period: '1W',  timeframe: '1H'    },
  '1M':  { period: '1M',  timeframe: '1D'    },
  '3M':  { period: '3M',  timeframe: '1D'    },
  'YTD': {                 timeframe: '1D', ytd: true },
  '1Y':  { period: '1A',  timeframe: '1D'    },
  'ALL': { period: 'all', timeframe: '1D'    },
};

export async function getPortfolioHistory(
  range: PortfolioHistoryRange
): Promise<PortfolioHistoryPoint[]> {
  const a = getAlpaca();
  const cfg = RANGE_PARAMS[range];
  const params: Record<string, string | number | boolean> = {
    timeframe: cfg.timeframe,
    extended_hours: true,
  };
  if (cfg.period) params.period = cfg.period;
  if (cfg.ytd) {
    const now = new Date();
    const jan1 = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    params.date_start = jan1.toISOString().slice(0, 10);
  }
  // Alpaca SDK's getPortfolioHistory accepts a generic options object.
  const raw = (await (a as unknown as {
    getPortfolioHistory: (opts: Record<string, unknown>) => Promise<{
      timestamp: number[];
      equity: (number | null)[];
      profit_loss: (number | null)[];
      profit_loss_pct: (number | null)[];
      base_value?: number;
    }>;
  }).getPortfolioHistory(params));

  const n = raw.timestamp.length;
  const out: PortfolioHistoryPoint[] = [];
  for (let i = 0; i < n; i++) {
    const eq = raw.equity[i];
    if (eq == null) continue; // Alpaca sends nulls for gaps (weekends, halted)
    out.push({
      timestampMs: raw.timestamp[i] * 1000, // Alpaca returns seconds
      equity: eq,
      profitLoss: raw.profit_loss[i] ?? 0,
      profitLossPct: (raw.profit_loss_pct[i] ?? 0) * 100, // fraction → %
    });
  }
  return out;
}

// Historical bar fetcher — used for the SPY benchmark overlay. Uses the
// free Alpaca IEX feed; fine for a smoothed benchmark line.
export type Bar = { timestampMs: number; close: number };

export async function getBars(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number = Date.now()
): Promise<Bar[]> {
  const a = getAlpaca();
  const bars: Bar[] = [];
  // The SDK returns an async iterable of bars.
  const iter = (a as unknown as {
    getBarsV2: (sym: string, opts: Record<string, unknown>) => AsyncIterable<{
      Timestamp: string;
      ClosePrice: number;
    }>;
  }).getBarsV2(symbol, {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    timeframe,
    feed: 'iex',
    limit: 10000,
  });
  for await (const b of iter) {
    bars.push({ timestampMs: new Date(b.Timestamp).getTime(), close: b.ClosePrice });
  }
  return bars;
}

// ─── Account activities (dividends, interest, etc.) ─────────────────────
// Alpaca records cash events on /v2/account/activities. Used by the
// analytics attribution view to show "dividends earned" without needing a
// separate Dividend table on our side. One activity type at a time keeps
// the payload tight.

export type DividendActivity = {
  date: string;           // YYYY-MM-DD
  symbol: string | null;  // null for aggregated "CASH DIV" events on some rows
  netAmountCents: bigint; // positive = cash in
};

export async function getDividends(
  sinceDate?: string
): Promise<DividendActivity[]> {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!keyId || !secretKey) return [];
  const paper = (process.env.ALPACA_PAPER ?? 'true') !== 'false';
  const base = paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
  const qs = new URLSearchParams({
    activity_types: 'DIV',
    page_size: '100',
  });
  if (sinceDate) qs.set('date', sinceDate);
  try {
    const res = await fetch(`${base}/v2/account/activities?${qs.toString()}`, {
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secretKey,
      },
    });
    if (!res.ok) {
      log.warn('alpaca.dividends_failed', { status: res.status });
      return [];
    }
    const data = (await res.json()) as Array<{
      date?: string;
      symbol?: string | null;
      net_amount?: string;
    }>;
    return data
      .filter((r) => typeof r.net_amount === 'string')
      .map((r) => ({
        date: String(r.date ?? ''),
        symbol: r.symbol ?? null,
        netAmountCents: BigInt(Math.round(Number(r.net_amount) * 100)),
      }));
  } catch (err) {
    log.error('alpaca.dividends_exception', err);
    return [];
  }
}

// ─── Market calendar ─────────────────────────────────────────────────────
// Alpaca's /v2/calendar is free and authoritative for NYSE/NASDAQ trading
// days. We use it to know when the market is closed or closing early (July
// 3rd half-day, day after Thanksgiving, etc.) so the agent doesn't waste a
// wake-up trying to trade into a closed session.

export type MarketCalendarDay = {
  date: string; // 'YYYY-MM-DD'
  openTimeET: string; // 'HH:MM'
  closeTimeET: string; // 'HH:MM'
  sessionType: 'normal' | 'early_close' | 'closed';
};

// Typical US-equity hours. Anything shorter than this on a trading day is an
// early close (half-day around major holidays).
const NORMAL_CLOSE_ET = '16:00';

export async function getMarketCalendar(
  startDate: string,
  endDate: string
): Promise<MarketCalendarDay[]> {
  const a = getAlpaca();
  const raw = await (a as unknown as {
    getCalendar: (opts: { start: string; end: string }) => Promise<
      Array<{ date: string; open: string; close: string }>
    >;
  }).getCalendar({ start: startDate, end: endDate });
  return raw.map((r) => ({
    date: r.date,
    openTimeET: r.open,
    closeTimeET: r.close,
    sessionType: r.close < NORMAL_CLOSE_ET ? 'early_close' : 'normal',
  }));
}
