import { describe, it, expect } from 'vitest';
import { summariseAgentRunCosts } from './runner';

// The cost-hallucination bug the partners used to cite ("2% drag on
// target" when the truth was 6.82%) lived in derived math the model
// was doing in its head. Precomputing drag in the briefing fixed it.
// These tests pin down the math so a refactor can't silently reintroduce
// a different derivation.

describe('summariseAgentRunCosts', () => {
  const runs = (costs: Array<number | null>) =>
    costs.map((c, i) => ({
      costUsd: c,
      startedAt: new Date(2026, 0, 1 + i),
      status: 'completed',
    }));

  it('returns zeros when no runs have cost data', () => {
    const r = summariseAgentRunCosts(runs([null, null, null]), 100_000, 30);
    expect(r.runCount).toBe(3);
    expect(r.weeklyTotalUsd).toBe(0);
    expect(r.avgPerRunUsd).toBe(0);
    expect(r.medianPerRunUsd).toBe(0);
    expect(r.maxPerRunUsd).toBe(0);
    expect(r.annualisedTotalUsd).toBe(0);
    expect(r.annualDragPctOfEquity).toBe(0);
    expect(r.annualDragPctOfExpectedReturn).toBe(0);
  });

  it('computes weekly total + avg + median + max', () => {
    const r = summariseAgentRunCosts(runs([0.1, 0.2, 0.3, 0.4]), 100_000, 30);
    expect(r.weeklyTotalUsd).toBeCloseTo(1.0, 4);
    expect(r.avgPerRunUsd).toBeCloseTo(0.25, 4);
    // Sorted [0.1, 0.2, 0.3, 0.4]; Math.floor(4/2) = 2 → 0.3.
    expect(r.medianPerRunUsd).toBeCloseTo(0.3, 4);
    expect(r.maxPerRunUsd).toBeCloseTo(0.4, 4);
    expect(r.runCount).toBe(4);
  });

  it('excludes null costs from avg/median/max but counts them in runCount', () => {
    const r = summariseAgentRunCosts(runs([0.2, null, 0.4, null]), 100_000, 30);
    expect(r.runCount).toBe(4); // includes nulls
    expect(r.weeklyTotalUsd).toBeCloseTo(0.6, 4);
    expect(r.avgPerRunUsd).toBeCloseTo(0.3, 4); // (0.2 + 0.4) / 2
    expect(r.maxPerRunUsd).toBeCloseTo(0.4, 4);
  });

  it('produces the canonical $39.37/wk on $100k @ 30% → 6.82% drag on target', () => {
    // This is THE numeric case the partners hallucinated wrong in a
    // prior comic. Pinning it down: $39.37/wk * 52 = $2,047.24/yr;
    // $100,100 equity; 30% target = $30,030 gain; drag = 2,047.24 /
    // 30,030 = 6.817...% → rounds to 6.82%. Drag on equity =
    // 2,047.24 / 100,100 = 2.045% → 2.05%.
    const weekly = 39.37;
    // Simulate 7 runs summing to the weekly total for clean input.
    const perRun = weekly / 7;
    const r = summariseAgentRunCosts(
      runs([perRun, perRun, perRun, perRun, perRun, perRun, perRun]),
      100_100,
      30
    );
    expect(r.weeklyTotalUsd).toBeCloseTo(39.37, 2);
    expect(r.annualisedTotalUsd).toBeCloseTo(39.37 * 52, 2);
    expect(r.annualDragPctOfEquity).toBeCloseTo(2.05, 1);
    expect(r.annualDragPctOfExpectedReturn).toBeCloseTo(6.82, 1);
  });

  it('returns 0 drag-on-equity when equity is 0 (division-by-zero guard)', () => {
    const r = summariseAgentRunCosts(runs([0.2, 0.3]), 0, 30);
    expect(r.annualDragPctOfEquity).toBe(0);
    expect(r.annualDragPctOfExpectedReturn).toBe(0);
  });

  it('returns 0 drag-on-expected when expectedAnnualReturnPct is 0', () => {
    const r = summariseAgentRunCosts(runs([0.2, 0.3]), 100_000, 0);
    // Drag-on-equity still computes; drag-on-expected needs a non-zero target.
    expect(r.annualDragPctOfEquity).toBeGreaterThan(0);
    expect(r.annualDragPctOfExpectedReturn).toBe(0);
  });

  it('rounds monetary outputs to 4 decimal places + percent outputs to 2', () => {
    const r = summariseAgentRunCosts(runs([0.123456789]), 100_000, 30);
    // Internal .toFixed(4) → 4 decimals max
    expect(r.weeklyTotalUsd.toString()).toMatch(/^0\.\d{1,4}$/);
    expect(r.avgPerRunUsd.toString()).toMatch(/^0\.\d{1,4}$/);
  });

  it('treats negative costUsd as bad data and filters it out', () => {
    // The underlying filter is `c >= 0`; a negative cost is either a
    // corrupt row or a refund concept we don't support. Better to
    // ignore than to let it skew the average down.
    const r = summariseAgentRunCosts(runs([0.2, -0.5, 0.3]), 100_000, 30);
    expect(r.weeklyTotalUsd).toBeCloseTo(0.5, 4);
    expect(r.avgPerRunUsd).toBeCloseTo(0.25, 4);
  });

  it('annualisation is simply weeklyTotal × 52', () => {
    const r = summariseAgentRunCosts(runs([1, 2, 3]), 100_000, 30);
    expect(r.annualisedTotalUsd).toBeCloseTo(r.weeklyTotalUsd * 52, 4);
  });

  it('drag-on-expected > drag-on-equity when expectedReturn < 100%', () => {
    // Intuitive invariant: if you're targeting X% returns and costs are
    // Y% of equity, costs as a fraction of EXPECTED GAIN = Y / X >= Y
    // whenever X < 1. This is exactly why the 6.82% number is what
    // partners should cite, not the 2.05%.
    const r = summariseAgentRunCosts(runs([0.5, 0.5]), 100_000, 30);
    expect(r.annualDragPctOfExpectedReturn).toBeGreaterThan(r.annualDragPctOfEquity);
  });
});
