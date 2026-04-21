import { describe, it, expect } from 'vitest';
import { PlaceTradeInput, SizePositionInput, UpdateStockFundamentalsInput } from './schemas';

const validPlaceTrade = {
  symbol: 'AAPL',
  side: 'buy',
  qty: 10,
  orderType: 'market',
  bullCase: 'durable moat',
  bearCase: 'regulatory risk',
  thesis: 'long term compounder',
  confidence: 0.8,
  intrinsicValuePerShare: 200,
  marginOfSafetyPct: 25,
};

describe('PlaceTradeInput', () => {
  it('accepts a well-formed payload', () => {
    const r = PlaceTradeInput.safeParse(validPlaceTrade);
    expect(r.success).toBe(true);
  });

  it('rejects qty <= 0', () => {
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, qty: 0 }).success).toBe(false);
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, qty: -1 }).success).toBe(false);
  });

  it('rejects non-finite qty', () => {
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, qty: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, qty: Number.NaN }).success).toBe(false);
  });

  it('caps qty at 1,000,000', () => {
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, qty: 1_000_001 }).success).toBe(false);
  });

  it('rejects confidence outside [0,1]', () => {
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, confidence: -0.01 }).success).toBe(false);
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, confidence: 1.01 }).success).toBe(false);
  });

  it('accepts confidence at the edges (0 and 1)', () => {
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, confidence: 0 }).success).toBe(true);
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, confidence: 1 }).success).toBe(true);
  });

  it('rejects unknown side values', () => {
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, side: 'short' }).success).toBe(false);
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, side: '' }).success).toBe(false);
  });

  it('rejects unknown orderType values', () => {
    expect(
      PlaceTradeInput.safeParse({ ...validPlaceTrade, orderType: 'stop' }).success
    ).toBe(false);
  });

  it('accepts omitted orderType (defaulting is handled in the tool)', () => {
    const { orderType: _o, ...noType } = validPlaceTrade;
    expect(PlaceTradeInput.safeParse(noType).success).toBe(true);
  });

  it('rejects empty symbol and symbols over 12 chars', () => {
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, symbol: '' }).success).toBe(false);
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, symbol: 'A'.repeat(13) }).success).toBe(false);
  });

  it('rejects empty thesis / bullCase / bearCase', () => {
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, thesis: '' }).success).toBe(false);
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, bullCase: '' }).success).toBe(false);
    expect(PlaceTradeInput.safeParse({ ...validPlaceTrade, bearCase: '' }).success).toBe(false);
  });

  it('rejects negative intrinsicValuePerShare', () => {
    expect(
      PlaceTradeInput.safeParse({ ...validPlaceTrade, intrinsicValuePerShare: -1 }).success
    ).toBe(false);
  });

  it('rejects marginOfSafetyPct outside [-100, 100]', () => {
    expect(
      PlaceTradeInput.safeParse({ ...validPlaceTrade, marginOfSafetyPct: 200 }).success
    ).toBe(false);
    expect(
      PlaceTradeInput.safeParse({ ...validPlaceTrade, marginOfSafetyPct: -200 }).success
    ).toBe(false);
  });
});

describe('SizePositionInput', () => {
  it('accepts well-formed inputs', () => {
    expect(SizePositionInput.safeParse({ buffettScore: 80, confidence: 0.8 }).success).toBe(true);
  });

  it('rejects buffettScore outside [0, 100]', () => {
    expect(SizePositionInput.safeParse({ buffettScore: -1, confidence: 0.5 }).success).toBe(false);
    expect(SizePositionInput.safeParse({ buffettScore: 101, confidence: 0.5 }).success).toBe(false);
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(SizePositionInput.safeParse({ buffettScore: 80, confidence: -0.1 }).success).toBe(false);
    expect(SizePositionInput.safeParse({ buffettScore: 80, confidence: 1.1 }).success).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(SizePositionInput.safeParse({ buffettScore: 80 }).success).toBe(false);
    expect(SizePositionInput.safeParse({ confidence: 0.8 }).success).toBe(false);
  });
});

describe('UpdateStockFundamentalsInput', () => {
  it('accepts a minimal payload (just symbol)', () => {
    expect(UpdateStockFundamentalsInput.safeParse({ symbol: 'AAPL' }).success).toBe(true);
  });

  it('accepts a fully-populated payload', () => {
    const r = UpdateStockFundamentalsInput.safeParse({
      symbol: 'KO',
      peRatio: 25,
      pbRatio: 10,
      dividendYield: 3,
      payoutRatio: 70,
      debtToEquity: 1.7,
      returnOnEquity: 40,
      grossMarginPct: 60,
      fcfYieldPct: 4,
      moatScore: 90,
      buffettScore: 85,
      notes: 'Refreshed after earnings.',
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing symbol', () => {
    expect(UpdateStockFundamentalsInput.safeParse({ peRatio: 22 }).success).toBe(false);
  });

  it('rejects empty / oversized symbol', () => {
    expect(UpdateStockFundamentalsInput.safeParse({ symbol: '' }).success).toBe(false);
    expect(UpdateStockFundamentalsInput.safeParse({ symbol: 'A'.repeat(13) }).success).toBe(false);
  });

  it('rejects non-finite numeric fields', () => {
    expect(
      UpdateStockFundamentalsInput.safeParse({ symbol: 'X', peRatio: Number.POSITIVE_INFINITY }).success
    ).toBe(false);
    expect(
      UpdateStockFundamentalsInput.safeParse({ symbol: 'X', peRatio: Number.NaN }).success
    ).toBe(false);
  });

  it('rejects out-of-range scores', () => {
    expect(
      UpdateStockFundamentalsInput.safeParse({ symbol: 'X', moatScore: 101 }).success
    ).toBe(false);
    expect(
      UpdateStockFundamentalsInput.safeParse({ symbol: 'X', moatScore: -1 }).success
    ).toBe(false);
    expect(
      UpdateStockFundamentalsInput.safeParse({ symbol: 'X', buffettScore: 200 }).success
    ).toBe(false);
  });

  it('rejects non-integer scores', () => {
    expect(
      UpdateStockFundamentalsInput.safeParse({ symbol: 'X', moatScore: 50.5 }).success
    ).toBe(false);
  });

  it('rejects negative dividend yield', () => {
    expect(
      UpdateStockFundamentalsInput.safeParse({ symbol: 'X', dividendYield: -1 }).success
    ).toBe(false);
  });

  it('rejects oversized notes', () => {
    expect(
      UpdateStockFundamentalsInput.safeParse({ symbol: 'X', notes: 'a'.repeat(2_001) }).success
    ).toBe(false);
  });
});
