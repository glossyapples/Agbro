import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { classifyBudgetState, startOfMonthUtc } from './budget';

describe('classifyBudgetState', () => {
  it('returns "disabled" when budget is null', () => {
    expect(
      classifyBudgetState({ mtdUsd: 100, budgetUsd: null, alarmThresholdPct: 80 })
    ).toBe('disabled');
  });

  it('returns "disabled" when budget is 0 or negative', () => {
    expect(
      classifyBudgetState({ mtdUsd: 0, budgetUsd: 0, alarmThresholdPct: 80 })
    ).toBe('disabled');
    expect(
      classifyBudgetState({ mtdUsd: 10, budgetUsd: -5, alarmThresholdPct: 80 })
    ).toBe('disabled');
  });

  it('"ok" below the alarm line', () => {
    expect(
      classifyBudgetState({ mtdUsd: 30, budgetUsd: 50, alarmThresholdPct: 80 })
    ).toBe('ok');
  });

  it('"warning" at or above the alarm line but under 100%', () => {
    // 80% of 50 = 40
    expect(
      classifyBudgetState({ mtdUsd: 40, budgetUsd: 50, alarmThresholdPct: 80 })
    ).toBe('warning');
    expect(
      classifyBudgetState({ mtdUsd: 49.99, budgetUsd: 50, alarmThresholdPct: 80 })
    ).toBe('warning');
  });

  it('"exceeded" at or above 100%', () => {
    expect(
      classifyBudgetState({ mtdUsd: 50, budgetUsd: 50, alarmThresholdPct: 80 })
    ).toBe('exceeded');
    expect(
      classifyBudgetState({ mtdUsd: 200, budgetUsd: 50, alarmThresholdPct: 80 })
    ).toBe('exceeded');
  });

  it('property: state is always monotone in mtdUsd', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(1), max: Math.fround(500), noNaN: true }),
        fc.float({ min: Math.fround(1), max: Math.fround(99), noNaN: true }),
        fc.float({ min: 0, max: Math.fround(10_000), noNaN: true }),
        fc.float({ min: 0, max: Math.fround(1_000), noNaN: true }),
        (budgetUsd, alarmThresholdPct, mtdA, mtdB) => {
          const [lo, hi] = mtdA < mtdB ? [mtdA, mtdB] : [mtdB, mtdA];
          const rank = (s: 'disabled' | 'ok' | 'warning' | 'exceeded') =>
            s === 'disabled' ? 0 : s === 'ok' ? 1 : s === 'warning' ? 2 : 3;
          const a = classifyBudgetState({ mtdUsd: lo, budgetUsd, alarmThresholdPct });
          const b = classifyBudgetState({ mtdUsd: hi, budgetUsd, alarmThresholdPct });
          expect(rank(b)).toBeGreaterThanOrEqual(rank(a));
        }
      )
    );
  });
});

describe('startOfMonthUtc', () => {
  it('snaps to UTC 1st-of-month at 00:00', () => {
    const mid = Date.UTC(2026, 3, 15, 13, 45, 7); // April 15 2026 13:45:07 UTC
    const som = startOfMonthUtc(mid);
    expect(som.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('handles Jan 1 (month boundary edge)', () => {
    const first = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(startOfMonthUtc(first).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
