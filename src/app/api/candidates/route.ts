// GET /api/candidates — list Tier 2 candidates (discovered by the screener,
// pending user approval or rejection).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { getCooldownState } from '@/lib/data/screener';

export const runtime = 'nodejs';

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const [watchlistRows, cooldown] = await Promise.all([
      // B2.2: per-user candidates from UserWatchlist joined to Stock.
      // discoveredAt + candidateNotes now live on the UserWatchlist row;
      // global fundamentals come from the joined Stock.
      prisma.userWatchlist.findMany({
        where: { userId: user.id, candidateSource: 'screener' },
        orderBy: { discoveredAt: 'desc' },
        include: { stock: true },
      }),
      getCooldownState(user.id),
    ]);

    return NextResponse.json({
      candidates: watchlistRows.map((r) => ({
        symbol: r.stock.symbol,
        name: r.stock.name,
        sector: r.stock.sector,
        candidateNotes: r.candidateNotes,
        discoveredAt: r.discoveredAt?.toISOString() ?? null,
        fundamentalsSource: r.stock.fundamentalsSource,
        fundamentalsUpdatedAt: r.stock.fundamentalsUpdatedAt?.toISOString() ?? null,
        peRatio: r.stock.peRatio,
        dividendYield: r.stock.dividendYield,
        debtToEquity: r.stock.debtToEquity,
        returnOnEquity: r.stock.returnOnEquity,
        grossMarginPct: r.stock.grossMarginPct,
        epsTTM: r.stock.epsTTM,
        bookValuePerShare: r.stock.bookValuePerShare,
      })),
      cooldown,
    });
  } catch (err) {
    return apiError(err, 500, 'failed to list candidates', 'candidates.get');
  }
}
