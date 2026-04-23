// HTTP entry point to the scheduled tick. The actual logic lives in
// src/lib/cron/runner.ts and the in-process scheduler calls it directly;
// this route stays available as a manual trigger (useful for debugging
// and ops dashboards).
//
// Requires header x-agbro-cron-secret matching env AGBRO_CRON_SECRET.

import { NextResponse } from 'next/server';
import { apiError, assertCronSecret } from '@/lib/api';
import { runScheduledTick } from '@/lib/cron/runner';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  const unauthorized = assertCronSecret(req);
  if (unauthorized) return unauthorized;

  try {
    const result = await runScheduledTick();
    return NextResponse.json(
      {
        total: result.total,
        ran: result.ran,
        skipped: result.skipped,
        failed: result.failed,
        outcomes: result.outcomes,
        crypto: result.crypto,
        regime: result.regime?.assessment ?? null,
        regimeChanged: result.regimeChanged,
      },
      { status: result.failed > 0 ? 207 : 200 }
    );
  } catch (err) {
    return apiError(err, 500, 'cron tick failed', 'cron.tick');
  }
}

export async function GET(req: Request) {
  return POST(req);
}
