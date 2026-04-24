import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateMany } = vi.hoisted(() => ({ updateMany: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: { pendingApproval: { updateMany } },
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sweepExpiredApprovals } from './approval-sweep';

beforeEach(() => {
  updateMany.mockReset();
});

describe('sweepExpiredApprovals', () => {
  it('flips every pending row whose expiresAt is in the past', async () => {
    updateMany.mockResolvedValue({ count: 3 });
    const before = Date.now();
    const n = await sweepExpiredApprovals(before);
    expect(n).toBe(3);
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where.status).toBe('pending');
    expect(arg.where.expiresAt.lte.getTime()).toBe(before);
    expect(arg.data.status).toBe('expired');
    expect(arg.data.resolvedBy).toBe('timeout');
    expect(arg.data.resolvedAt).toBeInstanceOf(Date);
  });

  it('returns 0 and swallows errors — never blocks the tick', async () => {
    updateMany.mockRejectedValue(new Error('db down'));
    const n = await sweepExpiredApprovals();
    expect(n).toBe(0);
  });

  it('returns 0 when nothing matched', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const n = await sweepExpiredApprovals();
    expect(n).toBe(0);
  });
});
