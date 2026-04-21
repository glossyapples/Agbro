import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const trades = await prisma.trade.findMany({
      orderBy: { submittedAt: 'desc' },
      take: 200,
    });
    return NextResponse.json(
      trades.map((t) => ({
        ...t,
        fillPriceCents: t.fillPriceCents?.toString() ?? null,
        intrinsicValuePerShareCents: t.intrinsicValuePerShareCents?.toString() ?? null,
        realizedPnlCents: t.realizedPnlCents?.toString() ?? null,
      }))
    );
  } catch (err) {
    return apiError(err, 500, 'failed to list trades', 'trades.get');
  }
}
