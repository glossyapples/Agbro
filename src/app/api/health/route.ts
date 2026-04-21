// Liveness + shallow readiness check for Railway / any uptime monitor.
// Returns 200 if the process is up and the DB responds to a trivial query.
// Intentionally public — gated by the middleware allowlist.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
// Disable all caching — health responses must be fresh.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const startedAt = Date.now();
  let dbOk = false;
  let dbLatencyMs: number | null = null;
  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - t0;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const body = {
    ok: dbOk,
    service: 'agbro',
    version: process.env.AGBRO_GIT_SHA ?? 'dev',
    db: { ok: dbOk, latencyMs: dbLatencyMs },
    uptimeSeconds: Math.round(process.uptime()),
    checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
  };

  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
