// Tests for the governor-stats aggregator. Covers:
//   - window calculation (days → start Date)
//   - grouping + decision totals
//   - per-reason attribution when a rejection carries multiple codes
//   - protected-dollars summation skipping null estimates
//   - approval lifecycle counts
//   - summarise() headline picks the right framing for each state

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { groupByDecision, findRejections, groupByApprovalStatus } = vi.hoisted(() => ({
  groupByDecision: vi.fn(),
  findRejections: vi.fn(),
  groupByApprovalStatus: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    governorDecision: {
      groupBy: (args: unknown) => groupByDecision(args),
      findMany: (args: unknown) => findRejections(args),
    },
    pendingApproval: {
      groupBy: (args: unknown) => groupByApprovalStatus(args),
    },
  },
}));

import {
  getGovernorStats,
  startOfWindow,
  summarise,
  PROTECTIVE_REASONS,
  REASON_BUCKETS,
} from './governor-stats';
import { REASON_CODES } from './reason-codes';

beforeEach(() => {
  groupByDecision.mockReset();
  findRejections.mockReset();
  groupByApprovalStatus.mockReset();
});

describe('startOfWindow', () => {
  it('snaps to windowDays * 86_400_000 ms before now', () => {
    const now = Date.UTC(2026, 3, 24, 12, 0, 0); // April 24 2026 noon UTC
    const d = startOfWindow(7, now);
    expect(d.toISOString()).toBe('2026-04-17T12:00:00.000Z');
  });
});

describe('getGovernorStats', () => {
  beforeEach(() => {
    // Reasonable defaults so individual tests only override the field
    // they care about.
    groupByDecision.mockResolvedValue([]);
    findRejections.mockResolvedValue([]);
    groupByApprovalStatus.mockResolvedValue([]);
  });

  it('queries all three tables scoped to the caller + window start', async () => {
    const now = Date.UTC(2026, 3, 24, 0, 0, 0);
    await getGovernorStats('user-1', 7, now);
    const decArg = groupByDecision.mock.calls[0][0];
    expect(decArg.where.userId).toBe('user-1');
    const expectedStart = new Date(now - 7 * 86_400_000);
    expect((decArg.where.createdAt.gte as Date).toISOString()).toBe(expectedStart.toISOString());
    const rejArg = findRejections.mock.calls[0][0];
    expect(rejArg.where.decision).toBe('rejected');
    expect(rejArg.where.userId).toBe('user-1');
  });

  it('rolls up decision totals by kind', async () => {
    groupByDecision.mockResolvedValue([
      { decision: 'approved', _count: { _all: 4 } },
      { decision: 'rejected', _count: { _all: 2 } },
      { decision: 'requires_approval', _count: { _all: 1 } },
    ]);
    const stats = await getGovernorStats('user-1');
    expect(stats.totals).toEqual({ approved: 4, rejected: 2, requires_approval: 1 });
  });

  it('attributes every reason code on multi-reason rejections', async () => {
    findRejections.mockResolvedValue([
      {
        reasonCodes: ['EARNINGS_BLACKOUT'],
        estimatedCostCents: null,
      },
      {
        reasonCodes: ['WASH_SALE_VIOLATION', 'MANDATE_FORBIDDEN_SYMBOL'],
        estimatedCostCents: null,
      },
      {
        reasonCodes: ['MANDATE_FORBIDDEN_SYMBOL'],
        estimatedCostCents: null,
      },
    ]);
    const stats = await getGovernorStats('user-1');
    expect(stats.rejectionsByReason).toEqual({
      EARNINGS_BLACKOUT: 1,
      WASH_SALE_VIOLATION: 1,
      MANDATE_FORBIDDEN_SYMBOL: 2,
    });
  });

  it('sums protected dollars across rejections, skipping null estimates', async () => {
    findRejections.mockResolvedValue([
      { reasonCodes: ['NOTIONAL_CAP_EXCEEDED'], estimatedCostCents: 500_000n },
      { reasonCodes: ['WALLET_INSUFFICIENT'], estimatedCostCents: 200_000n },
      { reasonCodes: ['NO_PRICE_FOR_CAP'], estimatedCostCents: null },
    ]);
    const stats = await getGovernorStats('user-1');
    expect(stats.protectedDollarsCents).toBe(700_000n);
  });

  it('counts protected dollars once per rejection even when it stacks multiple reasons', async () => {
    findRejections.mockResolvedValue([
      {
        reasonCodes: ['NOTIONAL_CAP_EXCEEDED', 'MANDATE_CONCENTRATION_BREACH'],
        estimatedCostCents: 900_000n,
      },
    ]);
    const stats = await getGovernorStats('user-1');
    expect(stats.protectedDollarsCents).toBe(900_000n);
    // Reason attribution DID count both.
    expect(stats.rejectionsByReason.NOTIONAL_CAP_EXCEEDED).toBe(1);
    expect(stats.rejectionsByReason.MANDATE_CONCENTRATION_BREACH).toBe(1);
  });

  it('maps every pending-approval status onto the approvals sub-object', async () => {
    groupByApprovalStatus.mockResolvedValue([
      { status: 'pending', _count: { _all: 3 } },
      { status: 'approved', _count: { _all: 5 } },
      { status: 'rejected', _count: { _all: 2 } },
      { status: 'expired', _count: { _all: 1 } },
    ]);
    const stats = await getGovernorStats('user-1');
    expect(stats.approvals).toEqual({
      pending: 3,
      approvedByUser: 5,
      rejectedByUser: 2,
      expired: 1,
    });
  });

  it('returns zero-filled structure when no activity in the window', async () => {
    const stats = await getGovernorStats('user-1');
    expect(stats.totals).toEqual({ approved: 0, rejected: 0, requires_approval: 0 });
    expect(stats.rejectionsByReason).toEqual({});
    expect(stats.protectedDollarsCents).toBe(0n);
    expect(stats.approvals).toEqual({
      pending: 0,
      approvedByUser: 0,
      rejectedByUser: 0,
      expired: 0,
    });
  });
});

describe('summarise', () => {
  const base = {
    windowDays: 7,
    windowStart: new Date(),
    rejectionsByReason: {},
    protectedDollarsCents: 0n,
    approvals: { pending: 0, approvedByUser: 0, rejectedByUser: 0, expired: 0 },
  };

  it('"no activity" when everything is zero', () => {
    const s = summarise({ ...base, totals: { approved: 0, rejected: 0, requires_approval: 0 } });
    expect(s).toContain('No trade decisions');
  });

  it('approvals-only framing when nothing was blocked', () => {
    const s = summarise({ ...base, totals: { approved: 3, rejected: 0, requires_approval: 0 } });
    expect(s).toContain('3 trades passed every safety check');
    expect(s).not.toContain('Blocked');
  });

  it('blocked framing takes precedence when there are rejections', () => {
    const s = summarise({ ...base, totals: { approved: 3, rejected: 2, requires_approval: 1 } });
    expect(s).toContain('Blocked 2 trades');
    expect(s).toContain('3 passed');
    expect(s).toContain('1 queued');
  });

  it('singular/plural agreement', () => {
    const blocked1 = summarise({
      ...base,
      totals: { approved: 0, rejected: 1, requires_approval: 0 },
    });
    expect(blocked1).toContain('Blocked 1 trade ');
    const passed1 = summarise({
      ...base,
      totals: { approved: 1, rejected: 0, requires_approval: 0 },
    });
    expect(passed1).toContain('1 trade passed');
  });
});

describe('reason bucket coverage', () => {
  it('every declared reason code has a bucket (no drift)', () => {
    for (const code of REASON_CODES) {
      expect(REASON_BUCKETS[code]).toBeTruthy();
    }
  });

  it('PROTECTIVE_REASONS is a subset of REASON_CODES (no orphans)', () => {
    for (const r of PROTECTIVE_REASONS) {
      expect((REASON_CODES as readonly string[]).includes(r)).toBe(true);
    }
  });
});
