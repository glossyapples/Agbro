// Lazy scheduler boot + self-healing watchdog. Called from /api/health
// so the scheduler starts the first time Railway's health probe hits
// the container — which happens within seconds of boot on every
// deploy. The watchdog runs on every /api/health + /api/scheduler/status
// probe after that; if it finds the in-process scheduler has died
// silently (Railway pod resume, worker rotation, event-loop stall),
// it re-boots without requiring a redeploy.
//
// Why not instrumentation.ts: Next 14.x bundles src/instrumentation.ts
// for both Node and Edge runtimes, and our scheduler transitively
// imports the Alpaca SDK (via runner → orchestrator → alpaca-trade-api),
// whose dotenv/urljoin deps use Node-only fs/path. Edge bundling
// couldn't resolve those, so the build failed regardless of webpack
// externals or dynamic-import tricks. Lazy boot from a node-runtime
// route sidesteps the whole problem — the scheduler only ever lives
// on the Node server, and the build graph proves that at compile time.

import {
  startScheduler,
  restartScheduler,
  isSchedulerStale,
  getSchedulerStatus,
} from './scheduler';

// Module-level booted flag. Reset when the watchdog or manual restart
// fires so startScheduler can re-enter the start path. In a multi-
// worker Next.js process each worker has its own flag — that's fine
// because SchedulerLease guarantees only one replica's tick actually
// runs the agent body.
let booted = false;

export function bootSchedulerOnce(): void {
  if (booted) return;
  booted = true;
  if (process.env.AGBRO_DISABLE_SCHEDULER === 'true') {
    console.log('[scheduler-boot] disabled via AGBRO_DISABLE_SCHEDULER');
    return;
  }
  console.log('[scheduler-boot] booting scheduler from first /api/health hit');
  // Static import is safe here: scheduler.ts itself has no top-level
  // dependency on the Alpaca SDK — the runner (which transitively
  // imports Alpaca) is loaded via dynamic import inside tickOnce(),
  // only after the scheduler is running on the Node server. So the
  // webpack bundle graph stays clean through compile time.
  startScheduler();
}

// Self-healing watchdog. Safe to call on every hot path — cheap when
// everything's fine (one memory read + one Date math), expensive only
// when the scheduler is actually stuck (clears timers, restarts).
// Returns true if the watchdog fired a restart, false if the
// scheduler is healthy or intentionally disabled.
export function ensureSchedulerAlive(nowMs: number = Date.now()): boolean {
  if (process.env.AGBRO_DISABLE_SCHEDULER === 'true') return false;
  // Not started yet — normal boot path covers it.
  if (!getSchedulerStatus().started) {
    bootSchedulerOnce();
    return true;
  }
  if (!isSchedulerStale(nowMs)) return false;
  console.warn('[scheduler-boot] watchdog: stale scheduler, forcing restart', {
    lastTickCompletedAt: getSchedulerStatus().lastTickCompletedAt,
    tickCount: getSchedulerStatus().tickCount,
  });
  restartScheduler();
  // Drop the booted flag so startScheduler's internal "already started"
  // check doesn't refuse. (restartScheduler resets module state in
  // scheduler.ts; the external `booted` flag here needs its own reset.)
  booted = false;
  bootSchedulerOnce();
  return true;
}

// Unconditional restart. Differs from ensureSchedulerAlive in that
// this always restarts, even if the scheduler appears healthy.
// Exposed to /api/scheduler/restart so the operator has an escape
// hatch when the watchdog's detector disagrees with reality.
export function forceRestartScheduler(): void {
  restartScheduler();
  booted = false;
  bootSchedulerOnce();
}
