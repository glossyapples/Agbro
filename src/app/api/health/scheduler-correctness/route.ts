// GET /api/health/scheduler-correctness
//
// Returns 200 if the scheduler is producing real ticks during market
// hours; returns 503 if the system is "alive but doing nothing" — the
// exact failure mode that caused the 2-week silent outage. Audit C14.
//
// Two correctness signals:
//   1. Scheduler has ticked at least once since boot. tickCount === 0
//      after BOOT_DELAY + STALE_AFTER_MS means setInterval never fired
//      (the original lease-bug symptom on its own ticked-but-skipped
//      path could yield this same signal at the deeper layer).
//   2. During market hours (13:30-21:00 UTC weekdays), at least one
//      tick in the last 2 hours had total > 0. A persistent total=0
//      stream during the trading day means findMany is filtering all
//      accounts out — the exact lease-bug shape, undetectable until
//      this endpoint existed.
//
// External monitoring (UptimeRobot, BetterStack, cron-job.org) hits
// this URL every 5-10 min and pages on 503. No PII; safe to expose
// without auth. Requires the scheduler to maintain `lastTickSummary`
// which it already does.

import { NextResponse } from 'next/server';
import { getSchedulerStatus } from '@/lib/scheduler';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_AFTER_BOOT_MS = 5 * 60 * 1000;
// Market hours in UTC: NYSE 09:30-16:00 ET = 13:30-21:00 UTC during EDT
// (UTC-4) and 14:30-21:00 UTC during EST (UTC-5). We use the broader EDT
// window so the alert isn't off by an hour twice a year. False
// positives during the EST shoulder are rare (no agent activity expected
// before 14:30 UTC anyway) and self-resolve once the next eligible
// window passes.
const MARKET_OPEN_UTC_HOUR = 13;
const MARKET_OPEN_UTC_MIN = 30;
const MARKET_CLOSE_UTC_HOUR = 21;
const RAN_LOOKBACK_MS = 2 * 60 * 60 * 1000;

function isMarketHoursUtc(d: Date): boolean {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (h < MARKET_OPEN_UTC_HOUR) return false;
  if (h === MARKET_OPEN_UTC_HOUR && m < MARKET_OPEN_UTC_MIN) return false;
  if (h >= MARKET_CLOSE_UTC_HOUR) return false;
  return true;
}

export async function GET() {
  const status = getSchedulerStatus();
  const now = new Date();
  const reasons: string[] = [];

  // Signal 1: scheduler has actually ticked.
  if (status.started) {
    if (status.startedAt) {
      const sinceStartMs = now.getTime() - new Date(status.startedAt).getTime();
      if (status.tickCount === 0 && sinceStartMs > status.bootDelayMs + STALE_AFTER_BOOT_MS) {
        reasons.push(
          `scheduler.started=true for ${Math.round(sinceStartMs / 1000)}s but tickCount=0; setInterval likely not firing`
        );
      }
    }
  }

  // Signal 2: during market hours, at least one schedule-triggered
  // AgentRun in the last 2 hours OR at least one tick with total > 0.
  // We use AgentRun (DB) instead of in-memory `lastTickSummary` so the
  // signal survives restarts and so the check is meaningful for the
  // GitHub Actions external cron path (which doesn't update the
  // in-process status struct).
  if (isMarketHoursUtc(now)) {
    const since = new Date(now.getTime() - RAN_LOOKBACK_MS);
    const recentAgentRuns = await prisma.agentRun.count({
      where: { startedAt: { gte: since }, trigger: 'schedule' },
    });
    if (recentAgentRuns === 0) {
      // Only flag if there's actually an account that should be running.
      // A brand-new install with zero accounts shouldn't page anyone.
      const activeAccounts = await prisma.account.count({
        where: { isStopped: false, isPaused: false },
      });
      if (activeAccounts > 0) {
        reasons.push(
          `0 schedule-triggered AgentRuns in the last ${RAN_LOOKBACK_MS / 60_000}min during market hours, with ${activeAccounts} active account(s) — system is alive but doing nothing`
        );
      }
    }
  }

  const ok = reasons.length === 0;
  return NextResponse.json(
    {
      ok,
      now: now.toISOString(),
      marketHours: isMarketHoursUtc(now),
      tickCount: status.tickCount,
      lastTickCompletedAt: status.lastTickCompletedAt,
      lastTickSummary: status.lastTickSummary,
      reasons,
    },
    { status: ok ? 200 : 503 }
  );
}
