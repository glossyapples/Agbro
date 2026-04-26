import { describe, it, expect } from 'vitest';
import {
  PlaceTradeInput,
  SizePositionInput,
  UpdateStockFundamentalsInput,
  AddToWatchlistInput,
} from './schemas';

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

  // Buy-specific gate: intrinsicValuePerShare + marginOfSafetyPct are
  // REQUIRED on buys (superRefine). Previously both were .optional() at
  // the field level despite the prompt saying required; this closed a
  // silent-bypass hole where buys could skip the MOS check.
  describe('buy-specific MOS gate (superRefine)', () => {
    it('rejects a buy missing intrinsicValuePerShare', () => {
      const { intrinsicValuePerShare: _iv, ...noIV } = validPlaceTrade;
      const r = PlaceTradeInput.safeParse(noIV);
      expect(r.success).toBe(false);
      if (!r.success) {
        const msg = r.error.issues.map((i) => i.message).join(' ');
        expect(msg).toMatch(/intrinsicValuePerShare|fair value/i);
      }
    });

    it('rejects a buy missing marginOfSafetyPct', () => {
      const { marginOfSafetyPct: _mos, ...noMOS } = validPlaceTrade;
      const r = PlaceTradeInput.safeParse(noMOS);
      expect(r.success).toBe(false);
      if (!r.success) {
        const msg = r.error.issues.map((i) => i.message).join(' ');
        expect(msg).toMatch(/marginOfSafetyPct|MOS|margin of safety/i);
      }
    });

    it('rejects a buy whose intrinsicValuePerShare is zero', () => {
      expect(
        PlaceTradeInput.safeParse({
          ...validPlaceTrade,
          intrinsicValuePerShare: 0,
        }).success
      ).toBe(false);
    });

    it('accepts a sell WITHOUT intrinsicValuePerShare', () => {
      const { intrinsicValuePerShare: _iv, marginOfSafetyPct: _m, ...base } = validPlaceTrade;
      const r = PlaceTradeInput.safeParse({ ...base, side: 'sell' });
      expect(r.success).toBe(true);
    });

    it('accepts a sell WITHOUT marginOfSafetyPct', () => {
      const { marginOfSafetyPct: _m, ...base } = validPlaceTrade;
      const r = PlaceTradeInput.safeParse({ ...base, side: 'sell' });
      expect(r.success).toBe(true);
    });

    it('accepts a buy at MOS=0 boundary (strategy rules enforce minimum separately)', () => {
      const r = PlaceTradeInput.safeParse({ ...validPlaceTrade, marginOfSafetyPct: 0 });
      expect(r.success).toBe(true);
    });

    it('accepts a buy at a NEGATIVE MOS — schema allows it, active strategy rejects via placeTradeTool', () => {
      // -10 = price is 10% ABOVE intrinsic. Schema accepts (-100..100 range);
      // the runtime gate in placeTradeTool rejects if MOS < strategy minimum.
      const r = PlaceTradeInput.safeParse({ ...validPlaceTrade, marginOfSafetyPct: -10 });
      expect(r.success).toBe(true);
    });
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

describe('AddToWatchlistInput', () => {
  const valid = {
    symbol: 'ASML',
    rationale:
      'Wide-moat lithography monopoly, 25%+ ROE compounder, EUV TAM still expanding. Trading 8% below historical multiple after capex cycle pause.',
    conviction: 0.82,
  };

  it('accepts a well-formed payload', () => {
    expect(AddToWatchlistInput.safeParse(valid).success).toBe(true);
  });

  it('rejects empty / oversized symbol', () => {
    expect(AddToWatchlistInput.safeParse({ ...valid, symbol: '' }).success).toBe(false);
    expect(AddToWatchlistInput.safeParse({ ...valid, symbol: 'A'.repeat(13) }).success).toBe(false);
  });

  it('requires a substantive rationale (≥20 chars)', () => {
    expect(AddToWatchlistInput.safeParse({ ...valid, rationale: '' }).success).toBe(false);
    expect(AddToWatchlistInput.safeParse({ ...valid, rationale: 'short' }).success).toBe(false);
    // Right at the threshold passes.
    expect(AddToWatchlistInput.safeParse({ ...valid, rationale: 'a'.repeat(20) }).success).toBe(true);
  });

  it('rejects rationale > 2000 chars (audit-trail bloat guard)', () => {
    expect(AddToWatchlistInput.safeParse({ ...valid, rationale: 'a'.repeat(2_001) }).success).toBe(false);
  });

  it('conviction must be in [0, 1]', () => {
    expect(AddToWatchlistInput.safeParse({ ...valid, conviction: -0.01 }).success).toBe(false);
    expect(AddToWatchlistInput.safeParse({ ...valid, conviction: 1.01 }).success).toBe(false);
    expect(AddToWatchlistInput.safeParse({ ...valid, conviction: 0 }).success).toBe(true);
    expect(AddToWatchlistInput.safeParse({ ...valid, conviction: 1 }).success).toBe(true);
  });

  it('all three fields are required', () => {
    const { symbol: _s, ...noSymbol } = valid;
    const { rationale: _r, ...noRationale } = valid;
    const { conviction: _c, ...noConviction } = valid;
    expect(AddToWatchlistInput.safeParse(noSymbol).success).toBe(false);
    expect(AddToWatchlistInput.safeParse(noRationale).success).toBe(false);
    expect(AddToWatchlistInput.safeParse(noConviction).success).toBe(false);
  });
});
