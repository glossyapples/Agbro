// POST /api/candidates/[symbol]/promote — user-driven promotion of a Tier 2
// candidate into the main watchlist. Sets onWatchlist=true and flips
// candidateSource='watchlist' so it exits the pending queue.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { promoteCandidateToWatchlist } from '@/lib/data/user-watchlist';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  { params }: { params: { symbol: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const symbol = params.symbol.toUpperCase();
    const existing = await prisma.stock.findUnique({ where: { symbol } });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (existing.candidateSource !== 'screener') {
      return NextResponse.json(
        { error: 'not a pending candidate' },
        { status: 400 }
      );
    }

    await prisma.stock.update({
      where: { symbol },
      data: {
        onWatchlist: true,
        candidateSource: 'watchlist',
      },
    });
    // B2.1 dual-write.
    await promoteCandidateToWatchlist(user.id, symbol);
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actor: 'user',
        action: 'candidate.promote',
        payload: { symbol },
      },
    });

    revalidatePath('/candidates');
    revalidatePath('/watchlist');
    revalidatePath('/');
    return NextResponse.json({ ok: true, symbol });
  } catch (err) {
    return apiError(err, 500, 'promote failed', 'candidates.promote');
  }
}
