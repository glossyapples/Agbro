// Watchlist management. Stock is a global (not per-user) table; the agent
// reads onWatchlist=true rows as its research universe.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

const AddBody = z.object({
  symbol: z.string().min(1).max(12).regex(/^[A-Za-z.\-]+$/, 'letters, dot, dash only'),
  // Name + fundamentals optional — the agent can enrich later via
  // update_stock_fundamentals. Adding just a symbol is enough to get it
  // onto the watchlist and into the research rotation.
  name: z.string().min(1).max(120).optional(),
  sector: z.string().max(64).optional(),
  industry: z.string().max(120).optional(),
  notes: z.string().max(2_000).optional(),
});

// GET: list the current watchlist (onWatchlist=true), sorted by buffettScore desc.
export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const stocks = await prisma.stock.findMany({
      where: { onWatchlist: true },
      orderBy: [{ buffettScore: 'desc' }, { symbol: 'asc' }],
    });
    return NextResponse.json(
      stocks.map((s) => ({
        ...s,
        marketCapCents: s.marketCapCents?.toString() ?? null,
      }))
    );
  } catch (err) {
    return apiError(err, 500, 'failed to list watchlist', 'watchlist.get');
  }
}

// POST: add (or re-enable) a symbol on the watchlist.
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const parsed = AddBody.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const symbol = parsed.data.symbol.toUpperCase();
    const stock = await prisma.stock.upsert({
      where: { symbol },
      update: {
        onWatchlist: true,
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.sector ? { sector: parsed.data.sector } : {}),
        ...(parsed.data.industry ? { industry: parsed.data.industry } : {}),
        ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
      },
      create: {
        symbol,
        name: parsed.data.name ?? symbol,
        sector: parsed.data.sector,
        industry: parsed.data.industry,
        notes: parsed.data.notes,
        onWatchlist: true,
      },
    });
    revalidatePath('/watchlist');
    revalidatePath('/analytics');
    return NextResponse.json({ ok: true, symbol: stock.symbol });
  } catch (err) {
    return apiError(err, 500, 'failed to add stock', 'watchlist.post');
  }
}

// DELETE ?symbol=FOO: remove from watchlist. Keeps the Stock row (agent may
// have enriched it) but flips onWatchlist to false.
export async function DELETE(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const url = new URL(req.url);
    const symbol = url.searchParams.get('symbol')?.toUpperCase();
    if (!symbol) {
      return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    }
    await prisma.stock.update({
      where: { symbol },
      data: { onWatchlist: false },
    });
    revalidatePath('/watchlist');
    revalidatePath('/analytics');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err, 500, 'failed to remove stock', 'watchlist.delete');
  }
}
