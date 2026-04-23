// PATCH /api/meetings/action-items/[id] — change status.
// User can cycle between started ↔ on_hold ↔ completed ↔ blocked.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

const Body = z.object({
  status: z.enum(['started', 'on_hold', 'completed', 'blocked']),
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    // Ownership check via the userId field — no cross-user edits.
    const item = await prisma.meetingActionItem.findUnique({
      where: { id: params.id },
    });
    if (!item || item.userId !== user.id) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    await prisma.meetingActionItem.update({
      where: { id: params.id },
      data: {
        status: parsed.data.status,
        completedAt: parsed.data.status === 'completed' ? new Date() : null,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err, 500, 'failed to update action item', 'meetings.action_item.update');
  }
}
