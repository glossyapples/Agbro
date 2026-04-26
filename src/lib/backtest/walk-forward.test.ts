// Tests for the pure helpers in the walk-forward harness. The full
// runner runs simulations end-to-end and is exercised via integration
// tests / live runs from /backtest/walk-forward; what we pin here is
// the math that decides which windows exist and how consistent the
// strategy looks across them. Mutation-verifying the splitWindows
// off-by-one was an explicit acceptance criterion in the sprint plan.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { splitWindows, computeConsistency } from './walk-forward';

describe('splitWindows', () => {
  it('produces non-overlapping windows when stepMonths === windowMonths', () => {
    const ws = splitWindows(
      new Date('2015-01-01'),
      new Date('2024-12-31'),
      24,
      24
    );
    // 10 years / 2-year windows = 5 windows
    expect(ws.length).toBe(5);
    for (let i = 0; i < ws.length - 1; i++) {
      // The next window starts where the prior one ends (or after).
      expect(ws[i + 1].startISO >= ws[i].endISO).toBe(true);
    }
  });

  it('produces overlapping windows when stepMonths < windowMonths (the interesting case)', () => {
    const ws = splitWindows(
      new Date('2015-01-01'),
      new Date('2024-12-31'),
      24,
      12
    );
    // 24-month windows stepped 12 months → 9 windows from a 10-year span
    // (years 1-2, 2-3, …, 9-10).
    expect(ws.length).toBe(9);
    expect(ws[0]).toEqual({ startISO: '2015-01-01', endISO: '2017-01-01' });
    expect(ws[1]).toEqual({ startISO: '2016-01-01', endISO: '2018-01-01' });
    // Last window starts 2023-01 and would naturally end 2025-01;
    // clamped to totalEnd 2024-12-31. Still well within the 75%
    // threshold so kept.
    expect(ws[8]).toEqual({ startISO: '2023-01-01', endISO: '2024-12-31' });
  });

  it('clamps the final window when it would run past totalEnd (and keeps it if ≥ 75% length)', () => {
    // 12-month windows stepped 12, 47.5-month total span (Jan 2020 →
    // mid-Dec 2023). Final window 2023-01..2024-01 clamps to
    // 2023-12-15 = ~11.5 months, which is ≥ 9 (75% of 12) → kept.
    const ws = splitWindows(
      new Date('2020-01-01'),
      new Date('2023-12-15'),
      12,
      12
    );
    expect(ws.length).toBe(4);
    const last = ws[ws.length - 1];
    expect(last.endISO).toBe('2023-12-15');
  });

  it('drops the final window if it is < 75% of the requested length', () => {
    // Total span 25 months, 24-month windows stepped 12. The second
    // window would clamp to 13 months, which is < 18 (75% of 24).
    // Dropped.
    const ws = splitWindows(
      new Date('2020-01-01'),
      new Date('2022-02-01'),
      24,
      12
    );
    expect(ws.length).toBe(1);
    expect(ws[0]).toEqual({ startISO: '2020-01-01', endISO: '2022-01-01' });
  });

  it('returns one window covering the whole span when windowMonths > totalSpan', () => {
    const ws = splitWindows(
      new Date('2020-01-01'),
      new Date('2021-06-01'),
      36,
      12
    );
    expect(ws.length).toBe(1);
    expect(ws[0].startISO).toBe('2020-01-01');
    expect(ws[0].endISO).toBe('2021-06-01');
  });

  it('returns empty array when end <= start', () => {
    expect(
      splitWindows(new Date('2020-01-01'), new Date('2019-01-01'), 12, 12)
    ).toEqual([]);
    expect(
      splitWindows(new Date('2020-01-01'), new Date('2020-01-01'), 12, 12)
    ).toEqual([]);
  });

  it('rejects stepMonths <= 0 (would loop forever)', () => {
    expect(() =>
      splitWindows(new Date('2020-01-01'), new Date('2024-01-01'), 12, 0)
    ).toThrow(/stepMonths/);
    expect(() =>
      splitWindows(new Date('2020-01-01'), new Date('2024-01-01'), 12, -1)
    ).toThrow(/stepMonths/);
  });

  it('rejects windowMonths <= 0', () => {
    expect(() =>
      splitWindows(new Date('2020-01-01'), new Date('2024-01-01'), 0, 12)
    ).toThrow(/windowMonths/);
  });

  it('property: every window.start >= totalStart and window.end <= totalEnd', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2010, max: 2030 }),
        fc.integer({ min: 2, max: 60 }),
        fc.integer({ min: 6, max: 36 }),
        fc.integer({ min: 1, max: 12 }),
        (startYear, totalSpanMonths, windowMonths, stepMonths) => {
          fc.pre(stepMonths > 0 && windowMonths > 0);
          const start = new Date(Date.UTC(startYear, 0, 1));
          const end = new Date(Date.UTC(startYear, totalSpanMonths, 1));
          const ws = splitWindows(start, end, windowMonths, stepMonths);
          for (const w of ws) {
            expect(w.startISO >= start.toISOString().slice(0, 10)).toBe(true);
            expect(w.endISO <= end.toISOString().slice(0, 10)).toBe(true);
            // Sanity: end after start.
            expect(w.endISO > w.startISO).toBe(true);
          }
        }
      )
    );
  });

  it('property: windows advance monotonically (no duplicates, no backwards step)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2015, max: 2025 }),
        fc.integer({ min: 24, max: 120 }),
        fc.integer({ min: 12, max: 36 }),
        fc.integer({ min: 1, max: 24 }),
        (startYear, spanMonths, windowMonths, stepMonths) => {
          fc.pre(stepMonths > 0 && windowMonths > 0);
          const ws = splitWindows(
            new Date(Date.UTC(startYear, 0, 1)),
            new Date(Date.UTC(startYear, spanMonths, 1)),
            windowMonths,
            stepMonths
          );
          for (let i = 0; i < ws.length - 1; i++) {
            expect(ws[i + 1].startISO > ws[i].startISO).toBe(true);
          }
        }
      )
    );
  });
});

describe('computeConsistency', () => {
  it('returns 1 when fewer than 2 valid CAGRs', () => {
    expect(computeConsistency([])).toBe(1);
    expect(computeConsistency([12.3])).toBe(1);
    expect(computeConsistency([null, null, 8])).toBe(1);
  });

  it('returns 1 (or close) when every window has the same CAGR', () => {
    expect(computeConsistency([10, 10, 10, 10])).toBe(1);
    expect(computeConsistency([10, 10.001, 9.999])).toBeCloseTo(1, 2);
  });

  it('returns 0 when MAD is at least as large as the median', () => {
    // CAGRs 10 and -10: median 0, MAD 10, scaleFloor=5. ratio = 10/5 = 2 → clamped to 0.
    expect(computeConsistency([10, -10])).toBe(0);
  });

  it('punishes wild swings vs a stable run', () => {
    const stable = computeConsistency([12, 11, 13, 10, 12]);
    const wild = computeConsistency([12, 25, -8, 30, -15]);
    expect(stable).toBeGreaterThan(wild);
    expect(stable).toBeGreaterThan(0.5);
    expect(wild).toBeLessThan(0.5);
  });

  it('uses scaleFloor so near-zero medians do not blow up the metric', () => {
    // CAGRs 0.1, 0.2, 0.05 — all near zero. Without scaleFloor the
    // relative spread looks huge; with scaleFloor=5 it stays high.
    const score = computeConsistency([0.1, 0.2, 0.05, 0.15]);
    expect(score).toBeGreaterThan(0.95);
  });

  it('property: consistency is bounded in [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.option(
            fc.float({ min: Math.fround(-50), max: Math.fround(50), noNaN: true }),
            { nil: null }
          ),
          { minLength: 0, maxLength: 12 }
        ),
        (cagrs) => {
          const score = computeConsistency(cagrs);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        }
      )
    );
  });

  it('property: adding a window equal to the median never hurts the score', () => {
    // Pinning intuition — copying a "typical" data point shouldn't
    // make us look LESS consistent. (Adds an MAD-zero deviation
    // relative to the existing median, which can only pull MAD down.)
    fc.assert(
      fc.property(
        fc.array(
          fc.float({ min: Math.fround(-30), max: Math.fround(30), noNaN: true }),
          { minLength: 3, maxLength: 8 }
        ),
        (cagrs) => {
          const before = computeConsistency(cagrs);
          // Compute median manually to insert a copy.
          const sorted = [...cagrs].sort((a, b) => a - b);
          const median =
            sorted.length % 2 === 0
              ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
              : sorted[(sorted.length - 1) / 2];
          const after = computeConsistency([...cagrs, median]);
          // Allow for floating-point noise.
          expect(after).toBeGreaterThanOrEqual(before - 1e-9);
        }
      )
    );
  });
});
