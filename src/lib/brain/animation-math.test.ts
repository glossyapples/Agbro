// Tests for the brain animation math. Pin the curve so future
// tweaks are deliberate (an accidental constant change shouldn't
// silently make every brain on every screen render 3× more
// synapses overnight).

import { describe, it, expect } from 'vitest';
import {
  synapseMultiplier,
  activityBurst,
  brainIntensity,
  activeSynapseCount,
  firingArcRate,
  IDLE_LEVEL,
  BURST_PEAK,
  BURST_DURATION_MS,
  MIN_SYNAPSES,
  MAX_SYNAPSES,
} from './animation-math';

describe('synapseMultiplier', () => {
  it('returns the floor for an empty brain (no entries)', () => {
    expect(synapseMultiplier(0)).toBe(0.4);
    expect(synapseMultiplier(-5)).toBe(0.4); // defensive
  });

  it('grows monotonically as entry count grows', () => {
    const values = [10, 50, 100, 200, 500].map(synapseMultiplier);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it('caps at 2.0 even for absurd entry counts', () => {
    expect(synapseMultiplier(10_000)).toBe(2.0);
    expect(synapseMultiplier(1_000_000)).toBe(2.0);
  });

  it('hits the documented curve points (within 0.05)', () => {
    // Pin the curve. If future tweaks shift these by more than
    // 0.05 the change is no longer "tuning" — it's a redesign and
    // should require updating this test deliberately.
    expect(synapseMultiplier(10)).toBeCloseTo(0.97, 1);
    expect(synapseMultiplier(50)).toBeCloseTo(1.34, 1);
    expect(synapseMultiplier(100)).toBeCloseTo(1.50, 1);
    expect(synapseMultiplier(200)).toBeCloseTo(1.67, 1);
  });
});

describe('activityBurst', () => {
  const NOW = new Date('2026-04-28T12:00:00Z');

  it('returns 0 when there is no recorded last run', () => {
    expect(activityBurst(null, NOW)).toBe(0);
  });

  it('returns 0 when the last run is past the burst window', () => {
    const old = new Date(NOW.getTime() - BURST_DURATION_MS - 1);
    expect(activityBurst(old, NOW)).toBe(0);
  });

  it('returns 0 when the last run is in the future (clock skew)', () => {
    const future = new Date(NOW.getTime() + 1000);
    expect(activityBurst(future, NOW)).toBe(0);
  });

  it('returns the peak immediately after a run', () => {
    expect(activityBurst(NOW, NOW)).toBeCloseTo(BURST_PEAK, 5);
  });

  it('decays monotonically over the window', () => {
    const samples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0].map((frac) => {
      const t = new Date(NOW.getTime() - frac * BURST_DURATION_MS);
      return activityBurst(t, NOW);
    });
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-9);
    }
    expect(samples[0]).toBeCloseTo(BURST_PEAK, 5);
    expect(samples[samples.length - 1]).toBeCloseTo(0, 5);
  });
});

describe('brainIntensity (the headline equation)', () => {
  const NOW = new Date('2026-04-28T12:00:00Z');

  it('= IDLE × multiplier when no recent run', () => {
    const i = brainIntensity({ entryCount: 100, lastRunAt: null, now: NOW });
    expect(i).toBeCloseTo(IDLE_LEVEL * synapseMultiplier(100), 5);
  });

  it('= (IDLE + PEAK) × multiplier on the instant of a run', () => {
    const i = brainIntensity({ entryCount: 100, lastRunAt: NOW, now: NOW });
    expect(i).toBeCloseTo((IDLE_LEVEL + BURST_PEAK) * synapseMultiplier(100), 5);
  });

  it('grows with entry count even when no recent activity', () => {
    const a = brainIntensity({ entryCount: 5, lastRunAt: null, now: NOW });
    const b = brainIntensity({ entryCount: 500, lastRunAt: null, now: NOW });
    expect(b).toBeGreaterThan(a * 2);
  });

  it('grows with recent activity even on a fresh brain', () => {
    const cold = brainIntensity({ entryCount: 5, lastRunAt: null, now: NOW });
    const hot = brainIntensity({ entryCount: 5, lastRunAt: NOW, now: NOW });
    expect(hot).toBeGreaterThan(cold);
  });
});

describe('activeSynapseCount', () => {
  it('clamps to the minimum on very low intensity', () => {
    expect(activeSynapseCount(0.01)).toBe(MIN_SYNAPSES);
  });

  it('clamps to the maximum on very high intensity', () => {
    expect(activeSynapseCount(100)).toBe(MAX_SYNAPSES);
  });

  it('returns roughly BASE_COUNT × intensity in the normal range', () => {
    expect(activeSynapseCount(1.0)).toBeGreaterThan(20);
    expect(activeSynapseCount(1.0)).toBeLessThan(40);
  });
});

describe('firingArcRate', () => {
  it('respects a minimum so even a dead brain shows the occasional spark', () => {
    expect(firingArcRate(0)).toBe(0.5);
    expect(firingArcRate(-1)).toBe(0.5);
  });

  it('grows with intensity', () => {
    const a = firingArcRate(0.5);
    const b = firingArcRate(2.0);
    expect(b).toBeGreaterThan(a);
  });
});
