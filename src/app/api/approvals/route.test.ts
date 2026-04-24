// Tests for GET /api/approvals. The handler filters to the caller's
// own pending + non-expired rows and serialises bigints as strings
// for the JSON wire.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@/lib/api', () => ({ requireUser, apiError: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { pendingApproval: { findMany } } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from '@/app/api/approvals/route';

beforeEach(() => {
  requireUser.mockReset();
  findMany.mockReset();
  requireUser.mockResolvedValue({ id: 'user-1' });
});

describe('GET /api/approvals', () => {
  it('filters to the caller\'s user id + status=pending + not-expired', async () => {
    findMany.mockResolvedValue([]);
    await GET();
    const arg = findMany.mock.calls[0][0];
    expect(arg.where.userId).toBe('user-1');
    expect(arg.where.status).toBe('pending');
    expect(arg.where.expiresAt.gt).toBeInstanceOf(Date);
    // The gt bound should be "right now" — within a 5-second window.
    const ms = (arg.where.expiresAt.gt as Date).getTime();
    expect(Math.abs(ms - Date.now())).toBeLessThan(5_000);
  });

  it('serialises BigInt fields as strings on the wire', async () => {
    findMany.mockResolvedValue([
      {
        id: 'approval-1',
        agentRunId: null,
        symbol: 'AAPL',
        side: 'buy',
        qty: 10,
        orderType: 'limit',
        limitPriceCents: 18_500n,
        bullCase: 'moat',
        bearCase: 'regulatory',
        thesis: 'compounder',
        confidence: 0.8,
        marginOfSafetyPct: 25,
        intrinsicValuePerShareCents: 20_000n,
        expiresAt: new Date('2026-04-25T12:00:00Z'),
        createdAt: new Date('2026-04-24T12:00:00Z'),
      },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(typeof item.limitPriceCents).toBe('string');
    expect(item.limitPriceCents).toBe('18500');
    expect(typeof item.intrinsicValuePerShareCents).toBe('string');
    expect(item.intrinsicValuePerShareCents).toBe('20000');
    expect(item.expiresAt).toBe('2026-04-25T12:00:00.000Z');
  });

  it('emits empty array when nothing is pending', async () => {
    findMany.mockResolvedValue([]);
    const res = await GET();
    const body = await res.json();
    expect(body.items).toEqual([]);
  });
});
