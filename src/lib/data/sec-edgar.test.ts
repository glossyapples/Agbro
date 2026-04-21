// Unit tests for the XBRL extractor. The fixture mirrors real SEC
// `companyfacts` shape (verified against AAPL's actual endpoint) — what
// matters is that given a well-formed companyfacts blob the extractor pulls
// out correct EPS / equity / debt / ROE / gross margin / EPS CAGR.
//
// The network-fetching helpers are NOT tested here; they're thin wrappers
// around `fetch`. We test the pure parser, which is where real bugs live.

import { describe, it, expect } from 'vitest';
import { extractFundamentals } from './sec-edgar';

const fixture = {
  cik: 320193,
  entityName: 'Test Corp',
  facts: {
    'us-gaap': {
      EarningsPerShareBasic: {
        units: {
          'USD/shares': [
            { end: '2019-12-31', val: 2.5, fy: 2019, fp: 'FY', form: '10-K', filed: '2020-01-15' },
            { end: '2020-12-31', val: 3.0, fy: 2020, fp: 'FY', form: '10-K', filed: '2021-01-15' },
            { end: '2021-12-31', val: 3.6, fy: 2021, fp: 'FY', form: '10-K', filed: '2022-01-15' },
            { end: '2022-12-31', val: 4.4, fy: 2022, fp: 'FY', form: '10-K', filed: '2023-01-15' },
            { end: '2023-12-31', val: 5.3, fy: 2023, fp: 'FY', form: '10-K', filed: '2024-01-15' },
            { end: '2024-12-31', val: 6.1, fy: 2024, fp: 'FY', form: '10-K', filed: '2025-01-15' },
          ],
        },
      },
      Revenues: {
        units: { USD: [{ end: '2024-12-31', val: 100_000_000_000, fy: 2024, form: '10-K' }] },
      },
      CostOfRevenue: {
        units: { USD: [{ end: '2024-12-31', val: 55_000_000_000, fy: 2024, form: '10-K' }] },
      },
      NetIncomeLoss: {
        units: { USD: [{ end: '2024-12-31', val: 20_000_000_000, fy: 2024, form: '10-K' }] },
      },
      StockholdersEquity: {
        units: { USD: [{ end: '2024-12-31', val: 80_000_000_000, fy: 2024, form: '10-K' }] },
      },
      LongTermDebt: {
        units: { USD: [{ end: '2024-12-31', val: 30_000_000_000, fy: 2024, form: '10-K' }] },
      },
      CommonStockSharesOutstanding: {
        units: { shares: [{ end: '2024-12-31', val: 4_000_000_000, fy: 2024, form: '10-K' }] },
      },
      CommonStockDividendsPerShareDeclared: {
        units: { 'USD/shares': [{ end: '2024-12-31', val: 1.0, fy: 2024, form: '10-K' }] },
      },
    },
  },
};

describe('extractFundamentals', () => {
  const snap = extractFundamentals('TEST', '0000320193', fixture as never);

  it('pulls EPS from the latest 10-K', () => {
    expect(snap.epsTTM).toBe(6.1);
  });

  it('computes book value per share from equity / shares', () => {
    // 80B / 4B = $20
    expect(snap.bookValuePerShare).toBe(20);
  });

  it('computes ROE as net income / equity × 100', () => {
    // 20 / 80 = 25%
    expect(snap.returnOnEquityPct).toBe(25);
  });

  it('computes gross margin correctly', () => {
    // (100 - 55) / 100 = 45%
    expect(snap.grossMarginPct).toBe(45);
  });

  it('computes debt/equity', () => {
    // 30 / 80 = 0.375
    expect(snap.debtToEquity).toBeCloseTo(0.375, 3);
  });

  it('computes 5y EPS CAGR', () => {
    // 2.5 → 6.1 over 5 years = (6.1/2.5)^(1/5) - 1 ≈ 19.5%
    expect(snap.epsGrowthPct5y).toBeGreaterThan(19);
    expect(snap.epsGrowthPct5y).toBeLessThan(20);
  });

  it('pulls dividend per share', () => {
    expect(snap.dividendPerShare).toBe(1.0);
  });

  it('reports shares outstanding', () => {
    expect(snap.sharesOutstanding).toBe(4_000_000_000);
  });

  it('flags no missing fields for a complete filing', () => {
    expect(snap.missingFields).toEqual([]);
  });

  it('uses the latest filing end-date as asOf', () => {
    expect(snap.asOf).toBe('2024-12-31');
  });

  it('stamps source=edgar', () => {
    expect(snap.source).toBe('edgar');
  });
});

describe('extractFundamentals — resilience', () => {
  it('returns nulls + missingFields when tags are absent', () => {
    const empty = { cik: 0, entityName: 'X', facts: { 'us-gaap': {} } };
    const snap = extractFundamentals('NONE', '0', empty as never);
    expect(snap.epsTTM).toBeNull();
    expect(snap.totalEquity).toBeNull();
    expect(snap.returnOnEquityPct).toBeNull();
    expect(snap.missingFields.length).toBeGreaterThan(0);
  });

  it('returns null ROE when equity is zero (no division by zero)', () => {
    const weird = {
      cik: 0,
      entityName: 'X',
      facts: {
        'us-gaap': {
          NetIncomeLoss: {
            units: { USD: [{ end: '2024-12-31', val: 1_000_000, fy: 2024, form: '10-K' }] },
          },
          StockholdersEquity: {
            units: { USD: [{ end: '2024-12-31', val: 0, fy: 2024, form: '10-K' }] },
          },
        },
      },
    };
    const snap = extractFundamentals('X', '0', weird as never);
    expect(snap.returnOnEquityPct).toBeNull();
  });

  it('returns null CAGR when there is a sign change in the series', () => {
    const swung = {
      cik: 0,
      entityName: 'X',
      facts: {
        'us-gaap': {
          EarningsPerShareBasic: {
            units: {
              'USD/shares': [
                { end: '2019-12-31', val: -1.0, fy: 2019, form: '10-K' },
                { end: '2024-12-31', val: 3.0, fy: 2024, form: '10-K' },
              ],
            },
          },
        },
      },
    };
    const snap = extractFundamentals('X', '0', swung as never);
    expect(snap.epsGrowthPct5y).toBeNull();
  });
});
