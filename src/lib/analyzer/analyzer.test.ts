import { describe, it, expect } from 'vitest';
import {
  analyze,
  buffettScore,
  dcfIntrinsic,
  dividendDiscountValue,
  grahamFormulaValue,
  grahamNumber,
  moatSignal,
  peFairValue,
  positionSizeCents,
  type AnalyzerInput,
} from './index';

const baseInput: AnalyzerInput = {
  symbol: 'TEST',
  price: 100,
  eps: 5,
  epsGrowthPct: 8,
  bookValuePerShare: 20,
  dividendPerShare: 2,
  fcfPerShare: 6,
  sharesOutstanding: 1_000_000,
  totalDebt: 1_000_000,
  totalEquity: 5_000_000,
  returnOnEquityPct: 20,
  grossMarginPct: 50,
  sector: 'Consumer Defensive',
};

describe('grahamNumber', () => {
  it('computes sqrt(22.5 * eps * bv) for positive inputs', () => {
    // sqrt(22.5 * 5 * 20) = sqrt(2250) ≈ 47.434
    expect(grahamNumber(5, 20)).toBeCloseTo(Math.sqrt(2250), 5);
  });

  it('returns null for non-positive eps or book value', () => {
    expect(grahamNumber(0, 20)).toBeNull();
    expect(grahamNumber(-1, 20)).toBeNull();
    expect(grahamNumber(5, 0)).toBeNull();
    expect(grahamNumber(5, -1)).toBeNull();
  });
});

describe('grahamFormulaValue', () => {
  it('applies eps * (8.5 + 2g) * 4.4/Y', () => {
    // 5 * (8.5 + 16) * 4.4 / 4.5 = 5 * 24.5 * 4.4 / 4.5 ≈ 119.78
    expect(grahamFormulaValue(5, 8, 4.5)).toBeCloseTo((5 * 24.5 * 4.4) / 4.5, 3);
  });

  it('floors bond yield at 1 to prevent div-by-zero blowups', () => {
    const atZero = grahamFormulaValue(5, 8, 0);
    const atOne = grahamFormulaValue(5, 8, 1);
    expect(atZero).toBe(atOne);
  });

  it('returns null when eps is non-positive', () => {
    expect(grahamFormulaValue(0, 8)).toBeNull();
    expect(grahamFormulaValue(-1, 8)).toBeNull();
  });
});

describe('dcfIntrinsic', () => {
  it('produces a positive present value for a healthy FCF stream', () => {
    const v = dcfIntrinsic(5, 8, 10, 2.5, 10);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(0);
  });

  it('returns null when discount rate <= terminal growth (invalid)', () => {
    expect(dcfIntrinsic(5, 8, 2, 2.5)).toBeNull();
    expect(dcfIntrinsic(5, 8, 2.5, 2.5)).toBeNull();
  });

  it('returns null for non-positive FCF per share', () => {
    expect(dcfIntrinsic(0, 8)).toBeNull();
    expect(dcfIntrinsic(-1, 8)).toBeNull();
  });

  it('higher growth yields higher intrinsic value', () => {
    const low = dcfIntrinsic(5, 3)!;
    const high = dcfIntrinsic(5, 10)!;
    expect(high).toBeGreaterThan(low);
  });
});

describe('dividendDiscountValue', () => {
  it('applies Gordon growth when r > g', () => {
    // 2 * (1 + 0.04) / (0.1 - 0.04) = 2.08 / 0.06 ≈ 34.67
    expect(dividendDiscountValue(2, 4, 10)).toBeCloseTo(2.08 / 0.06, 3);
  });

  it('returns null when r <= g (model undefined)', () => {
    expect(dividendDiscountValue(2, 10, 10)).toBeNull();
    expect(dividendDiscountValue(2, 12, 10)).toBeNull();
  });

  it('returns null for non-positive dividend', () => {
    expect(dividendDiscountValue(0, 4)).toBeNull();
    expect(dividendDiscountValue(-1, 4)).toBeNull();
  });
});

describe('peFairValue', () => {
  it('uses sector-specific fair P/E when known', () => {
    // Technology fair P/E is 22.
    expect(peFairValue(5, 'Technology')).toBe(110);
  });

  it('falls back to 15 for unknown / undefined sector', () => {
    expect(peFairValue(5, 'UnknownSector')).toBe(75);
    expect(peFairValue(5)).toBe(75);
  });

  it('returns null for non-positive eps', () => {
    expect(peFairValue(0, 'Technology')).toBeNull();
    expect(peFairValue(-1, 'Technology')).toBeNull();
  });
});

describe('moatSignal', () => {
  it('returns wide when ROE>=25, GM>=60, D/E<1', () => {
    expect(
      moatSignal({
        ...baseInput,
        returnOnEquityPct: 30,
        grossMarginPct: 65,
        totalDebt: 500_000,
        totalEquity: 5_000_000,
      })
    ).toBe('wide');
  });

  it('returns none for a weak fundamentals profile', () => {
    expect(
      moatSignal({
        ...baseInput,
        returnOnEquityPct: 5,
        grossMarginPct: 20,
        totalDebt: 10_000_000,
        totalEquity: 1_000_000,
      })
    ).toBe('none');
  });

  it('treats non-positive equity as infinite leverage (contributes 0 moat points)', () => {
    const result = moatSignal({
      ...baseInput,
      totalEquity: 0,
      returnOnEquityPct: 15,
      grossMarginPct: 40,
    });
    // ROE>=15 = 1, GM>=40 = 1, D/E Infinity → 0. Score = 2 → narrow.
    expect(result).toBe('narrow');
  });
});

describe('buffettScore', () => {
  it('rewards large margin of safety + wide moat + healthy ROE', () => {
    const s = buffettScore(
      { ...baseInput, returnOnEquityPct: 25, dividendPerShare: 2, totalDebt: 0, totalEquity: 5_000_000 },
      { marginOfSafetyPct: 50, moatSignal: 'wide' }
    );
    expect(s).toBeGreaterThanOrEqual(70);
  });

  it('clamps to 0..100', () => {
    const s = buffettScore(baseInput, { marginOfSafetyPct: -500, moatSignal: 'none' });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});

describe('analyze.verdict', () => {
  it('returns strong_buy for high score + high MOS', () => {
    const out = analyze({
      ...baseInput,
      price: 30, // deep discount vs intrinsic
      eps: 6,
      fcfPerShare: 7,
      bookValuePerShare: 30,
      returnOnEquityPct: 28,
      grossMarginPct: 65,
      totalDebt: 500_000,
      totalEquity: 5_000_000,
      dividendPerShare: 2,
    });
    expect(out.verdict).toBe('strong_buy');
    expect(out.marginOfSafetyPct).not.toBeNull();
    expect(out.marginOfSafetyPct!).toBeGreaterThanOrEqual(20);
  });

  it('returns avoid when overpriced with weak fundamentals', () => {
    const out = analyze({
      ...baseInput,
      price: 1000,
      eps: 0.5,
      fcfPerShare: 0.5,
      bookValuePerShare: 1,
      returnOnEquityPct: 4,
      grossMarginPct: 10,
      totalDebt: 10_000_000,
      totalEquity: 1_000_000,
      dividendPerShare: 0,
    });
    expect(out.verdict).toBe('avoid');
  });

  it('attaches an EPS warning when eps <= 0', () => {
    const out = analyze({ ...baseInput, eps: -1 });
    expect(out.warnings.some((w) => w.includes('EPS'))).toBe(true);
  });

  it('attaches a negative-equity warning when equity <= 0', () => {
    const out = analyze({ ...baseInput, totalEquity: 0 });
    expect(out.warnings.some((w) => w.includes('equity'))).toBe(true);
  });

  it('keeps MOS null when all intrinsic methods return null', () => {
    const out = analyze({
      ...baseInput,
      eps: -1, // nukes graham, grahamFormula, ddm input indirectly, peFV
      fcfPerShare: -1,
      bookValuePerShare: -1,
      dividendPerShare: -1,
    });
    expect(out.marginOfSafetyPct).toBeNull();
  });
});

describe('positionSizeCents', () => {
  const base = {
    portfolioValueCents: 10_000_00n, // $10,000
    cashCents: 10_000_00n,
    maxPositionPct: 15,
    minCashReservePct: 10,
  };

  it('returns 0 when buffettScore < 40', () => {
    expect(
      positionSizeCents({ ...base, buffettScore: 39, confidence: 1 })
    ).toBe(0n);
  });

  it('returns 0 when confidence < 0.5', () => {
    expect(
      positionSizeCents({ ...base, buffettScore: 80, confidence: 0.49 })
    ).toBe(0n);
  });

  it('caps allocation at maxPositionPct of portfolio', () => {
    const result = positionSizeCents({
      ...base,
      buffettScore: 100,
      confidence: 1,
    });
    // Cap = 15% of $10k = $1500 = 150_000 cents. Score*confidence = 1, cash reserve = 10% = $1000 → deployable = $9000.
    // min($1500, $9000 * 1) = $1500.
    expect(result).toBe(150_000n);
  });

  it('respects cash reserve and scales by score*confidence', () => {
    // Deployable = cash - reserve = 10_000 - 1_000 = 9_000. Scale = 0.5 * 0.8 = 0.4 → 3_600. Cap = 1_500.
    // min(1_500, 3_600) = 1_500.
    expect(
      positionSizeCents({ ...base, buffettScore: 50, confidence: 0.8 })
    ).toBe(150_000n);
  });

  it('shrinks when deployable cash is the binding constraint', () => {
    // Portfolio $10k but only $1,000 cash → reserve = $1,000, deployable = $0.
    expect(
      positionSizeCents({
        ...base,
        cashCents: 100_000n,
        buffettScore: 100,
        confidence: 1,
      })
    ).toBe(0n);
  });
});
