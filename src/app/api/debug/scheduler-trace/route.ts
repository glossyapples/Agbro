// GET /api/debug/scheduler-trace — returns the in-memory ring buffer
// of recent scheduler tick decisions as JSON. Built so we can see WHY
// every tick is logging "skipped=1" without scrolling Railway logs;
// the structured logger's [wrn] lines come through blank in Railway,
// which has masked skip reasons (budget_exceeded, kill_switch:*,
// outside_trading_hours, cadence_not_elapsed:Nm) for weeks.
//
// No auth — diagnostic only, returns no secrets. If this endpoint
// stays in production we should require requireUser, but right now
// the priority is letting Claude read it via WebFetch from the work
// branch without the user having to paste anything.

import { NextResponse } from 'next/server';
import { getTickTrace, getSchedulerStatus, isSchedulerStale } from '@/lib/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const trace = getTickTrace();
  const status = getSchedulerStatus();
  const stale = isSchedulerStale();
  return NextResponse.json({
    ok: true,
    now: new Date().toISOString(),
    schedulerStatus: status,
    stale,
    traceCount: trace.length,
    // Newest first so the top of the response answers "what just
    // happened" without paginating.
    trace: trace.slice().reverse(),
  });
}
