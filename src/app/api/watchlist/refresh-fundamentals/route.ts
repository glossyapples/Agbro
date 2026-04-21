// POST /api/watchlist/refresh-fundamentals
// Refreshes every watchlist symbol from SEC EDGAR, sequentially with a
// polite pacing delay. Takes ~10-30 seconds for the default 29 symbols;
// scales ~linearly beyond that. The client triggers this from /watchlist.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { apiError, requireUser } from '@/lib/api';
import { refreshWatchlistFundamentals } from '@/lib/data/refresh-fundamentals';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const results = await refreshWatchlistFundamentals();
    revalidatePath('/watchlist');
    revalidatePath('/analytics');
    return NextResponse.json({
      ok: true,
      total: results.length,
      updated: results.filter((r) => r.status === 'updated').length,
      notFound: results.filter((r) => r.status === 'not_found').length,
      errored: results.filter((r) => r.status === 'error').length,
      sampleErrors: results
        .filter((r) => r.status === 'error')
        .slice(0, 3)
        .map((r) => ({ symbol: r.symbol, error: r.error })),
    });
  } catch (err) {
    return apiError(err, 500, 'fundamentals refresh failed', 'watchlist.refresh-fundamentals');
  }
}
