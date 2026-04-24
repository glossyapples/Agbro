// Unit tests for the pending-approval helpers. The DB-side create is
// mocked; what matters here is that the helper wires the right
// reason codes + lifecycle fields for the queue to render. The real
// round-trip is covered by Playwright E2E.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const decisionCreate = vi.fn();
const approvalCreate = vi.fn();
const runTx = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => unknown) =>
      runTx(() =>
        fn({
          governorDecision: { create: decisionCreate },
          pendingApproval: { create: approvalCreate },
        })
      ),
  },
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createPendingApproval, DEFAULT_APPROVAL_TTL_MS } from './pending-approval';
import { GOVERNOR_VERSION } from './governor';

beforeEach(() => {
  decisionCreate.mockReset();
  approvalCreate.mockReset();
  runTx.mockReset();
  runTx.mockImplementation((fn: () => unknown) => Promise.resolve(fn()));
  decisionCreate.mockResolvedValue({ id: 'decision-1' });
  approvalCreate.mockResolvedValue({ id: 'approval-1' });
});

const baseInput = {
  userId: 'user-1',
  agentRunId: 'run-1',
  symbol: 'AAPL',
  side: 'buy' as const,
  qty: 10,
  orderType: 'market' as const,
  limitPriceCents: null,
  bullCase: 'durable moat',
  bearCase: 'regulatory',
  thesis: 'compounder',
  confidence: 0.8,
  intrinsicValuePerShareCents: 20_000n,
  marginOfSafetyPct: 25,
  reasons: [
    { code: 'PROPOSE_MODE_REQUIRES_APPROVAL' as const, params: { symbol: 'AAPL' } },
  ],
  autonomyLevel: 'propose' as const,
};

describe('createPendingApproval', () => {
  it('writes the decision + approval in a single transaction', async () => {
    await createPendingApproval(baseInput);
    expect(runTx).toHaveBeenCalledTimes(1);
    expect(decisionCreate).toHaveBeenCalledTimes(1);
    expect(approvalCreate).toHaveBeenCalledTimes(1);
  });

  it('stamps the audit row with decision="requires_approval" + governor version', async () => {
    await createPendingApproval(baseInput);
    const arg = decisionCreate.mock.calls[0][0];
    expect(arg.data.decision).toBe('requires_approval');
    expect(arg.data.governorVersion).toBe(GOVERNOR_VERSION);
    expect(arg.data.reasonCodes).toEqual(['PROPOSE_MODE_REQUIRES_APPROVAL']);
    expect(arg.data.autonomyLevel).toBe('propose');
  });

  it('the rendered user explanation comes from the first reason', async () => {
    await createPendingApproval(baseInput);
    const arg = decisionCreate.mock.calls[0][0];
    expect(arg.data.userExplanation).toContain('AAPL');
    expect(arg.data.userExplanation.length).toBeGreaterThan(0);
  });

  it('FKs the approval row to the decision row', async () => {
    decisionCreate.mockResolvedValue({ id: 'dec-xyz' });
    await createPendingApproval(baseInput);
    const arg = approvalCreate.mock.calls[0][0];
    expect(arg.data.governorDecisionId).toBe('dec-xyz');
  });

  it('expiresAt defaults to 24h from now', async () => {
    const before = Date.now();
    const result = await createPendingApproval(baseInput);
    const after = Date.now();
    const exp = result.expiresAt.getTime();
    expect(exp - before).toBeGreaterThanOrEqual(DEFAULT_APPROVAL_TTL_MS - 1);
    expect(exp - after).toBeLessThanOrEqual(DEFAULT_APPROVAL_TTL_MS + 1);
  });

  it('honors a custom ttlMs when provided', async () => {
    const custom = 5 * 60 * 1_000; // 5 min
    const before = Date.now();
    const result = await createPendingApproval({ ...baseInput, ttlMs: custom });
    expect(result.expiresAt.getTime() - before).toBeLessThanOrEqual(custom + 5);
  });

  it('carries the agent thesis onto the approval row for the UI', async () => {
    await createPendingApproval(baseInput);
    const arg = approvalCreate.mock.calls[0][0];
    expect(arg.data.bullCase).toBe('durable moat');
    expect(arg.data.bearCase).toBe('regulatory');
    expect(arg.data.thesis).toBe('compounder');
    expect(arg.data.confidence).toBe(0.8);
    expect(arg.data.marginOfSafetyPct).toBe(25);
    expect(arg.data.intrinsicValuePerShareCents).toBe(20_000n);
  });

  it('returns the approvalId the caller needs to echo back to the agent', async () => {
    decisionCreate.mockResolvedValue({ id: 'dec-xyz' });
    approvalCreate.mockResolvedValue({ id: 'app-abc' });
    const r = await createPendingApproval(baseInput);
    expect(r.approvalId).toBe('app-abc');
    expect(r.governorDecisionId).toBe('dec-xyz');
  });

  it('falls back to "auto" if an unrecognised autonomy value leaks in (defensive)', async () => {
    await createPendingApproval({
      ...baseInput,
      // @ts-expect-error — simulating a stale/mis-typed caller
      autonomyLevel: 'panic',
    });
    const arg = decisionCreate.mock.calls[0][0];
    expect(arg.data.autonomyLevel).toBe('auto');
  });
});
