// PATCH /api/strategy/[id] — update settings on a strategy row that
// live outside `rules` (currently just allowBurryGuest). Kept separate
// from /wizard and /activate so it's safe to call from a simple card-
// toggle without invoking LLM or flipping the active strategy.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

const Body = z.object({
  allowBurryGuest: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    // Scope the update to the caller — prevents editing another user's
    // strategy even if the id is correct.
    const result = await prisma.strategy.updateMany({
      where: { id: params.id, userId: user.id },
      data: {
        ...(parsed.data.allowBurryGuest !== undefined
          ? { allowBurryGuest: parsed.data.allowBurryGuest }
          : {}),
      },
    });
    if (result.count === 0) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err, 500, 'failed to update strategy', 'strategy.patch');
  }
}
