// GET /api/crypto/performance?range=1D|1W|1M|3M|YTD|1Y|ALL
//
// Crypto-book equity series, computed at request time by walking the
// user's filled crypto Trade rows alongside Alpaca's historical bars.
// Replaces an older snapshot-based implementation — see
// src/lib/crypto/performance.ts header for the rationale (sparse
// snapshots can't represent a 24/7 market and depend on the scheduler
// having actually run, which it hadn't for two weeks).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { computeCryptoChart, type Range } from '@/lib/crypto/performance';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';
export const maxDuration = 30;

const Query = z.object({
  range: z.enum(['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL']).default('1M'),
});

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const parsed = Query.safeParse({ range: url.searchParams.get('range') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const range = parsed.data.range as Range;

  try {
    const result = await computeCryptoChart(user.id, range);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err, 500, 'crypto performance fetch failed', 'crypto.performance');
  }
}
