// Tests for POST /api/approvals/[id]/approve. Verifies:
//   • idempotency (non-pending status → 409, expired → 410)
//   • runTool is dispatched with bypassAutonomyLadder=true
//   • on success the approval row gets tradeId + status=approved
//   • on failure the approval row is marked rejected with the error
//     message (the governor decision row was already written by
//     placeTradeTool's internal rejectWithCode path).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
const { findUnique, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));
const { runTool } = vi.hoisted(() => ({ runTool: vi.fn() }));
vi.mock('@/lib/api', () => ({ requireUser, apiError: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { pendingApproval: { findUnique, update } } }));
vi.mock('@/lib/agents/tools', () => ({ runTool }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { POST } from '@/app/api/approvals/[id]/approve/route';

beforeEach(() => {
  requireUser.mockReset();
  findUnique.mockReset();
  update.mockReset();
  runTool.mockReset();
  requireUser.mockResolvedValue({ id: 'user-a' });
  update.mockResolvedValue({});
});

function postReq() {
  return new Request('http://localhost/api/approvals/x/approve', { method: 'POST' });
}

const pendingRow = {
  id: 'ap-1',
  userId: 'user-a',
  agentRunId: 'run-1',
  status: 'pending',
  expiresAt: new Date(Date.now() + 60_000),
  symbol: 'AAPL',
  side: 'buy',
  qty: 10,
  orderType: 'limit',
  limitPriceCents: 18_500n,
  bullCase: 'moat',
  bearCase: 'risk',
  thesis: 'compounder',
  confidence: 0.8,
  intrinsicValuePerShareCents: 20_000n,
  marginOfSafetyPct: 25,
};

describe('POST /api/approvals/[id]/approve', () => {
  it('404s when the approval is missing', async () => {
    findUnique.mockResolvedValue(null);
    const r = await POST(postReq(), { params: { id: 'x' } });
    expect(r.status).toBe(404);
  });

  it('403s when the approval belongs to another user', async () => {
    findUnique.mockResolvedValue({ ...pendingRow, userId: 'user-b' });
    const r = await POST(postReq(), { params: { id: 'ap-1' } });
    expect(r.status).toBe(403);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('409s when the approval is already approved', async () => {
    findUnique.mockResolvedValue({ ...pendingRow, status: 'approved' });
    const r = await POST(postReq(), { params: { id: 'ap-1' } });
    expect(r.status).toBe(409);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('410s when the approval has expired, flipping status→expired', async () => {
    findUnique.mockResolvedValue({
      ...pendingRow,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const r = await POST(postReq(), { params: { id: 'ap-1' } });
    expect(r.status).toBe(410);
    // Sweep-in-handler stamps it expired.
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.data.status).toBe('expired');
    expect(arg.data.resolvedBy).toBe('timeout');
    expect(runTool).not.toHaveBeenCalled();
  });

  it('dispatches place_trade with bypassAutonomyLadder=true and caller=approval-executor', async () => {
    findUnique.mockResolvedValue(pendingRow);
    runTool.mockResolvedValue({
      tradeId: 'trade-1',
      alpacaOrderId: 'alpaca-1',
      status: 'submitted',
    });
    await POST(postReq(), { params: { id: 'ap-1' } });
    expect(runTool).toHaveBeenCalledTimes(1);
    const [name, input, ctx] = runTool.mock.calls[0];
    expect(name).toBe('place_trade');
    expect(ctx.bypassAutonomyLadder).toBe(true);
    // Audit C3: bypass requires both the flag and the caller identity.
    expect(ctx.caller).toBe('approval-executor');
    expect(ctx.userId).toBe('user-a');
    expect(ctx.agentRunId).toBe('run-1');
    // The reconstructed input restores the agent-facing fields.
    expect(input.symbol).toBe('AAPL');
    expect(input.qty).toBe(10);
    expect(input.orderType).toBe('limit');
    expect(input.limitPrice).toBe(185);
    expect(input.intrinsicValuePerShare).toBe(200);
    expect(input.marginOfSafetyPct).toBe(25);
  });

  it('marks status=approved + tradeId on a successful broker fill', async () => {
    findUnique.mockResolvedValue(pendingRow);
    runTool.mockResolvedValue({
      tradeId: 'trade-1',
      alpacaOrderId: 'alpaca-1',
      status: 'submitted',
    });
    const r = await POST(postReq(), { params: { id: 'ap-1' } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.tradeId).toBe('trade-1');
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.data.status).toBe('approved');
    expect(arg.data.tradeId).toBe('trade-1');
    expect(arg.data.resolvedBy).toBe('user');
  });

  it('marks status=rejected with the error message when runTool throws', async () => {
    findUnique.mockResolvedValue(pendingRow);
    runTool.mockRejectedValue(
      new Error('place_trade: insufficient spendable cash. Order needs ~$1850 …')
    );
    const r = await POST(postReq(), { params: { id: 'ap-1' } });
    expect(r.status).toBe(422);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('gate_or_broker_rejected');
    const arg = update.mock.calls[0][0];
    expect(arg.data.status).toBe('rejected');
    expect(arg.data.resolvedBy).toBe('system');
    expect(arg.data.userNote).toContain('insufficient');
  });
});
