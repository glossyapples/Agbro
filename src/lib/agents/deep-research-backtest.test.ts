// Cost-estimate helper test. The actual agent network call is
// integration-tested by running the walk-forward against the
// agent_deep_research strategy with a real budget — that's the
// $50-300 spend the user's gating behind a confirmation step.

import { describe, it, expect } from 'vitest';
import { estimateAgentBacktestCost } from './deep-research-backtest';

describe('estimateAgentBacktestCost', () => {
  it('multiplies universe × windows for the call count', () => {
    const e = estimateAgentBacktestCost({ universeSize: 30, windowCount: 5 });
    expect(e.callCount).toBe(150);
  });

  it('returns midpoint at $1 per call (Opus high-effort central estimate)', () => {
    const e = estimateAgentBacktestCost({ universeSize: 30, windowCount: 5 });
    expect(e.midpointUsd).toBeCloseTo(150, 5);
    expect(e.perCallEstimateUsd).toBe(1);
  });

  it('low/high band brackets the midpoint at $0.50 / $2.00 per call', () => {
    const e = estimateAgentBacktestCost({ universeSize: 30, windowCount: 5 });
    expect(e.lowUsd).toBeCloseTo(75, 5);
    expect(e.highUsd).toBeCloseTo(300, 5);
  });

  it('handles empty universe', () => {
    const e = estimateAgentBacktestCost({ universeSize: 0, windowCount: 5 });
    expect(e.callCount).toBe(0);
    expect(e.midpointUsd).toBe(0);
  });

  it('handles negative inputs defensively (clamps to zero, no negative cost)', () => {
    const e = estimateAgentBacktestCost({ universeSize: -10, windowCount: 5 });
    expect(e.callCount).toBe(0);
    expect(e.midpointUsd).toBe(0);
  });

  it('scales linearly with universe size at fixed window count', () => {
    const a = estimateAgentBacktestCost({ universeSize: 10, windowCount: 5 });
    const b = estimateAgentBacktestCost({ universeSize: 50, windowCount: 5 });
    expect(b.midpointUsd).toBeCloseTo(a.midpointUsd * 5, 5);
  });

  it('scales linearly with window count at fixed universe size', () => {
    const a = estimateAgentBacktestCost({ universeSize: 30, windowCount: 1 });
    const b = estimateAgentBacktestCost({ universeSize: 30, windowCount: 7 });
    expect(b.midpointUsd).toBeCloseTo(a.midpointUsd * 7, 5);
  });
});
