// In-process scheduler. Replaces external GitHub Actions / Railway
// cron — the agent wakes autonomously as part of the Next.js server
// process, with no user-facing configuration.
//
// Started from src/instrumentation.ts on Node.js server boot.
//
// Logging note: uses console.log with plain text (not the structured
// JSON logger) because Railway's log viewer silently strips or blanks
// out our JSON lines, which made it look like the scheduler wasn't
// firing when in fact it was.

// NOTE: runner is loaded via dynamic import inside tickOnce(). The
// static import chain (scheduler → runner → orchestrator → alpaca)
// pulled the Alpaca SDK's dotenv/fs dependencies into the webpack
// bundle for instrumentation.ts, which Next's build rejects because
// instrumentation is compiled for both node and edge runtimes. Going
// dynamic here keeps the scheduler's top-level bundle Node-API-free.

const INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const BOOT_DELAY_MS = 20 * 1000;

// Module-level state so /api/scheduler/status can report definitively
// whether the scheduler is up without having to dig through Railway logs.
export type SchedulerStatus = {
  started: boolean;
  startedAt: string | null;
  tickCount: number;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastTickElapsedMs: number | null;
  lastTickSummary: {
    total: number;
    ran: number;
    skipped: number;
    failed: number;
    regimeChanged: boolean;
  } | null;
  lastTickError: string | null;
  running: boolean;
  intervalMs: number;
  bootDelayMs: number;
};

const status: SchedulerStatus = {
  started: false,
  startedAt: null,
  tickCount: 0,
  lastTickStartedAt: null,
  lastTickCompletedAt: null,
  lastTickElapsedMs: null,
  lastTickSummary: null,
  lastTickError: null,
  running: false,
  intervalMs: INTERVAL_MS,
  bootDelayMs: BOOT_DELAY_MS,
};

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;

export function getSchedulerStatus(): SchedulerStatus {
  return { ...status };
}

// Staleness threshold — if a tick hasn't completed in this long while
// the scheduler claims to be started, the watchdog treats it as dead
// and asks the boot helper to re-kick it. 5 minutes gives 2x the tick
// interval (2 min) plus headroom for a slow tick (analyzer runs can
// take 30s). Exported for tests.
export const STALE_AFTER_MS = 5 * 60 * 1000;

// True when the scheduler claims to be running but hasn't completed a
// tick recently enough. Null-tick-time state (just booted, boot delay
// hasn't fired yet) is NOT stale — startedAt within the boot-delay
// window is a grace period.
export function isSchedulerStale(nowMs: number = Date.now()): boolean {
  if (!status.started) return false; // never started, not "stale" — just off
  // Still inside the initial boot delay: give it time.
  if (status.lastTickCompletedAt == null) {
    if (status.startedAt == null) return false;
    const sinceStart = nowMs - new Date(status.startedAt).getTime();
    return sinceStart > BOOT_DELAY_MS + STALE_AFTER_MS;
  }
  const sinceTick = nowMs - new Date(status.lastTickCompletedAt).getTime();
  return sinceTick > STALE_AFTER_MS;
}

// Stop any active timers and reset module state so a subsequent call
// to startScheduler() is a clean slate. Safe to call at any time —
// no-op if nothing is running. Used by the watchdog + the manual
// restart endpoint.
export function restartScheduler(): void {
  if (bootTimer != null) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
  status.started = false;
  // Preserve tickCount so /api/scheduler/status can show whether
  // ticks ever happened pre-restart — useful for debugging.
  status.lastTickError = null;
  console.log('[scheduler] restart — cleared timers, ready to start again');
}

async function tickOnce(): Promise<void> {
  if (status.running) {
    console.log('[scheduler] skipped tick — previous still running');
    return;
  }
  status.running = true;
  status.lastTickStartedAt = new Date().toISOString();
  const start = Date.now();
  try {
    // Dynamic import keeps Alpaca SDK (+ its dotenv/fs transitive
    // dependency) out of the instrumentation bundle. Safe at this
    // point because tickOnce only runs on Node after the scheduler
    // boots, never during build or edge compilation.
    const { runScheduledTick } = await import('./cron/runner');
    const result = await runScheduledTick();
    const elapsed = Date.now() - start;
    status.lastTickCompletedAt = new Date().toISOString();
    status.lastTickElapsedMs = elapsed;
    status.lastTickSummary = {
      total: result.total,
      ran: result.ran,
      skipped: result.skipped,
      failed: result.failed,
      regimeChanged: result.regimeChanged,
    };
    status.lastTickError = null;
    status.tickCount += 1;
    console.log(
      `[scheduler] tick #${status.tickCount} done in ${elapsed}ms — total=${result.total} ran=${result.ran} skipped=${result.skipped} failed=${result.failed} regimeChanged=${result.regimeChanged}`
    );
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    status.lastTickError = msg.slice(0, 500);
    console.error(`[scheduler] tick #${status.tickCount + 1} FAILED: ${msg}`);
  } finally {
    status.running = false;
  }
}

export function startScheduler(): void {
  if (timer != null || bootTimer != null) {
    console.log('[scheduler] already started — ignoring duplicate startScheduler()');
    return;
  }
  console.log(
    `[scheduler] starting — intervalMs=${INTERVAL_MS} bootDelayMs=${BOOT_DELAY_MS}`
  );
  status.started = true;
  status.startedAt = new Date().toISOString();

  bootTimer = setTimeout(() => {
    console.log('[scheduler] first tick firing after boot delay');
    void tickOnce();
    timer = setInterval(() => {
      void tickOnce();
    }, INTERVAL_MS);
  }, BOOT_DELAY_MS);

  const shutdown = () => {
    if (bootTimer != null) {
      clearTimeout(bootTimer);
      bootTimer = null;
    }
    if (timer != null) {
      clearInterval(timer);
      timer = null;
      console.log('[scheduler] stopped');
    }
    status.started = false;
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
