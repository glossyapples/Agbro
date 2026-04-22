// Crypto cron tick. Runs independently of the stock-agent cron because
// crypto trades 24/7 and the cadence is different (DCA is weekly, not
// per-agent-wake-up). Safe to fire hourly — the engine internally rate-
// limits via CryptoConfig.dcaCadenceDays and exits early if nothing is due.

import { NextResponse } from 'next/server';
import { apiError, assertCronSecret } from '@/lib/api';
import { runCryptoCycleAllUsers } from '@/lib/crypto/engine';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: Request) {
  const unauthorized = assertCronSecret(req);
  if (unauthorized) return unauthorized;
  try {
    const results = await runCryptoCycleAllUsers();
    return NextResponse.json({ ok: true, results });
  } catch (err) {
    return apiError(err, 500, 'crypto cron tick failed', 'cron.crypto_tick');
  }
}
