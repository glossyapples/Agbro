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
import { log } from '@/lib/logger';

const PER_USER_BUDGET_MS = 90_000;

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

function withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${tag} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export async function runScheduledTick(): Promise<TickResult> {
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
    include: { user: true },
  });

  const outcomes: TickOutcome[] = [];
  for (const account of accounts) {
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
      const result = await withTimeout(
        runAgent({ userId: account.userId, trigger: 'schedule' }),
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
