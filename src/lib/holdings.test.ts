// Tests for the pure enrichment path. Bar fetching lives in two
// private helpers that we'd need to mock heavily to exercise through
// fetchStock/CryptoHoldings; pinning enrichPosition here covers the
// arithmetic that matters — market value, cost basis, P/L dollars
// and %, today's change — and keeps regressions loud.

import { describe, it, expect } from 'vitest';
import { enrichPosition } from './holdings';

describe('enrichPosition', () => {
  it('computes market value + cost basis + P/L from Alpaca strings', () => {
    const h = enrichPosition({
      symbol: 'AAPL',
      qty: '10',
      avg_entry_price: '150.00',
      current_price: '180.00',
      market_value: '1800.00',
      unrealized_pl: '300.00',
      unrealized_plpc: '0.20',
      lastday_price: '175.00',
      change_today: '0.0286',
    });
    expect(h.qty).toBe(10);
    expect(h.currentPrice).toBe(180);
    expect(h.avgEntryPrice).toBe(150);
    expect(h.marketValueCents).toBe(180_000n);
    expect(h.costBasisCents).toBe(150_000n);
    expect(h.unrealizedPlCents).toBe(30_000n);
    expect(h.unrealizedPlPct).toBeCloseTo(20, 2);
    // changeToday = (180-175)*10 = $50
    expect(h.changeTodayCents).toBe(5_000n);
    expect(h.changeTodayPct).toBeCloseTo(2.86, 2);
  });

  it('derives P/L from market value and cost basis when Alpaca omits it', () => {
    const h = enrichPosition({
      symbol: 'VOO',
      qty: '12',
      avg_entry_price: '650',
      current_price: '652',
      market_value: '7824',
    });
    // marketValue 7824, costBasis 12×650=7800, P/L 24
    expect(h.unrealizedPlCents).toBe(2_400n);
    expect(h.unrealizedPlPct).toBeCloseTo(24 / 7800 * 100, 3);
  });

  it('handles a zero-qty row without dividing by zero', () => {
    const h = enrichPosition({
      symbol: 'DROPPED',
      qty: '0',
      avg_entry_price: '100',
      current_price: '100',
    });
    expect(h.qty).toBe(0);
    expect(h.marketValueCents).toBe(0n);
    expect(h.costBasisCents).toBe(0n);
    expect(h.unrealizedPlPct).toBe(0);
    expect(h.changeTodayPct).toBe(0);
  });

  it('accepts pre-numeric fields (crypto path re-wraps without string cast)', () => {
    const h = enrichPosition({
      symbol: 'BTC/USD',
      qty: 0.02,
      avg_entry_price: 60_000,
      current_price: 65_000,
      market_value: 1_300,
    });
    expect(h.symbol).toBe('BTC/USD');
    expect(h.marketValueCents).toBe(130_000n);
    expect(h.costBasisCents).toBe(120_000n);
    expect(h.unrealizedPlCents).toBe(10_000n);
  });

  it('falls back to today-from-lastday when change_today is absent', () => {
    const h = enrichPosition({
      symbol: 'NKE',
      qty: '11.6',
      avg_entry_price: '100',
      current_price: '70',
      market_value: '812',
      lastday_price: '72',
    });
    // (70-72)*11.6 = -23.2
    expect(h.changeTodayCents).toBe(-2_320n);
    // (70-72)/72 ≈ -2.78%
    expect(h.changeTodayPct).toBeCloseTo(-2.78, 1);
  });

  it('handles a loss (negative P/L) without sign confusion', () => {
    const h = enrichPosition({
      symbol: 'WEN',
      qty: '113.46',
      avg_entry_price: '20',
      current_price: '14',
      market_value: '1588.44',
      unrealized_pl: '-680.76',
      unrealized_plpc: '-0.30',
    });
    expect(h.unrealizedPlCents).toBe(-68_076n);
    expect(h.unrealizedPlPct).toBeCloseTo(-30, 2);
  });
});
