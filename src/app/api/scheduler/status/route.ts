// GET /api/scheduler/status
//
// Public, read-only endpoint that reports the in-process scheduler's
// state. Used to verify (from outside Railway) that the autonomous
// wake loop is actually running — Railway's log viewer sometimes
// strips our structured log lines, which made the scheduler look
// dead when it wasn't.
//
// Returns JSON only, no auth (same posture as /api/health). Exposes
// no user data — just tick counts, timestamps, and the last summary's
// aggregate numbers.

import { NextResponse } from 'next/server';
import { getSchedulerStatus } from '@/lib/scheduler';

export const runtime = 'nodejs';

export async function GET() {
  const status = getSchedulerStatus();
  return NextResponse.json(status, {
    headers: {
      // Never cache — the whole point is to see live state.
      'Cache-Control': 'no-store',
    },
  });
}
