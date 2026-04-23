// DELETE /api/meetings/history — nuke all of the caller's meetings,
// their action items, and their proposed policy changes. Used when
// the user wants a fresh start after major prompt / cast changes
// so old meetings don't pollute the history view with outdated
// voice / visuals.
//
// Destructive. Returns counts of deleted rows.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';

export async function DELETE() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    // Meeting has onDelete: Cascade for actionItems + policyChanges,
    // so a meeting.deleteMany cascades. But we run explicit deletes
    // in one transaction to return accurate counts and keep this
    // self-documenting.
    const result = await prisma.$transaction(async (tx) => {
      const items = await tx.meetingActionItem.deleteMany({
        where: { userId: user.id },
      });
      const changes = await tx.policyChange.deleteMany({
        where: { userId: user.id },
      });
      const meetings = await tx.meeting.deleteMany({
        where: { userId: user.id },
      });
      return {
        meetings: meetings.count,
        actionItems: items.count,
        policyChanges: changes.count,
      };
    });
    log.info('meetings.history.cleared', { userId: user.id, ...result });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return apiError(err, 500, 'failed to clear history', 'meetings.history.clear');
  }
}
