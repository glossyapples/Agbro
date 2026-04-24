// Tests for the /api/approvals/[id]/reject handler. Verifies the
// state-machine guards (own-user only, must be pending) and the
// mutable lifecycle fields we stamp on resolution.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { requireUser, apiError } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  apiError: vi.fn(),
}));
const { findUnique, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ requireUser, apiError }));
vi.mock('@/lib/db', () => ({
  prisma: { pendingApproval: { findUnique, update } },
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { POST } from '@/app/api/approvals/[id]/reject/route';

beforeEach(() => {
  requireUser.mockReset();
  findUnique.mockReset();
  update.mockReset();
  apiError.mockReset();
  requireUser.mockResolvedValue({ id: 'user-a' });
});

function reqWith(body: unknown) {
  return new Request('http://localhost/api/approvals/x/reject', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

describe('POST /api/approvals/[id]/reject', () => {
  it('404s when the approval does not exist', async () => {
    findUnique.mockResolvedValue(null);
    const r = await POST(reqWith({}), { params: { id: 'missing' } });
    expect(r.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it('403s when the approval belongs to another user', async () => {
    findUnique.mockResolvedValue({ id: 'x', userId: 'user-b', status: 'pending' });
    const r = await POST(reqWith({}), { params: { id: 'x' } });
    expect(r.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it('409s when the approval is already resolved', async () => {
    findUnique.mockResolvedValue({ id: 'x', userId: 'user-a', status: 'approved' });
    const r = await POST(reqWith({}), { params: { id: 'x' } });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.status).toBe('approved');
    expect(update).not.toHaveBeenCalled();
  });

  it('marks pending → rejected with resolvedBy="user" and persists the note', async () => {
    findUnique.mockResolvedValue({ id: 'x', userId: 'user-a', status: 'pending' });
    update.mockResolvedValue({});
    const r = await POST(
      reqWith({ userNote: 'already overweight tech' }),
      { params: { id: 'x' } }
    );
    expect(r.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.where.id).toBe('x');
    expect(arg.data.status).toBe('rejected');
    expect(arg.data.resolvedBy).toBe('user');
    expect(arg.data.userNote).toBe('already overweight tech');
    expect(arg.data.resolvedAt).toBeInstanceOf(Date);
  });

  it('truncates oversized userNote to 2000 chars', async () => {
    findUnique.mockResolvedValue({ id: 'x', userId: 'user-a', status: 'pending' });
    update.mockResolvedValue({});
    const long = 'a'.repeat(3_000);
    await POST(reqWith({ userNote: long }), { params: { id: 'x' } });
    const arg = update.mock.calls[0][0];
    expect(arg.data.userNote?.length).toBe(2_000);
  });

  it('accepts a missing / null userNote without failing', async () => {
    findUnique.mockResolvedValue({ id: 'x', userId: 'user-a', status: 'pending' });
    update.mockResolvedValue({});
    const r = await POST(reqWith({}), { params: { id: 'x' } });
    expect(r.status).toBe(200);
    const arg = update.mock.calls[0][0];
    expect(arg.data.userNote).toBeNull();
  });
});
