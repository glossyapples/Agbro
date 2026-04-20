import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
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
}
