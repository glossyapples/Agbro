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

import { runScheduledTick } from './cron/runner';

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

async function tickOnce(): Promise<void> {
  if (status.running) {
    console.log('[scheduler] skipped tick — previous still running');
    return;
  }
  status.running = true;
  status.lastTickStartedAt = new Date().toISOString();
  const start = Date.now();
  try {
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
