// Shared HTTP helpers: sanitized error responses and timing-safe secret comparison.

import { NextResponse } from 'next/server';
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { log } from '@/lib/logger';

// Log the real error server-side, return a generic message to the client.
// Always call this instead of leaking `(err as Error).message` in responses.
export function apiError(
  err: unknown,
  status = 500,
  publicMessage = 'internal server error',
  context?: string
): NextResponse {
  log.error(context ?? 'api_error', err, { status });
  return NextResponse.json({ error: publicMessage }, { status });
}

// Constant-time comparison for shared secrets (cron header, etc.).
// Returns false if either value is missing or lengths differ.
export function timingSafeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return nodeTimingSafeEqual(aBuf, bBuf);
}

// Cron-style shared-secret check. Returns null on success, a 401 response otherwise.
export function assertCronSecret(req: Request): NextResponse | null {
  const expected = process.env.AGBRO_CRON_SECRET;
  const provided = req.headers.get('x-agbro-cron-secret') ?? '';
  if (!expected || !timingSafeEqual(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

// Gate an endpoint on the current user. Returns the user on success, or a 401
// NextResponse if no user is available. Callers should early-return the
// response (instanceof NextResponse).
export async function requireUser() {
  try {
    return await getCurrentUser();
  } catch (err) {
    // Useful signal when debugging "why is my API returning 401": distinguishes
    // 'unauthenticated' (no session cookie) from 'session stale' (cookie
    // points at a deleted user). Logs at debug so normal prod noise stays low.
    log.debug('requireUser.rejected', { reason: (err as Error).message });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
}
