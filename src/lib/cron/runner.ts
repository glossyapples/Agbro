// Scheduled agent tick — the core autonomous loop, extracted so it can be
// called either via HTTP (/api/cron/tick, for debugging / manual trigger)
// or directly in-process by the scheduler (src/lib/scheduler.ts).
//
// Responsibilities per invocation:
//   1. Run the crypto cycle for everyone (24/7, self-rate-limits internally).
//   2. Run the market-regime tripwire (cheap SPY fetch).
//   3. For every active user: check weekend / trading-hours / cadence
//      gates; if passed, run the agent with a per-user timeout budget.
//   4. A regime transition out of "calm" bypasses all gates so the agent
//      can react immediately.

import { prisma } from '@/lib/db';
import { runAgent, AgentRunInflightError } from '@/lib/agents/orchestrator';
import { runCryptoCycleAllUsers } from '@/lib/crypto/engine';
import { detectAndPersistRegime } from '@/lib/data/regime';
import { runMeeting } from '@/lib/meetings/runner';
import { checkKillSwitches, applyKillSwitch } from '@/lib/safety/rails';
import { tryAcquireLease, releaseLease } from './lease';
import { log } from '@/lib/logger';

// Module-load banner. Prints exactly once when this file is first imported
// by the scheduler. If we DON'T see this in Railway logs after a deploy,
// the build artifact is stale (older than the source we just pushed).
console.log('[scheduler-runner] runner.ts loaded — build banner v3');

// Per-user soft budget for one runAgent invocation. Was 90s; that's
// tight when the orchestrator does multiple tool turns + adaptive
// thinking (a single tool turn can be 30s on Opus). Bumped to 5
// minutes, still inside the 6-minute scheduler hard ceiling so a
// hung run can't permanently block the tick loop.
const PER_USER_BUDGET_MS = 5 * 60_000;

export type TickOutcome =
  | { userId: string; skipped: true; reason: string }
  | { userId: string; ran: true; agentRunId: string; decision: string | null; status: string }
  | { userId: string; failed: true; reason: string };

export type TickResult = {
  total: number;
  ran: number;
  skipped: number;
  failed: number;
  outcomes: TickOutcome[];
  crypto: Awaited<ReturnType<typeof runCryptoCycleAllUsers>>;
  regime: Awaited<ReturnType<typeof detectAndPersistRegime>> | null;
  regimeChanged: boolean;
  // True when the tick was skipped because another replica held the
  // lease. Distinguishes "nothing to do" from "another instance
  // already did it" in the logs + /api/scheduler/status.
  skippedByLock?: boolean;
};

function withinTradingHours(now: Date, start: string, end: string): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const current = `${hh}:${mm}`;
  return current >= start && current <= end;
}

function isSameEtDay(a: Date, b: Date): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(a) === fmt.format(b);
}

// Helper: wrap a promise with a deadline AND surface an AbortSignal
// that the inner work can listen on so it actually stops doing work
// when the deadline hits — not just rejects the outer promise while
// the orchestrator keeps spending tokens. Audit C2.
//
// Defense-in-depth: races the inner against the timeout deadline. A
// cooperative inner (one that listens to the signal and rejects on
// abort, like the Anthropic SDK) settles first and the timeout race
// is moot. A non-cooperative inner (legacy SDK, third-party tool that
// ignores AbortSignal) still gets a real outer rejection at the
// deadline — the inner keeps running in the background, but the
// caller is unblocked. Without this race, a non-cooperative inner
// would hang forever even though the deadline fired.
//
// Exported for tests; not part of the runner's public API.
export function withTimeoutAndSignal<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
  tag: string
): Promise<T> {
  const ctrl = new AbortController();
  let timeoutFired = false;
  const inner = factory(ctrl.signal);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      timeoutFired = true;
      ctrl.abort(new Error(`${tag} timed out after ${ms}ms`));
      reject(new Error(`${tag} timed out after ${ms}ms`));
    }, ms);
    inner.then(
      (v) => {
        clearTimeout(timer);
        if (!timeoutFired) resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        if (timeoutFired) return; // already rejected with timeout msg
        // If the inner rejected because we aborted it, prefer the
        // timeout message — cleaner for log-grep.
        if (ctrl.signal.aborted && e instanceof Error && /abort/i.test(e.message)) {
          reject(new Error(`${tag} timed out after ${ms}ms`));
          return;
        }
        reject(e);
      }
    );
  });
}

export async function runScheduledTick(): Promise<TickResult> {
  // Leader election. Railway may scale to >1 replica; without this gate,
  // every replica would fire its own 2-minute timer and every tick would
  // double every write (regime rows, crypto DCA legs, weekly meeting
  // dispatch). Agent wakes themselves are already serialised via the
  // FOR UPDATE lock on Account, but the tick body around them isn't.
  // See SchedulerLease in schema.prisma for full rationale.
  const lease = await tryAcquireLease('tick');
  if (!lease.acquired) {
    // Lease-skip diagnostic. Routes through console.log because Railway
    // strips structured log.info lines. heldBy here is the OTHER process's
    // holder ID; if it never changes across many ticks, we have a stale
    // lease row that needs clearing.
    console.log(`[scheduler-runner] lease NOT acquired — heldBy=${lease.heldBy ?? 'unknown'}`);
    log.info('tick.skipped_by_lease', { heldBy: lease.heldBy });
    return {
      total: 0,
      ran: 0,
      skipped: 0,
      failed: 0,
      outcomes: [],
      crypto: [],
      regime: null,
      regimeChanged: false,
      skippedByLock: true,
    };
  }
  try {
    return await runTickBody();
  } finally {
    // Release even on throw — the next tick reclaims the lease on its
    // own merits. Release is best-effort (logged if it fails); worst
    // case the TTL reclaims.
    await releaseLease('tick');
  }
}

async function runTickBody(): Promise<TickResult> {
  console.log('[scheduler-runner] runTickBody entered');
  // Sweep expired pending approvals first — self-contained, no
  // per-user loop. Cheap UPDATE by the expiresAt index. Errors here
  // are logged but don't block the rest of the tick.
  await (async () => {
    const { sweepExpiredApprovals } = await import('@/lib/safety/approval-sweep');
    await sweepExpiredApprovals();
  })();

  // Crypto runs 24/7 — fire it on every tick regardless of weekend /
  // market hours. The engine self-rate-limits via
  // CryptoConfig.dcaCadenceDays so calling it frequently is a no-op
  // when nothing is due.
  const cryptoResults = await runCryptoCycleAllUsers().catch((err) => {
    log.error('tick.crypto_cycle_failed', err);
    return [] as Awaited<ReturnType<typeof runCryptoCycleAllUsers>>;
  });

  // Market-regime tripwire. On a transition away from 'calm' we'll
  // bypass the cadence + market-hours gates below so the agent can't
  // sleep through a flash crash.
  const regimeResult = await detectAndPersistRegime().catch((err) => {
    log.error('tick.regime_detect_failed', err);
    return null;
  });
  const regimeChanged = regimeResult?.changed ?? false;
  const currentRegime = regimeResult?.assessment.regime ?? 'calm';
  const forceWakeFromRegime = regimeChanged && currentRegime !== 'calm';

  const now = new Date();
  const dow = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(now);

  // Weekend short-circuit applies to the stock agent ONLY when the
  // market regime is calm. A regime transition (e.g. crisis triggered
  // by Friday's close) MUST wake the agent over the weekend so it can
  // research before Monday open. Crypto ran above regardless.
  if ((dow === 'Sat' || dow === 'Sun') && !forceWakeFromRegime) {
    return {
      total: 0,
      ran: 0,
      skipped: 0,
      failed: 0,
      outcomes: [],
      crypto: cryptoResults,
      regime: regimeResult,
      regimeChanged,
    };
  }

  const accounts = await prisma.account.findMany({
    where: { isStopped: false, isPaused: false },
  });
  // Unconditional diagnostic. Earlier conditional version (only when
  // length===0) didn't appear in Railway logs either because the
  // commit hadn't deployed or the runner returned early before this
  // line. Log on every body run so the absence of this line itself
  // is information ("body never reached the query").
  let unfilteredCount: number | string = '?';
  let rawCount: string = '?';
  try {
    unfilteredCount = await prisma.account.count();
    const raw = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "Account"
      WHERE "isStopped" = false AND "isPaused" = false
    `;
    rawCount = String(raw[0]?.count ?? 'null');
  } catch (err) {
    rawCount = `error: ${(err as Error).message.slice(0, 80)}`;
  }
  console.log(
    `[scheduler-runner] accounts query: filtered=${accounts.length} unfiltered=${unfilteredCount} rawSql=${rawCount}`
  );

  const outcomes: TickOutcome[] = [];
  for (const account of accounts) {
    // BYOK cost-governor — enforces monthlyApiBudgetUsd by setting
    // the kill switch when MTD spend crosses 100%. Runs FIRST so
    // we don't even fetch rails or agent context for a halted user.
    const { enforceApiBudget } = await import('@/lib/safety/budget');
    const budget = await enforceApiBudget(account.userId);
    if (budget.state === 'exceeded') {
      outcomes.push({
        userId: account.userId,
        skipped: true,
        reason: 'budget_exceeded',
      });
      continue;
    }

    // Safety rails — daily loss kill switch + 30-day drawdown
    // threshold. Runs BEFORE trading-hours + cadence checks so that
    // a bad day halts the agent even during a regime-forced wake.
    const safety = await checkKillSwitches(account.userId);
    if (!safety.ok) {
      // data_unavailable means the Alpaca-sourced check couldn't
      // complete — treat as a transient skip, NOT a persisted trip.
      // Next tick retries. Real trips (daily_loss / drawdown / other)
      // persist via applyKillSwitch so they survive restarts and
      // require manual clear.
      if (safety.triggeredBy !== 'data_unavailable') {
        await applyKillSwitch(account.userId, safety.reason);
      }
      outcomes.push({
        userId: account.userId,
        skipped: true,
        reason: `kill_switch:${safety.triggeredBy}`,
      });
      continue;
    }

    if (
      !forceWakeFromRegime &&
      !withinTradingHours(now, account.tradingHoursStart, account.tradingHoursEnd)
    ) {
      outcomes.push({ userId: account.userId, skipped: true, reason: 'outside_trading_hours' });
      continue;
    }
    const lastRun = await prisma.agentRun.findFirst({
      where: { userId: account.userId },
      orderBy: { startedAt: 'desc' },
    });

    const lastRunWasToday = lastRun != null && isSameEtDay(lastRun.startedAt, now);

    if (forceWakeFromRegime) {
      log.info('tick.regime_wake', {
        userId: account.userId,
        regime: currentRegime,
        triggers: regimeResult?.assessment.triggers ?? [],
      });
    } else if (lastRun && lastRunWasToday) {
      const mins = (now.getTime() - lastRun.startedAt.getTime()) / 60_000;
      if (mins < account.agentCadenceMinutes) {
        outcomes.push({
          userId: account.userId,
          skipped: true,
          reason: `cadence_not_elapsed:${Math.round(mins)}m`,
        });
        continue;
      }
    } else if (lastRun) {
      // Routine tick event — fires on every market-open tick that
      // clears cadence for every active user. Downgraded to debug so
      // prod logs keep tick.start / tick.end / kill_switch / agent
      // run events as signal.
      log.debug('tick.market_open_wake', {
        userId: account.userId,
        lastRunAt: lastRun.startedAt.toISOString(),
      });
    }

    try {
      const result = await withTimeoutAndSignal(
        (signal) => runAgent({ userId: account.userId, trigger: 'schedule', signal }),
        PER_USER_BUDGET_MS,
        `agent(${account.userId})`
      );
      outcomes.push({
        userId: account.userId,
        ran: true,
        agentRunId: result.agentRunId,
        decision: result.decision,
        status: result.status,
      });
    } catch (err) {
      if (err instanceof AgentRunInflightError) {
        outcomes.push({
          userId: account.userId,
          skipped: true,
          reason: `inflight:${err.inflightRunId.slice(0, 8)}`,
        });
        continue;
      }
      log.error('tick.agent_failed', err, { userId: account.userId });
      outcomes.push({
        userId: account.userId,
        failed: true,
        reason: (err as Error).message.slice(0, 200),
      });
    }
  }

  const failed = outcomes.filter((o) => 'failed' in o).length;
  const ran = outcomes.filter((o) => 'ran' in o).length;
  const skipped = outcomes.filter((o) => 'skipped' in o).length;

  // Weekly executive meetings. Fires during the Friday afternoon ET
  // window (16:00-18:00) for any active account that hasn't had a
  // weekly meeting in the last 6 days. One chance per account per
  // week; if we miss the window we skip and catch it next week.
  // (User can still trigger impromptu meetings from the UI.)
  try {
    const etHour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        hour12: false,
      }).format(now)
    );
    const isFridayAfternoonET = dow === 'Fri' && etHour >= 16 && etHour < 18;
    if (isFridayAfternoonET) {
      const sixDaysAgo = new Date(now.getTime() - 6 * 86_400_000);
      for (const account of accounts) {
        const recentMeeting = await prisma.meeting.findFirst({
          where: {
            userId: account.userId,
            kind: 'weekly',
            startedAt: { gte: sixDaysAgo },
          },
          orderBy: { startedAt: 'desc' },
        });
        if (recentMeeting) continue;
        runMeeting({ userId: account.userId, kind: 'weekly' })
          .then((r) =>
            log.info('tick.weekly_meeting_done', { userId: account.userId, ...r })
          )
          .catch((err) =>
            log.error('tick.weekly_meeting_failed', err, { userId: account.userId })
          );
        // Fire-and-forget: meetings can take 30s+. We don't want to
        // block the tick on them. The DB row tracks status.
      }
    }
  } catch (err) {
    log.error('tick.weekly_meeting_gate_failed', err);
  }

  return {
    total: outcomes.length,
    ran,
    skipped,
    failed,
    outcomes,
    crypto: cryptoResults,
    regime: regimeResult,
    regimeChanged,
  };
}
