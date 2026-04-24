// Phase 2 property tests on the fundamentals parser. The helpers
// tested here aren't exported for production use — they're internal to
// historical-fundamentals.ts, exported only so this test file can
// hit them. They're pure functions (no DB, no network) so property
// tests compose cleanly with Vitest.
//
// The regressions this guards against:
//   - duration classifier boundary drift (the fix that unblocked Visa's
//     Sept fiscal year). A property test over random durations pins
//     down the 80-100 / 350-380 boundaries.
//   - rollingTTM forward-fill invariant: for any filer whose 10-Q
//     window can't gather 4 quarters, the output still carries the
//     most recent annual value ≤ that 10-Q's filing date. The pre-fix
//     behaviour left epsTTM=null on every 10-Q for off-calendar filers.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  durationDays,
  isQuarterDuration,
  isAnnualDuration,
  rollingTTM,
  type Fact,
} from './historical-fundamentals';

// ─── Arbitraries ────────────────────────────────────────────────────────

// YYYY-MM-DD strings within a plausible EDGAR range. Using integer-ms
// instead of fc.date() because fast-check v4's date arbitrary can emit
// invalid-date sentinels that break toISOString().
const START_MS = new Date('2000-01-01').getTime();
const END_MS = new Date('2030-12-31').getTime();
const dateString = fc
  .integer({ min: START_MS, max: END_MS })
  .map((ms) => new Date(ms).toISOString().slice(0, 10));

function addDays(ymd: string, delta: number): string {
  return new Date(new Date(`${ymd}T00:00:00Z`).getTime() + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// A Fact whose start + end are valid and end >= start.
const factArb: fc.Arbitrary<Fact> = fc
  .record({
    end: dateString,
    duration: fc.integer({ min: 0, max: 500 }),
    val: fc.float({ min: Math.fround(-10_000), max: Math.fround(10_000), noNaN: true }),
    fp: fc.option(fc.constantFrom('Q1', 'Q2', 'Q3', 'Q4', 'FY')),
    form: fc.option(fc.constantFrom('10-Q', '10-K')),
    filed: dateString,
    fy: fc.option(fc.integer({ min: 1990, max: 2030 })),
  })
  .map((r) => ({
    end: r.end,
    start: addDays(r.end, -r.duration),
    val: r.val,
    fp: r.fp ?? undefined,
    form: r.form ?? undefined,
    filed: r.filed,
    fy: r.fy ?? undefined,
  }));

// Quarter-shaped Fact: 80-100 day duration exactly.
const quarterFactArb = fc
  .record({
    end: dateString,
    duration: fc.integer({ min: 80, max: 100 }),
    val: fc.float({ min: Math.fround(-1_000), max: Math.fround(1_000), noNaN: true }),
    filed: dateString,
  })
  .map(
    (r): Fact => ({
      end: r.end,
      start: addDays(r.end, -r.duration),
      val: r.val,
      filed: r.filed,
    })
  );

// Annual-shaped Fact: 350-380 day duration exactly.
const annualFactArb = fc
  .record({
    end: dateString,
    duration: fc.integer({ min: 350, max: 380 }),
    val: fc.float({ min: Math.fround(-5_000), max: Math.fround(5_000), noNaN: true }),
    filed: dateString,
  })
  .map(
    (r): Fact => ({
      end: r.end,
      start: addDays(r.end, -r.duration),
      val: r.val,
      filed: r.filed,
    })
  );

// ─── durationDays ────────────────────────────────────────────────────────

describe('durationDays (property)', () => {
  it('returns null when start is missing', () => {
    fc.assert(
      fc.property(dateString, (end) => {
        const f: Fact = { end, val: 1, filed: end };
        expect(durationDays(f)).toBeNull();
      })
    );
  });

  it('is non-negative when end >= start', () => {
    fc.assert(
      fc.property(factArb, (f) => {
        const d = durationDays(f);
        if (d != null) expect(d).toBeGreaterThanOrEqual(0);
      })
    );
  });

  it('matches the constructed duration (round-trip)', () => {
    fc.assert(
      fc.property(
        dateString,
        fc.integer({ min: 0, max: 500 }),
        (end, duration) => {
          const f: Fact = { end, start: addDays(end, -duration), val: 1, filed: end };
          expect(durationDays(f)).toBe(duration);
        }
      )
    );
  });
});

// ─── Duration classifiers ────────────────────────────────────────────────

describe('isQuarterDuration / isAnnualDuration (property)', () => {
  it('classifiers are disjoint — no fact is both quarter AND annual', () => {
    fc.assert(
      fc.property(factArb, (f) => {
        const q = isQuarterDuration(f);
        const a = isAnnualDuration(f);
        expect(q && a).toBe(false);
      })
    );
  });

  it('quarter range is exactly 80..100 days inclusive', () => {
    fc.assert(
      fc.property(quarterFactArb, (f) => {
        expect(isQuarterDuration(f)).toBe(true);
        expect(isAnnualDuration(f)).toBe(false);
      })
    );
    // Negative checks — 79 days out, 101 days out, 350 days in annual.
    fc.assert(
      fc.property(dateString, (end) => {
        expect(isQuarterDuration({ end, start: addDays(end, -79), val: 1, filed: end })).toBe(false);
        expect(isQuarterDuration({ end, start: addDays(end, -101), val: 1, filed: end })).toBe(false);
      })
    );
  });

  it('annual range is exactly 350..380 days inclusive', () => {
    fc.assert(
      fc.property(annualFactArb, (f) => {
        expect(isAnnualDuration(f)).toBe(true);
        expect(isQuarterDuration(f)).toBe(false);
      })
    );
    fc.assert(
      fc.property(dateString, (end) => {
        expect(isAnnualDuration({ end, start: addDays(end, -349), val: 1, filed: end })).toBe(false);
        expect(isAnnualDuration({ end, start: addDays(end, -381), val: 1, filed: end })).toBe(false);
      })
    );
  });

  it('half-year (6mo YTD ~180d) is neither quarter nor annual — the silent-drop surface', () => {
    // Visa + other off-calendar filers report YTD cumulatives at ~180d
    // and ~270d. These must fall in neither bucket; rollingTTM relies on
    // that so the forward-fill path correctly handles them.
    fc.assert(
      fc.property(
        dateString,
        fc.integer({ min: 160, max: 200 }),
        (end, duration) => {
          const f: Fact = { end, start: addDays(end, -duration), val: 1, filed: end };
          expect(isQuarterDuration(f)).toBe(false);
          expect(isAnnualDuration(f)).toBe(false);
        }
      )
    );
  });

  it('neither classifier ever throws on malformed input', () => {
    fc.assert(
      fc.property(
        fc.record({
          end: fc.string(),
          start: fc.option(fc.string()),
          val: fc.oneof(fc.float(), fc.constant(Number.NaN)),
          filed: fc.string(),
        }),
        (r) => {
          const f: Fact = {
            end: r.end,
            start: r.start ?? undefined,
            val: r.val,
            filed: r.filed,
          };
          // These must return booleans, not throw.
          expect(typeof isQuarterDuration(f)).toBe('boolean');
          expect(typeof isAnnualDuration(f)).toBe('boolean');
        }
      )
    );
  });
});

// ─── rollingTTM ──────────────────────────────────────────────────────────

describe('rollingTTM (property)', () => {
  it('empty input yields empty output', () => {
    expect(rollingTTM([]).size).toBe(0);
  });

  it('only-annual input: every annual filing date is a key', () => {
    fc.assert(
      fc.property(fc.array(annualFactArb, { minLength: 1, maxLength: 10 }), (annuals) => {
        const out = rollingTTM(annuals);
        // Every distinct `filed` should map to some value.
        const filedDates = new Set(annuals.map((a) => a.filed));
        for (const f of filedDates) {
          expect(out.has(f)).toBe(true);
        }
      })
    );
  });

  it('idempotent — calling twice produces identical output', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(quarterFactArb, annualFactArb), { minLength: 0, maxLength: 20 }),
        (facts) => {
          const once = rollingTTM(facts);
          const twice = rollingTTM(facts);
          expect([...once.entries()].sort()).toEqual([...twice.entries()].sort());
        }
      )
    );
  });

  it('forward-fill — when only annuals exist, a Q with no 4-window inherits the most recent annual ≤ its filed date', () => {
    // This is the Visa fix. Construct a scenario: one annual filed early,
    // one quarterly filed later with no other quarters around it. The
    // quarterly should inherit the annual's value.
    fc.assert(
      fc.property(
        dateString,
        fc.integer({ min: 30, max: 300 }),
        fc.float({ min: Math.fround(0.1), max: Math.fround(100), noNaN: true }),
        (annualEnd, daysToQuarterFiling, annualVal) => {
          const annual: Fact = {
            end: annualEnd,
            start: addDays(annualEnd, -365),
            val: annualVal,
            filed: addDays(annualEnd, 30), // filed 30 days after year-end (typical 10-K lag)
          };
          const quarterEnd = addDays(annualEnd, daysToQuarterFiling);
          const quarter: Fact = {
            end: quarterEnd,
            start: addDays(quarterEnd, -90),
            val: 999, // unused — the Q alone can't make a 4-window
            filed: addDays(quarterEnd, 45),
          };
          const out = rollingTTM([annual, quarter]);
          // Quarter's filing date should carry the annual's value via
          // forward-fill (the annual was filed before the quarter).
          expect(out.get(quarter.filed)).toBe(annualVal);
          // Annual's filed date gets the annual's own value.
          expect(out.get(annual.filed)).toBe(annualVal);
        }
      )
    );
  });

  it('output key count never exceeds input size', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(quarterFactArb, annualFactArb), { minLength: 0, maxLength: 50 }),
        (facts) => {
          const out = rollingTTM(facts);
          expect(out.size).toBeLessThanOrEqual(facts.length);
        }
      )
    );
  });
});
