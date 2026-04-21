import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

const Query = z.object({
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const url = new URL(req.url);
    const parsed = Query.safeParse({
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { cursor, limit } = parsed.data;

    // Cursor-based: fetch limit+1; the extra row tells us whether there's a next page.
    const rows = await prisma.trade.findMany({
      where: { userId: user.id },
      orderBy: { submittedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const trades = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? trades[trades.length - 1].id : null;

    return NextResponse.json({
      trades: trades.map((t) => ({
        ...t,
        fillPriceCents: t.fillPriceCents?.toString() ?? null,
        intrinsicValuePerShareCents: t.intrinsicValuePerShareCents?.toString() ?? null,
        realizedPnlCents: t.realizedPnlCents?.toString() ?? null,
      })),
      nextCursor,
    });
  } catch (err) {
    return apiError(err, 500, 'failed to list trades', 'trades.get');
  }
}
