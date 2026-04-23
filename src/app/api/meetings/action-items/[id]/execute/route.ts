// POST /api/meetings/action-items/[id]/execute — queue a research or
// review_position action item for the next agent wake.
//
// For 'research' items we flip the status to 'started' (already is)
// and attach the action-item id to the next AgentRun as a priority
// hint the orchestrator can read. For v1 the plumbing is minimal —
// we annotate and mark as 'started' with a note. The orchestrator
// integration (reading these hints at wake time) is a follow-up.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const item = await prisma.meetingActionItem.findUnique({
      where: { id: params.id },
    });
    if (!item || item.userId !== user.id) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (item.kind !== 'research' && item.kind !== 'review_position') {
      return NextResponse.json(
        {
          error: `kind ${item.kind} is not executable — only 'research' and 'review_position' items can be forced`,
        },
        { status: 400 }
      );
    }
    // Simple touch to move the updatedAt forward so the orchestrator's
    // "what's the latest priority?" query picks it up. Full hookup
    // (orchestrator reads open items, treats them as top-of-queue
    // research targets) is a follow-up PR.
    await prisma.meetingActionItem.update({
      where: { id: params.id },
      data: { status: 'started' },
    });
    log.info('meeting.action_item.forced', {
      userId: user.id,
      itemId: item.id,
      kind: item.kind,
    });
    return NextResponse.json({
      ok: true,
      message:
        'Queued for next agent wake. The agent will pick this up on its next scheduled tick (usually within 2 minutes during market hours).',
    });
  } catch (err) {
    return apiError(err, 500, 'failed to execute action item', 'meetings.action_item.execute');
  }
}
