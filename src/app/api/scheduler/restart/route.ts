// POST /api/scheduler/restart
//
// Operator escape hatch for when the in-process scheduler has died
// silently (Railway pod resume, event-loop stall) and the watchdog on
// /api/health / /api/scheduler/status either hasn't been probed yet
// or disagrees with reality. Force-clears the module-level timers and
// re-enters the startScheduler path.
//
// Gated on requireUser() — any authenticated AgBro operator can call
// it. The action is strictly on in-memory state of THIS Node process;
// it doesn't affect DB, positions, or the SchedulerLease row. A
// competing replica's scheduler is unaffected.

import { NextResponse } from 'next/server';
import { apiError, requireUser } from '@/lib/api';
import { forceRestartScheduler } from '@/lib/scheduler-boot';
import { getSchedulerStatus } from '@/lib/scheduler';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const before = getSchedulerStatus();
    forceRestartScheduler();
    log.warn('scheduler.manual_restart', {
      userId: user.id,
      tickCountBefore: before.tickCount,
      lastTickCompletedAt: before.lastTickCompletedAt,
    });
    const after = getSchedulerStatus();
    return NextResponse.json({
      ok: true,
      before: {
        tickCount: before.tickCount,
        lastTickCompletedAt: before.lastTickCompletedAt,
        started: before.started,
      },
      after: {
        tickCount: after.tickCount,
        started: after.started,
        startedAt: after.startedAt,
      },
    });
  } catch (err) {
    return apiError(err, 500, 'scheduler restart failed', 'scheduler.restart');
  }
}
