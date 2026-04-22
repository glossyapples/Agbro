// User-triggered crypto DCA run. Unlike the cron path (which sweeps all
// users), this endpoint only runs the cycle for the caller. Respects the
// same rate limit as the cron — if the DCA isn't due yet, the engine
// returns skippedReason instead of acting.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { apiError, requireUser } from '@/lib/api';
import { runCryptoCycleForUser, maybeSnapshotCryptoBook } from '@/lib/crypto/engine';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const result = await runCryptoCycleForUser(user.id);

    // If a trade actually happened, wait briefly for Alpaca to settle
    // (crypto paper usually fills within a couple seconds) then force a
    // snapshot so the performance chart shows the new point immediately
    // instead of waiting for the next cron tick. Without this, the user
    // clicks "Run DCA now", sees the success message, but the graph sits
    // at the previous snapshot for up to an hour.
    const placedTrades =
      (result.dca.trades.length ?? 0) + (result.rebalance.trades.length ?? 0);
    if (placedTrades > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      await maybeSnapshotCryptoBook(user.id, { force: true }).catch(() => {});
    }

    revalidatePath('/crypto');
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err, 500, 'manual crypto run failed', 'crypto.manual_run');
  }
}
