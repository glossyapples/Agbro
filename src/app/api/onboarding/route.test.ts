// Tests for POST /api/onboarding. Verifies validation, the
// normalisation the handler does before saving (upper-casing
// symbols, deduping, trimming) and the onboardingCompletedAt stamp.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@/lib/api', () => ({ requireUser, apiError: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { account: { update } } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from '@/app/api/onboarding/route';

beforeEach(() => {
  requireUser.mockReset();
  update.mockReset();
  requireUser.mockResolvedValue({ id: 'user-1' });
  update.mockResolvedValue({});
});

function req(body: Record<string, unknown>) {
  return new Request('http://localhost/api/onboarding', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const valid = {
  planningAssumption: 15,
  timeHorizonYears: 20,
  maxPositionPct: 10,
  drawdownPauseThresholdPct: -15,
  autonomyLevel: 'propose',
  forbiddenSectors: ['Tobacco', 'Defense'],
  forbiddenSymbols: ['TSLA'],
};

describe('POST /api/onboarding', () => {
  it('accepts a well-formed payload + stamps onboardingCompletedAt', async () => {
    const r = await POST(req(valid));
    expect(r.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.where.userId).toBe('user-1');
    expect(arg.data.onboardingCompletedAt).toBeInstanceOf(Date);
    expect(arg.data.autonomyLevel).toBe('propose');
  });

  it('rejects unknown autonomy level', async () => {
    const r = await POST(req({ ...valid, autonomyLevel: 'chaos' }));
    expect(r.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects negative horizon / out-of-range planning assumption', async () => {
    expect((await POST(req({ ...valid, timeHorizonYears: 0 }))).status).toBe(400);
    expect((await POST(req({ ...valid, timeHorizonYears: 100 }))).status).toBe(400);
    expect((await POST(req({ ...valid, planningAssumption: 100 }))).status).toBe(400);
  });

  it('upper-cases and dedupes forbidden symbols', async () => {
    await POST(
      req({ ...valid, forbiddenSymbols: ['tsla', 'TSLA', '  meta ', 'META'] })
    );
    const arg = update.mock.calls[0][0];
    expect(arg.data.forbiddenSymbols.sort()).toEqual(['META', 'TSLA']);
  });

  it('trims + dedupes forbidden sectors without forcing case', async () => {
    await POST(
      req({ ...valid, forbiddenSectors: ['Tobacco', ' Tobacco ', '', 'Defense'] })
    );
    const arg = update.mock.calls[0][0];
    expect(arg.data.forbiddenSectors.sort()).toEqual(['Defense', 'Tobacco']);
  });

  it('caps forbidden lists (refuses oversized arrays)', async () => {
    const bigSymbols = Array.from({ length: 51 }, (_, i) => `S${i}`);
    expect((await POST(req({ ...valid, forbiddenSymbols: bigSymbols }))).status).toBe(400);
  });
});
