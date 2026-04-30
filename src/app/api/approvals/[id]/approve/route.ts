// User approves a queued trade proposal. We re-dispatch the
// place_trade tool with bypassAutonomyLadder=true so the gate runs
// fresh (prices may have moved, wallet may have changed) and the
// trade either lands at Alpaca or surfaces a structured error that
// becomes the approval's rejection reason.
//
// Why re-run the gate instead of trusting the proposal-time check:
// markets move. MOS at 9am vs 5pm can flip; wallet balance can
// change; pause/stop flags can flip. The governor's invariant is
// "every order that reaches the broker passed every gate at
// execution time." A single approval click should not weaken that.
//
// Idempotency: the first successful approve wins. A duplicate click
// (retry, double-submit) reads a non-pending row and no-ops with a
// 409 so the user sees the trade state that actually exists.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { runTool } from '@/lib/agents/tools';
import { log } from '@/lib/logger';
import { revalidatePath } from 'next/cache';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const approvalId = params.id;

  try {
    const approval = await prisma.pendingApproval.findUnique({ where: { id: approvalId } });
    if (!approval) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (approval.userId !== user.id) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    if (approval.status !== 'pending') {
      return NextResponse.json(
        { error: 'not_pending', status: approval.status },
        { status: 409 }
      );
    }
    if (approval.expiresAt.getTime() <= Date.now()) {
      // Treat a stale click as an implicit timeout resolution so the
      // UI stays consistent even when the sweep is behind.
      await prisma.pendingApproval.update({
        where: { id: approvalId },
        data: { status: 'expired', resolvedAt: new Date(), resolvedBy: 'timeout' },
      });
      return NextResponse.json({ error: 'expired' }, { status: 410 });
    }

    // Reconstruct the agent-facing PlaceTradeInput from the stored
    // approval fields. Numeric conversions mirror the original
    // schema: priceAtSubmit isn't replayed — the gate fetches live
    // price on its own.
    const input: Record<string, unknown> = {
      symbol: approval.symbol,
      side: approval.side,
      qty: approval.qty,
      orderType: approval.orderType,
      bullCase: approval.bullCase,
      bearCase: approval.bearCase,
      thesis: approval.thesis,
      confidence: approval.confidence,
    };
    if (approval.limitPriceCents != null) {
      input.limitPrice = Number(approval.limitPriceCents) / 100;
    }
    if (approval.intrinsicValuePerShareCents != null) {
      input.intrinsicValuePerShare = Number(approval.intrinsicValuePerShareCents) / 100;
    }
    if (approval.marginOfSafetyPct != null) {
      input.marginOfSafetyPct = approval.marginOfSafetyPct;
    }

    let tradeResult: { tradeId?: string; alpacaOrderId?: string; status?: string };
    try {
      tradeResult = (await runTool('place_trade', input, {
        userId: user.id,
        agentRunId: approval.agentRunId,
        caller: 'approval-executor',
        bypassAutonomyLadder: true,
      })) as typeof tradeResult;
    } catch (toolErr) {
      // Gate rejected at execution time (price drift, wallet, etc.)
      // OR broker rejected. Mark the approval as rejected with the
      // rendered reason — the GovernorDecision audit row was already
      // written by placeTradeTool's rejectWithCode path.
      const message = (toolErr as Error).message || 'execution failed';
      await prisma.pendingApproval.update({
        where: { id: approvalId },
        data: {
          status: 'rejected',
          resolvedAt: new Date(),
          resolvedBy: 'system',
          userNote: message.slice(0, 500),
        },
      });
      log.warn('approvals.execute_rejected_at_exec', {
        userId: user.id,
        approvalId,
        message,
      });
      return NextResponse.json(
        { ok: false, reason: 'gate_or_broker_rejected', message },
        { status: 422 }
      );
    }

    // Success — link the approval to the resulting trade.
    await prisma.pendingApproval.update({
      where: { id: approvalId },
      data: {
        status: 'approved',
        resolvedAt: new Date(),
        resolvedBy: 'user',
        tradeId: tradeResult.tradeId ?? null,
      },
    });
    log.info('approvals.approved', {
      userId: user.id,
      approvalId,
      tradeId: tradeResult.tradeId,
    });

    revalidatePath('/approvals');
    revalidatePath('/');
    revalidatePath('/trades');
    return NextResponse.json({ ok: true, ...tradeResult });
  } catch (err) {
    return apiError(err, 500, 'approval failed', 'approvals.approve');
  }
}
