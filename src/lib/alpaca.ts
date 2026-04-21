// Alpaca Markets wrapper. Paper trading by default; live only when
// ALPACA_PAPER === "false" AND the account is not paused/stopped.

import Alpaca from '@alpacahq/alpaca-trade-api';

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
    console.error('alpaca.cancelOrder failed', { orderId }, err);
    return false;
  }
}

export async function isMarketOpen(): Promise<boolean> {
  const a = getAlpaca();
  const clock = await a.getClock();
  return Boolean(clock.is_open);
}
