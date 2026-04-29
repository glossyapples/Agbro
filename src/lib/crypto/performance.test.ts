// Pin the on-the-fly book-value reconstruction. The pure walker
// (buildBookValueAtTicks) is testable without any DB or HTTP mocking;
// it captures all the math that matters. The async wrapper
// (computeCryptoChart) is integration-tested by the live chart.

import { describe, it, expect } from 'vitest';
import {
  buildBookValueAtTicks,
  toAlpacaCryptoSymbol,
} from './performance';
import type { CryptoBar } from '@/lib/alpaca-crypto';

describe('toAlpacaCryptoSymbol', () => {
  it('passes slash form through unchanged', () => {
    expect(toAlpacaCryptoSymbol('BTC/USD')).toBe('BTC/USD');
    expect(toAlpacaCryptoSymbol('ETH/USDC')).toBe('ETH/USDC');
  });

  it('converts concat form to slash form', () => {
    expect(toAlpacaCryptoSymbol('BTCUSD')).toBe('BTC/USD');
    expect(toAlpacaCryptoSymbol('ETHUSD')).toBe('ETH/USD');
    expect(toAlpacaCryptoSymbol('SOLUSDT')).toBe('SOL/USDT');
    expect(toAlpacaCryptoSymbol('USDCUSD')).toBe('USDC/USD');
  });
});

describe('buildBookValueAtTicks', () => {
  function bar(t: number, close: number): CryptoBar {
    return { timestampMs: t, close };
  }

  it('returns zero before the first trade fills', () => {
    const ticks = [1000, 2000, 3000];
    const trades = [
      { symbol: 'BTC/USD', side: 'buy', qty: 0.5, submittedAtMs: 2500 },
    ];
    const bars = new Map([['BTC/USD', [bar(1000, 50_000), bar(2000, 60_000), bar(3000, 70_000)]]]);
    const out = buildBookValueAtTicks(ticks, trades, bars);
    expect(out).toEqual([0, 0, 0.5 * 70_000]);
  });

  it('tracks cumulative qty across multiple buys', () => {
    const ticks = [1000, 2000, 3000];
    const trades = [
      { symbol: 'BTC/USD', side: 'buy', qty: 0.5, submittedAtMs: 500 },
      { symbol: 'BTC/USD', side: 'buy', qty: 0.3, submittedAtMs: 1500 },
    ];
    const bars = new Map([['BTC/USD', [bar(1000, 50_000), bar(2000, 60_000), bar(3000, 70_000)]]]);
    const out = buildBookValueAtTicks(ticks, trades, bars);
    expect(out[0]).toBe(0.5 * 50_000);    // only first buy filled
    expect(out[1]).toBe(0.8 * 60_000);    // both filled now
    expect(out[2]).toBe(0.8 * 70_000);
  });

  it('subtracts qty on sells', () => {
    const ticks = [1000, 2000];
    const trades = [
      { symbol: 'BTC/USD', side: 'buy', qty: 1.0, submittedAtMs: 500 },
      { symbol: 'BTC/USD', side: 'sell', qty: 0.4, submittedAtMs: 1500 },
    ];
    const bars = new Map([['BTC/USD', [bar(1000, 50_000), bar(2000, 60_000)]]]);
    const out = buildBookValueAtTicks(ticks, trades, bars);
    expect(out[0]).toBe(1.0 * 50_000);
    expect(out[1]).toBe(0.6 * 60_000);
  });

  it('sums across multiple symbols', () => {
    const ticks = [1000, 2000];
    const trades = [
      { symbol: 'BTC/USD', side: 'buy', qty: 0.1, submittedAtMs: 500 },
      { symbol: 'ETH/USD', side: 'buy', qty: 2.0, submittedAtMs: 500 },
    ];
    const bars = new Map([
      ['BTC/USD', [bar(1000, 50_000), bar(2000, 60_000)]],
      ['ETH/USD', [bar(1000, 3_000), bar(2000, 3_500)]],
    ]);
    const out = buildBookValueAtTicks(ticks, trades, bars);
    expect(out[0]).toBe(0.1 * 50_000 + 2.0 * 3_000);
    expect(out[1]).toBe(0.1 * 60_000 + 2.0 * 3_500);
  });

  it('carries forward the last seen price when bars are sparse for a symbol', () => {
    // ETH only has a bar at the first tick; BTC has all three.
    const ticks = [1000, 2000, 3000];
    const trades = [
      { symbol: 'ETH/USD', side: 'buy', qty: 1.0, submittedAtMs: 500 },
    ];
    const bars = new Map([['ETH/USD', [bar(1000, 3_000)]]]);
    const out = buildBookValueAtTicks(ticks, trades, bars);
    expect(out).toEqual([3_000, 3_000, 3_000]);
  });

  it('returns zero for symbols with bars but no qty held', () => {
    const ticks = [1000];
    const trades: Array<{ symbol: string; side: string; qty: number; submittedAtMs: number }> = [];
    const bars = new Map([['BTC/USD', [bar(1000, 50_000)]]]);
    const out = buildBookValueAtTicks(ticks, trades, bars);
    expect(out).toEqual([0]);
  });

  it('handles a fully-closed position (sell zeroes the book contribution)', () => {
    const ticks = [1000, 2000, 3000];
    const trades = [
      { symbol: 'BTC/USD', side: 'buy', qty: 1.0, submittedAtMs: 500 },
      { symbol: 'BTC/USD', side: 'sell', qty: 1.0, submittedAtMs: 1500 },
    ];
    const bars = new Map([['BTC/USD', [bar(1000, 50_000), bar(2000, 60_000), bar(3000, 70_000)]]]);
    const out = buildBookValueAtTicks(ticks, trades, bars);
    expect(out[0]).toBe(50_000);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });
});
