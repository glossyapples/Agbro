// Pin the symbol-classification heuristic. The original slash-only check
// silently misclassified Alpaca paper-trading positions (which return
// "BTCUSD" rather than "BTC/USD"), making crypto rows show up in the
// stocks list and the crypto list look empty.

import { describe, it, expect } from 'vitest';
import { isCryptoSymbol } from './alpaca-crypto';

describe('isCryptoSymbol', () => {
  it('recognises slash-form crypto pairs', () => {
    expect(isCryptoSymbol('BTC/USD')).toBe(true);
    expect(isCryptoSymbol('ETH/USD')).toBe(true);
    expect(isCryptoSymbol('SOL/USDT')).toBe(true);
  });

  it('recognises legacy concat-form crypto pairs (the actual prod regression)', () => {
    expect(isCryptoSymbol('BTCUSD')).toBe(true);
    expect(isCryptoSymbol('ETHUSD')).toBe(true);
    expect(isCryptoSymbol('SOLUSD')).toBe(true);
    expect(isCryptoSymbol('DOGEUSD')).toBe(true);
    expect(isCryptoSymbol('SHIBUSDT')).toBe(true);
    expect(isCryptoSymbol('USDCUSD')).toBe(true);
  });

  it('does NOT misclassify common US equity tickers', () => {
    expect(isCryptoSymbol('AAPL')).toBe(false);
    expect(isCryptoSymbol('MSFT')).toBe(false);
    expect(isCryptoSymbol('GOOGL')).toBe(false);
    expect(isCryptoSymbol('VOO')).toBe(false);
    expect(isCryptoSymbol('SCHD')).toBe(false);
    expect(isCryptoSymbol('BRK.B')).toBe(false);
    expect(isCryptoSymbol('TSLA')).toBe(false);
  });

  it('does not match short tickers ending in USD (no plausible 1-char crypto base)', () => {
    expect(isCryptoSymbol('USD')).toBe(false);
  });
});
