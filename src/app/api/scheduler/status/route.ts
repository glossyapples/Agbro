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

// Report which deployment-critical env vars are configured without
// revealing their values. Lets an operator verify on mobile whether
// AGBRO_CREDENTIAL_ENCRYPTION_KEY is actually readable by the running
// container — invisible-character pastes on the Railway UI are
// otherwise silent.
function envStatus() {
  const k = process.env.AGBRO_CREDENTIAL_ENCRYPTION_KEY;
  const trimmed = k?.trim().replace(/^['"]|['"]$/g, '').replace(/^0x/i, '') ?? '';
  return {
    credentialEncryptionKey: !k
      ? 'missing'
      : /^[0-9a-fA-F]{64}$/.test(trimmed)
        ? 'ok'
        : `invalid (length ${trimmed.length}, expected 64 hex chars)`,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ? 'ok' : 'missing',
    cronSecret: process.env.AGBRO_CRON_SECRET ? 'ok' : 'missing',
  };
}

export async function GET() {
  const status = getSchedulerStatus();
  return NextResponse.json(
    { ...status, env: envStatus() },
    {
      headers: {
        // Never cache — the whole point is to see live state.
        'Cache-Control': 'no-store',
      },
    }
  );
}
