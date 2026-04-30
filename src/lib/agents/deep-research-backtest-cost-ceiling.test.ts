// Pin the per-window cost-ceiling abort contract. The pure rank loop
// is testable without any LLM fixture by passing a stub `runOne`.

import { describe, it, expect, vi } from 'vitest';
import {
  rankUniverseByConviction,
  WindowCostExceededError,
  type BacktestPickResult,
} from './deep-research-backtest';

function fakeRunOne(costPerCall: number) {
  return vi.fn(
    async ({
      symbol,
    }: {
      symbol: string;
    }): Promise<BacktestPickResult> => ({
      symbol,
      decisionDateISO: '2024-01-01',
      output: {
        thesis: '',
        convictionScore: 50,
        bullCase: '',
        bearCase: '',
        summary: '',
        killCriteria: [],
        primaryRisks: [],
      },
      costUsd: costPerCall,
      durationMs: 100,
    })
  );
}

describe('rankUniverseByConviction — per-window cost ceiling', () => {
  it('completes normally when total cost stays under cap', async () => {
    const runOne = fakeRunOne(1.0); // $1 per call
    const ranked = await rankUniverseByConviction({
      universe: ['AAPL', 'MSFT', 'GOOGL'],
      decisionDate: new Date('2024-01-01'),
      maxWindowCostUsd: 40,
      runOne,
    });
    expect(ranked).toHaveLength(3);
    expect(runOne).toHaveBeenCalledTimes(3);
  });

  it('aborts and throws WindowCostExceededError when cumulative crosses the cap', async () => {
    const runOne = fakeRunOne(5.0); // $5 per call
    await expect(
      rankUniverseByConviction({
        universe: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA'],
        decisionDate: new Date('2024-01-01'),
        maxWindowCostUsd: 10,
        runOne,
      })
    ).rejects.toBeInstanceOf(WindowCostExceededError);
    // First call cumulative=$5, second call cumulative=$10. On the
    // third iteration the top-of-loop check sees cumulative>=cap
    // and throws BEFORE the third call. So exactly 2 successful
    // calls, then abort.
    expect(runOne).toHaveBeenCalledTimes(2);
  });

  it('error carries spent + cap + completed-symbol counts', async () => {
    const runOne = fakeRunOne(4.0);
    try {
      await rankUniverseByConviction({
        universe: ['A', 'B', 'C', 'D', 'E'],
        decisionDate: new Date('2024-01-01'),
        maxWindowCostUsd: 5,
        runOne,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WindowCostExceededError);
      const e = err as InstanceType<typeof WindowCostExceededError>;
      // First call: cum=$4 (< cap). Second call: cum=$8 (>= cap).
      // Third iteration's pre-check catches it. completedSymbols=2.
      expect(e.spentUsd).toBe(8);
      expect(e.capUsd).toBe(5);
      expect(e.completedSymbols).toBe(2);
      expect(e.totalSymbols).toBe(5);
      expect(e.message).toMatch(/cost ceiling exceeded/);
    }
  });

  it('treats undefined cap as no-limit (legacy behavior preserved)', async () => {
    const runOne = fakeRunOne(100.0); // would blow any reasonable cap
    const ranked = await rankUniverseByConviction({
      universe: ['A', 'B', 'C'],
      decisionDate: new Date('2024-01-01'),
      runOne,
    });
    expect(ranked).toHaveLength(3);
  });

  it('still ranks by conviction after a successful run', async () => {
    let i = 0;
    const runOne = vi.fn(
      async ({
        symbol,
      }: {
        symbol: string;
      }): Promise<BacktestPickResult> => ({
        symbol,
        decisionDateISO: '2024-01-01',
        output: {
          thesis: '',
          convictionScore: [40, 80, 60][i++] ?? 50,
          bullCase: '',
          bearCase: '',
          summary: '',
          killCriteria: [],
          primaryRisks: [],
        },
        costUsd: 1.0,
        durationMs: 100,
      })
    );
    const ranked = await rankUniverseByConviction({
      universe: ['A', 'B', 'C'],
      decisionDate: new Date('2024-01-01'),
      runOne,
    });
    expect(ranked.map((r) => r.symbol)).toEqual(['B', 'C', 'A']);
  });
});
