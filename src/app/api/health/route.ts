// Liveness + shallow readiness check for Railway / any uptime monitor.
// Returns 200 if the process is up and the DB responds to a trivial query.
// Intentionally public — gated by the middleware allowlist.
//
// Side effect: the first request per container also starts the
// autonomous agent scheduler. This replaces the old instrumentation.ts
// hook (which couldn't be used because Next 14's edge-runtime bundling
// of that file failed on the Alpaca SDK's Node-only transitive deps).
// Railway's health probe hits this endpoint within seconds of boot,
// so the scheduler starts reliably without any user action.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { ensureSchedulerAlive } from '@/lib/scheduler-boot';

export const runtime = 'nodejs';
// Disable all caching — health responses must be fresh.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  // Start the scheduler the first time this handler runs per process,
  // and self-heal it on every subsequent probe when it's gone stale.
  // Railway's health probe hits this endpoint every ~30s, so this is
  // the primary watchdog hook — a pod resume that kills setInterval
  // gets caught within one probe cycle.
  const watchdogFired = ensureSchedulerAlive();

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
    schedulerWatchdogFired: watchdogFired,
  };

  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
