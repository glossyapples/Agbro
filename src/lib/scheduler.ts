// In-process scheduler. Replaces the external GitHub Actions / Railway
// cron setup — the agent now wakes autonomously as part of the Next.js
// server process, with no user-facing configuration.
//
// Started from src/instrumentation.ts on Node.js server boot.
//
// Design:
//   - setInterval fires every INTERVAL_MS (default 2 minutes). That's
//     fine-grained enough to respect a user's 5-minute cadence setting
//     without wasting cycles.
//   - An in-memory flag prevents overlapping ticks within the same
//     replica. Cross-replica overlap is handled downstream by
//     AgentRunInflightError in the per-user agent runner.
//   - On SIGTERM we clear the interval so Railway's rolling restarts
//     don't leave ticks in limbo.
//
// Multi-replica safety: this scheduler will fire on every replica
// concurrently. The per-user agent runner's inflight check makes the
// duplicate work harmless, but if/when we scale past 1 replica we
// should add a Postgres-lease-based leader election to halve the load
// during rolling deploys.

import { log } from './logger';
import { runScheduledTick } from './cron/runner';

// How often the scheduler wakes up to check whether anyone's agent
// needs to run. The per-user cadence (agentCadenceMinutes on Account)
// still gates actual agent runs — this is just the outer heartbeat.
const INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
// Delay after boot before the first tick. Gives Prisma time to connect
// and the web server time to be healthy before we start pounding the
// DB with an agent run.
const BOOT_DELAY_MS = 20 * 1000;

let running = false;
let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;

async function tickOnce(): Promise<void> {
  if (running) {
    log.info('scheduler.skipped_inflight');
    return;
  }
  running = true;
  const start = Date.now();
  try {
    const result = await runScheduledTick();
    log.info('scheduler.tick_done', {
      elapsedMs: Date.now() - start,
      total: result.total,
      ran: result.ran,
      skipped: result.skipped,
      failed: result.failed,
      regimeChanged: result.regimeChanged,
    });
  } catch (err) {
    log.error('scheduler.tick_failed', err);
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  if (timer != null || bootTimer != null) {
    log.info('scheduler.already_started');
    return;
  }
  log.info('scheduler.starting', { intervalMs: INTERVAL_MS, bootDelayMs: BOOT_DELAY_MS });

  bootTimer = setTimeout(() => {
    // Fire once right after boot, then every INTERVAL_MS.
    void tickOnce();
    timer = setInterval(() => {
      void tickOnce();
    }, INTERVAL_MS);
  }, BOOT_DELAY_MS);

  // Graceful shutdown so Railway's rolling restarts don't leave the
  // scheduler firing while the container is being terminated.
  const shutdown = () => {
    if (bootTimer != null) {
      clearTimeout(bootTimer);
      bootTimer = null;
    }
    if (timer != null) {
      clearInterval(timer);
      timer = null;
      log.info('scheduler.stopped');
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
