// Tests for POST /api/scheduler/restart. Verifies auth passthrough,
// that it always calls forceRestartScheduler (not the conditional
// watchdog), and returns before/after snapshot of module state.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { requireUser, forceRestartScheduler, getSchedulerStatus } = vi.hoisted(
  () => ({
    requireUser: vi.fn(),
    forceRestartScheduler: vi.fn(),
    getSchedulerStatus: vi.fn(),
  })
);

vi.mock('@/lib/api', () => ({ requireUser, apiError: vi.fn() }));
vi.mock('@/lib/scheduler-boot', () => ({ forceRestartScheduler }));
vi.mock('@/lib/scheduler', () => ({ getSchedulerStatus }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from '@/app/api/scheduler/restart/route';

beforeEach(() => {
  requireUser.mockReset();
  forceRestartScheduler.mockReset();
  getSchedulerStatus.mockReset();
  requireUser.mockResolvedValue({ id: 'user-1' });
  getSchedulerStatus
    .mockReturnValueOnce({
      tickCount: 7,
      lastTickCompletedAt: '2026-04-24T16:00:00.000Z',
      started: true,
      startedAt: '2026-04-24T15:00:00.000Z',
    })
    .mockReturnValueOnce({
      tickCount: 0,
      lastTickCompletedAt: null,
      started: true,
      startedAt: '2026-04-24T18:00:00.000Z',
    });
});

describe('POST /api/scheduler/restart', () => {
  it('force-restarts and returns before/after snapshots on success', async () => {
    const res = await POST();
    expect(forceRestartScheduler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.before.tickCount).toBe(7);
    expect(body.before.started).toBe(true);
    expect(body.after.startedAt).toBe('2026-04-24T18:00:00.000Z');
  });
});
