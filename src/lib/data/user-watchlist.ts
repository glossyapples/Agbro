// UserWatchlist mirror helpers. Phase B2.1 of the Stock-table split:
// every caller that writes per-user state on Stock ALSO calls into here
// to mirror the same change into UserWatchlist. Reads still hit Stock;
// B2.2 will flip those. B2.3 drops the dual-write.
//
// Single entry point per semantic operation keeps the mirror logic in
// one place. Callers pass the userId + symbol + the delta they're
// applying; this module upserts the UserWatchlist row with the
// equivalent state. All operations are idempotent (a re-run produces
// identical state).

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';

type SyncFields = {
  onWatchlist?: boolean;
  candidateSource?: string | null;
  candidateNotes?: string | null;
  discoveredAt?: Date | null;
  autoPromotedAt?: Date | null;
};

// Core upsert used by every mirror helper. Keeps the atomic-idempotent
// invariant: calling this with the same (userId, symbol, fields) twice
// produces identical rows. Best-effort — a DB blip here shouldn't fail
// the primary Stock write, so callers wrap in try/catch and log.
export async function syncUserWatchlist(
  userId: string,
  symbol: string,
  fields: SyncFields
): Promise<void> {
  const sym = symbol.toUpperCase();
  const nonUndef: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) nonUndef[k] = v;
  }
  try {
    await prisma.userWatchlist.upsert({
      where: { userId_symbol: { userId, symbol: sym } },
      create: {
        userId,
        symbol: sym,
        ...nonUndef,
      },
      update: nonUndef,
    });
  } catch (err) {
    // Surface the mirror failure in logs but don't re-throw. The
    // primary Stock write already happened; the mirror is catching
    // up. Next write that touches the same row will self-heal because
    // upsert is idempotent.
    log.warn('user_watchlist.sync_failed', {
      userId,
      symbol: sym,
      err: (err as Error).message,
    });
  }
}

// Convenience wrappers. Each corresponds to a semantic operation in the
// codebase so call sites stay clear about intent.

export async function markOnWatchlist(userId: string, symbol: string): Promise<void> {
  await syncUserWatchlist(userId, symbol, {
    onWatchlist: true,
    candidateSource: 'watchlist',
  });
}

export async function removeFromWatchlist(userId: string, symbol: string): Promise<void> {
  await syncUserWatchlist(userId, symbol, {
    onWatchlist: false,
  });
}

export async function markCandidate(
  userId: string,
  symbol: string,
  opts: {
    source: 'screener' | 'agent';
    notes?: string | null;
    autoPromoted?: boolean;
  }
): Promise<void> {
  await syncUserWatchlist(userId, symbol, {
    onWatchlist: opts.autoPromoted ?? false,
    candidateSource: opts.autoPromoted ? 'watchlist' : opts.source,
    candidateNotes: opts.notes ?? undefined,
    discoveredAt: new Date(),
    autoPromotedAt: opts.autoPromoted ? new Date() : null,
  });
}

export async function markRejected(userId: string, symbol: string): Promise<void> {
  await syncUserWatchlist(userId, symbol, {
    onWatchlist: false,
    candidateSource: 'rejected',
  });
}

export async function promoteCandidateToWatchlist(
  userId: string,
  symbol: string
): Promise<void> {
  await syncUserWatchlist(userId, symbol, {
    onWatchlist: true,
    candidateSource: 'watchlist',
  });
}

// One-shot backfill: walk every Stock row that has per-user state and
// mirror it into UserWatchlist rows for the given user. Idempotent via
// upsert, safe to run multiple times, and no-op for Stocks with no
// per-user state. Intended to be called once at deploy-time via the
// /api/admin/backfill-user-watchlist endpoint (added alongside this
// file).
export async function backfillUserWatchlist(userId: string): Promise<{
  userId: string;
  scanned: number;
  synced: number;
  skipped: number;
}> {
  // Pull only Stocks where at least ONE per-user field is set. Rows
  // with pure catalog state (name, fundamentals only) have no user
  // preference to mirror yet.
  const stocks = await prisma.stock.findMany({
    where: {
      OR: [
        { onWatchlist: true },
        { candidateSource: { not: null } },
        { discoveredAt: { not: null } },
        { autoPromotedAt: { not: null } },
      ],
    },
    select: {
      symbol: true,
      onWatchlist: true,
      candidateSource: true,
      candidateNotes: true,
      discoveredAt: true,
      autoPromotedAt: true,
    },
  });

  let synced = 0;
  let skipped = 0;
  for (const s of stocks) {
    try {
      await prisma.userWatchlist.upsert({
        where: { userId_symbol: { userId, symbol: s.symbol } },
        create: {
          userId,
          symbol: s.symbol,
          onWatchlist: s.onWatchlist,
          candidateSource: s.candidateSource,
          candidateNotes: s.candidateNotes,
          discoveredAt: s.discoveredAt,
          autoPromotedAt: s.autoPromotedAt,
        },
        update: {
          onWatchlist: s.onWatchlist,
          candidateSource: s.candidateSource,
          candidateNotes: s.candidateNotes,
          discoveredAt: s.discoveredAt,
          autoPromotedAt: s.autoPromotedAt,
        },
      });
      synced += 1;
    } catch (err) {
      log.warn('user_watchlist.backfill_skipped', {
        userId,
        symbol: s.symbol,
        err: (err as Error).message,
      });
      skipped += 1;
    }
  }
  log.info('user_watchlist.backfill_done', {
    userId,
    scanned: stocks.length,
    synced,
    skipped,
  });
  return { userId, scanned: stocks.length, synced, skipped };
}
