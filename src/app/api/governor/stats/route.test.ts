// Tests for GET /api/governor/stats. Verifies:
//   - auth passthrough
//   - default 7-day window
//   - days query-string clamping (bad values → default)
//   - BigInt field serialisation

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { requireUser, getGovernorStats } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getGovernorStats: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ requireUser, apiError: vi.fn() }));
vi.mock('@/lib/safety/governor-stats', () => ({ getGovernorStats }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from '@/app/api/governor/stats/route';

beforeEach(() => {
  requireUser.mockReset();
  getGovernorStats.mockReset();
  requireUser.mockResolvedValue({ id: 'user-1' });
  getGovernorStats.mockResolvedValue({
    windowDays: 7,
    windowStart: new Date('2026-04-17T00:00:00.000Z'),
    totals: { approved: 3, rejected: 1, requires_approval: 0 },
    rejectionsByReason: { EARNINGS_BLACKOUT: 1 },
    protectedDollarsCents: 500_000n,
    approvals: { pending: 0, approvedByUser: 0, rejectedByUser: 0, expired: 0 },
  });
});

function req(qs = '') {
  return new Request(`http://localhost/api/governor/stats${qs}`);
}

describe('GET /api/governor/stats', () => {
  it('defaults to a 7-day window when no query string', async () => {
    await GET(req());
    expect(getGovernorStats).toHaveBeenCalledWith('user-1', 7);
  });

  it('accepts ?days=N for valid integers in [1, 90]', async () => {
    await GET(req('?days=14'));
    expect(getGovernorStats).toHaveBeenLastCalledWith('user-1', 14);
    await GET(req('?days=1'));
    expect(getGovernorStats).toHaveBeenLastCalledWith('user-1', 1);
    await GET(req('?days=90'));
    expect(getGovernorStats).toHaveBeenLastCalledWith('user-1', 90);
  });

  it('clamps out-of-range or non-numeric values back to the 7-day default', async () => {
    await GET(req('?days=0'));
    expect(getGovernorStats).toHaveBeenLastCalledWith('user-1', 7);
    await GET(req('?days=365'));
    expect(getGovernorStats).toHaveBeenLastCalledWith('user-1', 7);
    await GET(req('?days=not-a-number'));
    expect(getGovernorStats).toHaveBeenLastCalledWith('user-1', 7);
  });

  it('serialises protectedDollarsCents as a string (BigInt safety)', async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(typeof body.protectedDollarsCents).toBe('string');
    expect(body.protectedDollarsCents).toBe('500000');
    expect(body.totals.rejected).toBe(1);
  });
});
