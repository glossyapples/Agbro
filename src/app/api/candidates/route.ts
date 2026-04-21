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
    const [candidates, cooldown] = await Promise.all([
      prisma.stock.findMany({
        where: { candidateSource: 'screener' },
        orderBy: { discoveredAt: 'desc' },
      }),
      getCooldownState(),
    ]);

    return NextResponse.json({
      candidates: candidates.map((s) => ({
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
        candidateNotes: s.candidateNotes,
        discoveredAt: s.discoveredAt?.toISOString() ?? null,
        fundamentalsSource: s.fundamentalsSource,
        fundamentalsUpdatedAt: s.fundamentalsUpdatedAt?.toISOString() ?? null,
        peRatio: s.peRatio,
        dividendYield: s.dividendYield,
        debtToEquity: s.debtToEquity,
        returnOnEquity: s.returnOnEquity,
        grossMarginPct: s.grossMarginPct,
        epsTTM: s.epsTTM,
        bookValuePerShare: s.bookValuePerShare,
      })),
      cooldown,
    });
  } catch (err) {
    return apiError(err, 500, 'failed to list candidates', 'candidates.get');
  }
}
