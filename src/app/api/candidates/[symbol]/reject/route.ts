// POST /api/candidates/[symbol]/reject — user says "no thanks" to a Tier 2
// candidate. Flip candidateSource='rejected' so the screener's exclusion
// list keeps Perplexity from re-suggesting it later.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { markRejected } from '@/lib/data/user-watchlist';

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
        onWatchlist: false,
        candidateSource: 'rejected',
      },
    });
    // B2.1 dual-write.
    await markRejected(user.id, symbol);
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actor: 'user',
        action: 'candidate.reject',
        payload: { symbol },
      },
    });

    revalidatePath('/candidates');
    return NextResponse.json({ ok: true, symbol });
  } catch (err) {
    return apiError(err, 500, 'reject failed', 'candidates.reject');
  }
}
