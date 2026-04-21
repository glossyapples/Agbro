// Atomically activate one strategy and deactivate all others for this user.
// A single UPDATE with a CASE-style predicate avoids the classic demote-then-
// activate race where two concurrent requests could leave two strategies
// with isActive=true. Postgres serialises row-level writes, so the last
// statement wins and exactly one strategy is active at the end — regardless
// of call order.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    // Ownership check first so a user can't activate another user's strategy
    // via a crafted id.
    const target = await prisma.strategy.findFirst({
      where: { id: params.id, userId: user.id },
      select: { id: true },
    });
    if (!target) return NextResponse.json({ error: 'not found' }, { status: 404 });

    // One statement, one transaction. Every row for this user gets flipped
    // based on whether its id matches — no demote-then-promote window.
    await prisma.$executeRaw`
      UPDATE "Strategy"
      SET "isActive" = ("id" = ${target.id})
      WHERE "userId" = ${user.id}
    `;

    revalidatePath('/strategy');
    revalidatePath('/');
    return NextResponse.redirect(new URL('/strategy', _req.url));
  } catch (err) {
    return apiError(err, 500, 'failed to activate strategy', 'strategy.activate');
  }
}
