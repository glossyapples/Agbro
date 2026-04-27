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

describe('extractFundamentals — fiscal-period selection (TROX 89% gross-margin bug)', () => {
  // The pre-fix bug: a 10-K reports both the full-year value AND
  // sub-period values (Q4, prior-year comparatives, segment
  // breakdowns) for the same end date. The old picker did
  // `entries.filter(e => e.form === '10-K')` then reduced by max(end),
  // which could grab a quarterly COGS while keeping full-year
  // revenue — producing nonsense margins. Fixture mirrors what TROX
  // looks like in real EDGAR data: full-year COGS plus a smaller
  // quarterly entry, both with end='2024-12-31' and form='10-K'.
  const fixture = {
    cik: 12345,
    entityName: 'Tronox Test',
    facts: {
      'us-gaap': {
        Revenues: {
          units: {
            USD: [
              {
                end: '2024-12-31',
                val: 2_900_000_000,
                fy: 2024,
                fp: 'FY',
                form: '10-K',
                start: '2024-01-01',
              },
              // Q4 sub-period that also lives in the 10-K, same end date.
              {
                end: '2024-12-31',
                val: 720_000_000,
                fy: 2024,
                fp: 'Q4',
                form: '10-K',
                start: '2024-10-01',
              },
            ],
          },
        },
        // The bug case: pre-fix picker would happily pick the Q4
        // sub-period ($310M) instead of the full-year value ($2.4B)
        // because both have the same end date.
        CostOfRevenue: {
          units: {
            USD: [
              {
                end: '2024-12-31',
                val: 2_400_000_000,
                fy: 2024,
                fp: 'FY',
                form: '10-K',
                start: '2024-01-01',
              },
              {
                end: '2024-12-31',
                val: 310_000_000,
                fy: 2024,
                fp: 'Q4',
                form: '10-K',
                start: '2024-10-01',
              },
            ],
          },
        },
        // Balance-sheet item — instant fact, no `start`. Should still
        // resolve via the no-start fallback inside Tier 2.
        StockholdersEquity: {
          units: {
            USD: [
              { end: '2024-12-31', val: 1_420_000_000, fy: 2024, fp: 'FY', form: '10-K' },
            ],
          },
        },
        NetIncomeLoss: {
          units: {
            USD: [
              {
                end: '2024-12-31',
                val: -470_000_000,
                fy: 2024,
                fp: 'FY',
                form: '10-K',
                start: '2024-01-01',
              },
            ],
          },
        },
      },
    },
  };

  it('picks the full-year COGS, not the Q4 sub-period (the actual bug)', () => {
    const snap = extractFundamentals('TROX', '0001', fixture);
    // Pre-fix: $310M (Q4) → margin = (2.9B - 310M)/2.9B = 89%
    // Post-fix: $2.4B (FY) → margin = (2.9B - 2.4B)/2.9B = ~17%
    expect(snap.costOfRevenue).toBe(2_400_000_000);
    expect(snap.grossMarginPct).not.toBeNull();
    expect(snap.grossMarginPct!).toBeGreaterThan(15);
    expect(snap.grossMarginPct!).toBeLessThan(20);
  });

  it('falls back to ~365-day period when fp is missing (legacy filings)', () => {
    const legacy = {
      cik: 67890,
      entityName: 'Old Filing',
      facts: {
        'us-gaap': {
          Revenues: {
            units: {
              USD: [
                // No `fp` field — older filings sometimes omit it. The
                // ~365-day period should still qualify it as annual.
                {
                  end: '2020-12-31',
                  val: 100_000_000,
                  fy: 2020,
                  form: '10-K',
                  start: '2020-01-01',
                },
                // Quarterly sub-period without fp — should be rejected.
                {
                  end: '2020-12-31',
                  val: 26_000_000,
                  fy: 2020,
                  form: '10-K',
                  start: '2020-10-01',
                },
              ],
            },
          },
        },
      },
    };
    const snap = extractFundamentals('OLD', '0001', legacy);
    expect(snap.revenues).toBe(100_000_000);
  });

  it('handles instant facts (balance-sheet items) where start is absent', () => {
    // Equity is an "instant" fact — there's no period. Snapshot at a
    // point in time. The picker should accept these without trying to
    // measure period length.
    const snap = extractFundamentals('TROX', '0001', fixture);
    expect(snap.totalEquity).toBe(1_420_000_000);
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

// Regression test for the BRK.B bug: both Berkshire share classes file under
// one CIK, and EDGAR reports per-share metrics in A-class basis. Requesting
// BRK.B must divide per-share metrics by 1500 and multiply share count by
// 1500 so downstream valuation math isn't nonsensical.
describe('extractFundamentals — share-class override (BRK.B)', () => {
  // Minimal Berkshire-shaped fixture: EPS of $3,000 and ~943k shares
  // outstanding (A-class). BV per A-class share ≈ $700k. After B-class
  // adjustment: EPS $2, shares ~1.414B, BV/share ~$467.
  const berkshireFacts = {
    cik: 1067983,
    entityName: 'Berkshire Hathaway Inc.',
    facts: {
      'us-gaap': {
        EarningsPerShareBasic: {
          units: {
            'USD/shares': [
              { end: '2024-12-31', val: 3000, fy: 2024, form: '10-K' },
            ],
          },
        },
        NetIncomeLoss: {
          units: { USD: [{ end: '2024-12-31', val: 90_000_000_000, fy: 2024, form: '10-K' }] },
        },
        StockholdersEquity: {
          units: { USD: [{ end: '2024-12-31', val: 660_000_000_000, fy: 2024, form: '10-K' }] },
        },
        CommonStockSharesOutstanding: {
          units: { shares: [{ end: '2024-12-31', val: 943_000, fy: 2024, form: '10-K' }] },
        },
      },
    },
  };

  it('adjusts per-share metrics down by 1500 when ticker is BRK.B', () => {
    const snap = extractFundamentals('BRK.B', '1067983', berkshireFacts as never);
    // EPS: 3000 / 1500 = 2
    expect(snap.epsTTM).toBeCloseTo(2, 3);
    // Shares: 943k * 1500 = 1.4145B (now in B-equivalent count)
    expect(snap.sharesOutstanding).toBe(943_000 * 1500);
    // BV/share: 660B / 1.4145B ≈ $467
    expect(snap.bookValuePerShare).toBeCloseTo(660_000_000_000 / (943_000 * 1500), 1);
    // Company-level ROE is unchanged (90B / 660B ≈ 13.6%)
    expect(snap.returnOnEquityPct).toBeCloseTo((90 / 660) * 100, 1);
    // Shares-adjustment metadata must be present so auditors can see why
    expect(snap.shareClassAdjustment).toEqual({
      ratio: 1500,
      note: expect.stringContaining('B-class'),
    });
  });

  it('leaves per-share metrics unchanged for single-class tickers (AAPL)', () => {
    // Using the same fixture but as AAPL: no override, values pass through.
    const snap = extractFundamentals('AAPL', '320193', berkshireFacts as never);
    expect(snap.epsTTM).toBe(3000);
    expect(snap.sharesOutstanding).toBe(943_000);
    expect(snap.shareClassAdjustment).toBeUndefined();
  });

  it('handles the Alpaca dash form (BRK-B) identically to dot form (BRK.B)', () => {
    const snap = extractFundamentals('BRK-B', '1067983', berkshireFacts as never);
    expect(snap.epsTTM).toBeCloseTo(2, 3);
    expect(snap.shareClassAdjustment?.ratio).toBe(1500);
  });
});
