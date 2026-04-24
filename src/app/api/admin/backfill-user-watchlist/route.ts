// POST /api/admin/backfill-user-watchlist — one-shot mirror of existing
// Stock per-user fields into UserWatchlist for the calling user. Safe to
// run multiple times (idempotent via upsert). Auth'd like any other
// route; this is effectively "populate my UserWatchlist rows from the
// current Stock state."
//
// Intended to be called ONCE per user after the B2.1 schema deploy,
// then never again. After B2.3 lands and Stock's per-user fields are
// gone, this endpoint becomes a no-op (no rows match the WHERE filter).

import { NextResponse } from 'next/server';
import { apiError, requireUser } from '@/lib/api';
import { backfillUserWatchlist } from '@/lib/data/user-watchlist';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const result = await backfillUserWatchlist(user.id);
    log.info('admin.user_watchlist_backfill', result);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return apiError(
      err,
      500,
      'backfill failed',
      'admin.user_watchlist_backfill'
    );
  }
}
