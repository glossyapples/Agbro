// User-triggered crypto DCA run. Unlike the cron path (which sweeps all
// users), this endpoint only runs the cycle for the caller. Respects the
// same rate limit as the cron — if the DCA isn't due yet, the engine
// returns skippedReason instead of acting.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { apiError, requireUser } from '@/lib/api';
import { runCryptoCycleForUser } from '@/lib/crypto/engine';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const result = await runCryptoCycleForUser(user.id);
    revalidatePath('/crypto');
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err, 500, 'manual crypto run failed', 'crypto.manual_run');
  }
}
