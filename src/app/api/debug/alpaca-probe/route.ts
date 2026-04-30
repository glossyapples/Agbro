// GET /api/debug/alpaca-probe — independent smoke test for the
// Alpaca client used by the safety rails. Returns the raw error if
// getPortfolioHistory fails so we can diagnose why
// kill_switch:data_unavailable is firing every tick. No auth — same
// reasoning as scheduler-trace; payload is diagnostic only.

import { NextResponse } from 'next/server';
import { getPortfolioHistory } from '@/lib/alpaca';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const out: Record<string, unknown> = {
    ok: true,
    now: new Date().toISOString(),
    env: {
      ALPACA_KEY_ID: process.env.ALPACA_KEY_ID
        ? `${process.env.ALPACA_KEY_ID.slice(0, 4)}…(${process.env.ALPACA_KEY_ID.length})`
        : 'missing',
      ALPACA_SECRET_KEY: process.env.ALPACA_SECRET_KEY
        ? `set(${process.env.ALPACA_SECRET_KEY.length})`
        : 'missing',
      ALPACA_PAPER: process.env.ALPACA_PAPER ?? '(unset, default)',
    },
  };
  try {
    const t0 = Date.now();
    const bars = await getPortfolioHistory('1D');
    out.daily = {
      ok: true,
      pointCount: bars.length,
      firstEquity: bars[0]?.equity ?? null,
      lastEquity: bars[bars.length - 1]?.equity ?? null,
      elapsedMs: Date.now() - t0,
    };
  } catch (err) {
    out.daily = {
      ok: false,
      error: (err as Error).message?.slice(0, 500) ?? String(err),
      stack: (err as Error).stack?.split('\n').slice(0, 6).join('\n'),
    };
  }
  try {
    const t0 = Date.now();
    const bars = await getPortfolioHistory('1M');
    out.monthly = {
      ok: true,
      pointCount: bars.length,
      firstEquity: bars[0]?.equity ?? null,
      lastEquity: bars[bars.length - 1]?.equity ?? null,
      elapsedMs: Date.now() - t0,
    };
  } catch (err) {
    out.monthly = {
      ok: false,
      error: (err as Error).message?.slice(0, 500) ?? String(err),
      stack: (err as Error).stack?.split('\n').slice(0, 6).join('\n'),
    };
  }
  return NextResponse.json(out);
}
