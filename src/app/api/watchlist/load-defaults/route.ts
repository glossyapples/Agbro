// One-click bootstrap: upserts the 29-stock Buffett-style starter universe
// onto the watchlist. Idempotent — re-running won't duplicate rows, it just
// re-enables any entries that had been removed.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { STARTER_UNIVERSE } from '@/lib/stocks/starter-universe';
import { markOnWatchlist } from '@/lib/data/user-watchlist';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const results: Array<{ symbol: string; created: boolean }> = [];
    for (const s of STARTER_UNIVERSE) {
      const existing = await prisma.stock.findUnique({ where: { symbol: s.symbol } });
      await prisma.stock.upsert({
        where: { symbol: s.symbol },
        update: { ...s, onWatchlist: true, lastAnalyzedAt: new Date() },
        create: { ...s, onWatchlist: true, lastAnalyzedAt: new Date() },
      });
      // B2.1 dual-write: seed-universe additions become per-user
      // watchlist entries for the calling user.
      await markOnWatchlist(user.id, s.symbol);
      results.push({ symbol: s.symbol, created: !existing });
    }
    revalidatePath('/watchlist');
    revalidatePath('/analytics');
    return NextResponse.json({
      ok: true,
      total: results.length,
      added: results.filter((r) => r.created).length,
      reactivated: results.filter((r) => !r.created).length,
    });
  } catch (err) {
    return apiError(err, 500, 'failed to load starter universe', 'watchlist.load_defaults');
  }
}
