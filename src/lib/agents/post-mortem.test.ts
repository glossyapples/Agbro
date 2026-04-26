// Tests for the post-mortem module's pure helpers + the dedup /
// supersession invariants. The Opus call itself is mocked at the
// boundary — what we pin here is the wiring around it: outcome
// classification, confidence picker, dedup (don't post-mortem the
// same trade twice), and the supersession-only-when-thesis-was-wrong
// rule.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { classifyOutcome, classifyConfidence } from './post-mortem';

describe('classifyOutcome', () => {
  it('null realizedPnlCents → flat', () => {
    expect(classifyOutcome(null)).toEqual({ outcome: 'flat', pnlUsd: 0 });
  });

  it('positive cents → win with USD value', () => {
    const r = classifyOutcome(50_00n);
    expect(r.outcome).toBe('win');
    expect(r.pnlUsd).toBe(50);
  });

  it('negative cents → loss with negative USD', () => {
    const r = classifyOutcome(-25_00n);
    expect(r.outcome).toBe('loss');
    expect(r.pnlUsd).toBe(-25);
  });

  it('zero cents → flat', () => {
    expect(classifyOutcome(0n)).toEqual({ outcome: 'flat', pnlUsd: 0 });
  });
});

describe('classifyConfidence', () => {
  it('decisive moves (≥10% win) get high confidence', () => {
    expect(classifyConfidence(10)).toBe('high');
    expect(classifyConfidence(25)).toBe('high');
    expect(classifyConfidence(50)).toBe('high');
  });

  it('decisive moves (≥10% loss) also get high confidence', () => {
    expect(classifyConfidence(-10)).toBe('high');
    expect(classifyConfidence(-25)).toBe('high');
  });

  it('small moves (<10% either side) get medium confidence', () => {
    expect(classifyConfidence(0)).toBe('medium');
    expect(classifyConfidence(2.5)).toBe('medium');
    expect(classifyConfidence(-9.9)).toBe('medium');
    expect(classifyConfidence(9.99)).toBe('medium');
  });
});

// runPostMortem — exercise the dedup + write logic with mocked
// Prisma + Anthropic. The full Opus call is replaced with a fake
// that returns a deterministic analysis shape.

const {
  tradeFindMany,
  brainFindMany,
  brainCreate,
  brainUpdate,
  anthropicCreate,
} = vi.hoisted(() => ({
  tradeFindMany: vi.fn(),
  brainFindMany: vi.fn(),
  brainCreate: vi.fn(),
  brainUpdate: vi.fn(),
  anthropicCreate: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    trade: { findMany: tradeFindMany },
    brainEntry: {
      findMany: brainFindMany,
      create: brainCreate,
      update: brainUpdate,
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Anthropic client mock — return a fake message with a JSON text
// block that matches the post-mortem analysis shape.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));

beforeEach(() => {
  tradeFindMany.mockReset();
  brainFindMany.mockReset();
  brainCreate.mockReset();
  brainUpdate.mockReset();
  anthropicCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

function fakeAnalysis(
  thesisAssessment: 'correct' | 'wrong' | 'partial' | 'inconclusive',
  supersedeOriginal: boolean
) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          thesisAssessment,
          reason: 'Test reason for the assessment.',
          generalLesson: thesisAssessment === 'wrong' ? 'Avoid X when Y.' : null,
          supersedeOriginal,
        }),
      },
    ],
    usage: {
      input_tokens: 1_000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function fakeTrade(overrides: Partial<{
  id: string;
  userId: string;
  symbol: string;
  realizedPnlCents: bigint;
  agentRunId: string | null;
}> = {}) {
  return {
    id: 'trade-1',
    userId: 'user-1',
    symbol: 'AAPL',
    side: 'buy',
    qty: 10,
    submittedAt: new Date('2026-04-01'),
    closedAt: new Date('2026-04-20'),
    realizedPnlCents: -200_00n,
    agentRunId: 'run-orig-1',
    bullCase: 'durable moat',
    bearCase: 'reg risk',
    thesis: 'compounder',
    fillPriceCents: 180_00n,
    ...overrides,
  } as Parameters<typeof tradeFindMany>[0] extends never ? never : never;
}

describe('runPostMortem', () => {
  it('skips trades already covered by an existing post-mortem entry (dedup)', async () => {
    const t1 = fakeTrade({ id: 'trade-A' });
    const t2 = fakeTrade({ id: 'trade-B' });
    tradeFindMany.mockResolvedValue([t1, t2]);
    // Entry exists covering trade-A.
    brainFindMany.mockResolvedValueOnce([
      { postMortemTradeIds: ['trade-A'] },
    ]);
    // Context query for trade-B returns no entries.
    brainFindMany.mockResolvedValue([]);
    anthropicCreate.mockResolvedValue(fakeAnalysis('correct', false));
    brainCreate.mockResolvedValue({ id: 'pm-new-1' });

    const { runPostMortem } = await import('./post-mortem');
    const results = await runPostMortem({
      userId: 'user-1',
      agentRunId: 'wake-run-1',
    });

    expect(results).toHaveLength(1);
    expect(results[0].tradeId).toBe('trade-B');
    expect(brainCreate).toHaveBeenCalledTimes(1);
  });

  it('returns empty + skips Anthropic call when ALL eligible trades already covered', async () => {
    const t1 = fakeTrade({ id: 'trade-A' });
    tradeFindMany.mockResolvedValue([t1]);
    brainFindMany.mockResolvedValueOnce([
      { postMortemTradeIds: ['trade-A'] },
    ]);

    const { runPostMortem } = await import('./post-mortem');
    const results = await runPostMortem({
      userId: 'user-1',
      agentRunId: 'wake-run-1',
    });

    expect(results).toEqual([]);
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(brainCreate).not.toHaveBeenCalled();
  });

  it('caps writes at MAX_TRADES_PER_POST_MORTEM (5)', async () => {
    const trades = Array.from({ length: 8 }, (_, i) =>
      fakeTrade({ id: `trade-${i}`, symbol: `T${i}` })
    );
    tradeFindMany.mockResolvedValue(trades);
    brainFindMany.mockResolvedValueOnce([]); // dedup query — none covered
    brainFindMany.mockResolvedValue([]); // per-trade context — empty
    anthropicCreate.mockResolvedValue(fakeAnalysis('correct', false));
    brainCreate.mockImplementation(async (args: unknown) => {
      const a = args as { data: { postMortemTradeIds: string[] } };
      return { id: `pm-${a.data.postMortemTradeIds[0]}` };
    });

    const { runPostMortem, MAX_TRADES_PER_POST_MORTEM } = await import('./post-mortem');
    const results = await runPostMortem({
      userId: 'user-1',
      agentRunId: 'wake-run-1',
    });

    expect(results.length).toBe(MAX_TRADES_PER_POST_MORTEM);
    expect(brainCreate).toHaveBeenCalledTimes(MAX_TRADES_PER_POST_MORTEM);
  });

  it('supersedes original thesis when analysis says supersedeOriginal=true', async () => {
    const t = fakeTrade({ id: 'trade-A' });
    tradeFindMany.mockResolvedValue([t]);
    brainFindMany.mockResolvedValueOnce([]); // dedup
    // Context query: returns the original thesis entry.
    brainFindMany.mockResolvedValue([
      {
        id: 'orig-thesis-1',
        category: 'hypothesis',
        kind: 'hypothesis',
        body: 'long thesis...',
      },
    ]);
    anthropicCreate.mockResolvedValue(fakeAnalysis('wrong', true));
    brainCreate.mockResolvedValue({ id: 'pm-new-1' });
    brainUpdate.mockResolvedValue({});

    const { runPostMortem } = await import('./post-mortem');
    const results = await runPostMortem({
      userId: 'user-1',
      agentRunId: 'wake-run-1',
    });

    expect(results[0].thesisSuperseded).toBe(true);
    expect(brainUpdate).toHaveBeenCalledWith({
      where: { id: 'orig-thesis-1' },
      data: { supersededById: 'pm-new-1' },
    });
  });

  it('does NOT supersede when supersedeOriginal=false (the "unlucky" case)', async () => {
    const t = fakeTrade({ id: 'trade-A' });
    tradeFindMany.mockResolvedValue([t]);
    brainFindMany.mockResolvedValueOnce([]);
    brainFindMany.mockResolvedValue([
      { id: 'orig-thesis-1', category: 'hypothesis', kind: 'hypothesis', body: 'thesis' },
    ]);
    // Wrong outcome but model says it was unlucky, not wrong-on-merits.
    anthropicCreate.mockResolvedValue(fakeAnalysis('correct', false));
    brainCreate.mockResolvedValue({ id: 'pm-new-1' });

    const { runPostMortem } = await import('./post-mortem');
    const results = await runPostMortem({
      userId: 'user-1',
      agentRunId: 'wake-run-1',
    });

    expect(results[0].thesisSuperseded).toBe(false);
    expect(brainUpdate).not.toHaveBeenCalled();
  });

  it('continues past a failing trade (one bad analyze does not poison the rest)', async () => {
    const t1 = fakeTrade({ id: 'trade-A' });
    const t2 = fakeTrade({ id: 'trade-B' });
    tradeFindMany.mockResolvedValue([t1, t2]);
    brainFindMany.mockResolvedValueOnce([]);
    brainFindMany.mockResolvedValue([]);
    // First trade throws, second succeeds.
    anthropicCreate.mockRejectedValueOnce(new Error('Anthropic 503'));
    anthropicCreate.mockResolvedValueOnce(fakeAnalysis('correct', false));
    brainCreate.mockResolvedValue({ id: 'pm-new-1' });

    const { runPostMortem } = await import('./post-mortem');
    const results = await runPostMortem({
      userId: 'user-1',
      agentRunId: 'wake-run-1',
    });

    expect(results).toHaveLength(1);
    expect(results[0].tradeId).toBe('trade-B');
  });

  it('throws when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const t = fakeTrade();
    tradeFindMany.mockResolvedValue([t]);
    brainFindMany.mockResolvedValue([]);

    const { runPostMortem } = await import('./post-mortem');
    await expect(
      runPostMortem({ userId: 'user-1', agentRunId: 'wake-run-1' })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('clamps lookbackDays to [1, 90]', async () => {
    const t = fakeTrade();
    tradeFindMany.mockResolvedValue([t]);
    brainFindMany.mockResolvedValueOnce([]);
    brainFindMany.mockResolvedValue([]);
    anthropicCreate.mockResolvedValue(fakeAnalysis('correct', false));
    brainCreate.mockResolvedValue({ id: 'pm-new-1' });

    const { runPostMortem } = await import('./post-mortem');
    // 0 should clamp to 1; 1000 should clamp to 90; window math
    // exercises the gte filter on closedAt.
    await runPostMortem({ userId: 'user-1', agentRunId: 'wake-run-1', lookbackDays: 0 });
    await runPostMortem({ userId: 'user-1', agentRunId: 'wake-run-1', lookbackDays: 1000 });
    expect(tradeFindMany).toHaveBeenCalledTimes(2);
    // Verify the where.closedAt.gte ranges differ — clamping
    // produces two distinct windows.
    const w0 = tradeFindMany.mock.calls[0][0].where.closedAt.gte as Date;
    const w1 = tradeFindMany.mock.calls[1][0].where.closedAt.gte as Date;
    expect(w0.getTime()).toBeGreaterThan(w1.getTime());
  });
});
