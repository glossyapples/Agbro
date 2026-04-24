// Tests for POST /api/settings/budget. Verifies the nullable cap
// semantics (null → disabled) and the Zod bounds.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@/lib/api', () => ({ requireUser, apiError: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { account: { update } } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from '@/app/api/settings/budget/route';

beforeEach(() => {
  requireUser.mockReset();
  update.mockReset();
  requireUser.mockResolvedValue({ id: 'user-1' });
  update.mockResolvedValue({});
});

function req(body: Record<string, unknown>) {
  return new Request('http://localhost/api/settings/budget', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/settings/budget', () => {
  it('saves a well-formed budget + threshold', async () => {
    const r = await POST(req({ monthlyApiBudgetUsd: 75, budgetAlarmThresholdPct: 85 }));
    expect(r.status).toBe(200);
    const arg = update.mock.calls[0][0];
    expect(arg.data.monthlyApiBudgetUsd).toBe(75);
    expect(arg.data.budgetAlarmThresholdPct).toBe(85);
  });

  it('accepts null to disable the alarm entirely', async () => {
    const r = await POST(
      req({ monthlyApiBudgetUsd: null, budgetAlarmThresholdPct: 80 })
    );
    expect(r.status).toBe(200);
    const arg = update.mock.calls[0][0];
    expect(arg.data.monthlyApiBudgetUsd).toBeNull();
  });

  it('rejects a budget below the floor ($5)', async () => {
    const r = await POST(
      req({ monthlyApiBudgetUsd: 1, budgetAlarmThresholdPct: 80 })
    );
    expect(r.status).toBe(400);
  });

  it('rejects a budget above the ceiling ($5000)', async () => {
    const r = await POST(
      req({ monthlyApiBudgetUsd: 10_000, budgetAlarmThresholdPct: 80 })
    );
    expect(r.status).toBe(400);
  });

  it('rejects a threshold outside [10, 99]', async () => {
    expect(
      (await POST(req({ monthlyApiBudgetUsd: 50, budgetAlarmThresholdPct: 5 }))).status
    ).toBe(400);
    expect(
      (await POST(req({ monthlyApiBudgetUsd: 50, budgetAlarmThresholdPct: 101 }))).status
    ).toBe(400);
  });
});
