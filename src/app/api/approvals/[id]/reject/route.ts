// User rejects a queued trade proposal. Optional userNote is
// stored on the approval row so the agent can read it back on the
// next run and learn from the feedback ("you rejected GOOG because
// you're already overweight tech").
//
// No broker interaction happens here — the approval was never
// executed, so there's nothing to cancel. The paired
// GovernorDecision audit row was written at proposal time; its
// decision field remains 'requires_approval' since that's the
// gate's verdict at the moment it ran. The mutable lifecycle state
// lives on PendingApproval.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { log } from '@/lib/logger';
import { revalidatePath } from 'next/cache';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const approvalId = params.id;
  const body = await req.json().catch(() => ({}));
  const userNote = typeof body?.userNote === 'string' ? body.userNote.slice(0, 2_000) : null;

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

    await prisma.pendingApproval.update({
      where: { id: approvalId },
      data: {
        status: 'rejected',
        resolvedAt: new Date(),
        resolvedBy: 'user',
        userNote,
      },
    });
    log.info('approvals.rejected_by_user', {
      userId: user.id,
      approvalId,
      symbol: approval.symbol,
      noteLength: userNote?.length ?? 0,
    });

    revalidatePath('/approvals');
    revalidatePath('/');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err, 500, 'rejection failed', 'approvals.reject');
  }
}
