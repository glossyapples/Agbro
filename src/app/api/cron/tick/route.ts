// Called by Railway cron. Requires header x-agbro-cron-secret matching env.
// For every active user, wakes their agent if:
//   - account not paused/stopped
//   - weekday
//   - current time is within the user's trading hours (ET)
//   - cadence since last run has elapsed
//
// Runs sequentially per user with a per-user budget so a single slow user
// can't consume the whole 300s cron window. At scale, swap to a queue.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { runAgent, AgentRunInflightError } from '@/lib/agents/orchestrator';
import { runCryptoCycleAllUsers } from '@/lib/crypto/engine';
import { detectAndPersistRegime } from '@/lib/data/regime';
import { apiError, assertCronSecret } from '@/lib/api';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 300;

const PER_USER_BUDGET_MS = 90_000; // 90s — leaves headroom inside the 300s cron cap

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

// "Do these two timestamps fall on the same ET calendar day?" Used to
// decide whether a new market-open wake should bypass the cadence gate.
// Both inputs are JS Date — we convert to ET's year-month-day string and
// compare.
function isSameEtDay(a: Date, b: Date): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(a) === fmt.format(b);
}

type Outcome =
  | { userId: string; skipped: true; reason: string }
  | { userId: string; ran: true; agentRunId: string; decision: string | null; status: string }
  | { userId: string; failed: true; reason: string };

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

export async function POST(req: Request) {
  const unauthorized = assertCronSecret(req);
  if (unauthorized) return unauthorized;

  try {
    // Crypto runs 24/7 — fire it on every tick regardless of weekend /
    // market hours. The engine self-rate-limits via CryptoConfig.dcaCadenceDays,
    // so calling it hourly is a no-op when nothing is due. Piggybacking on
    // the existing stock cron means the user doesn't need to configure a
    // second Railway cron for crypto.
    const cryptoResults = await runCryptoCycleAllUsers().catch((err) => {
      log.error('cron.tick.crypto_cycle_failed', err);
      return [] as Awaited<ReturnType<typeof runCryptoCycleAllUsers>>;
    });

    // Market-regime tripwire. Cheap (one SPY bars fetch). On a transition
    // away from 'calm' we'll bypass the cadence + market-hours gates below
    // so the agent can't sleep through a flash crash.
    const regimeResult = await detectAndPersistRegime().catch((err) => {
      log.error('cron.tick.regime_detect_failed', err);
      return null;
    });
    const regimeChanged = regimeResult?.changed ?? false;
    const currentRegime = regimeResult?.assessment.regime ?? 'calm';
    const forceWakeFromRegime =
      regimeChanged && currentRegime !== 'calm';

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
      return NextResponse.json({
        skipped: true,
        reason: 'weekend (stock agent only — crypto ran)',
        crypto: cryptoResults,
        regime: currentRegime,
      });
    }

    const accounts = await prisma.account.findMany({
      where: { isStopped: false, isPaused: false },
      include: { user: true },
    });

    const outcomes: Outcome[] = [];
    for (const account of accounts) {
      // Trading-hours + cadence gates are SUSPENDED on a regime transition
      // away from calm. The whole point of the tripwire is to react to
      // SHTF events the moment they're detectable — sleeping on cadence
      // until the next scheduled wake defeats the purpose.
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

      // Market-open guarantee: if there's been NO agent run so far today
      // (ET calendar day), bypass the cadence gate and wake on this tick.
      // Matches user expectation that the agent runs at least once per
      // trading day near the open, regardless of the chosen cadence or
      // whether last night's final run was "recent enough" to still be
      // within the cadence window.
      const lastRunWasToday =
        lastRun != null && isSameEtDay(lastRun.startedAt, now);

      if (forceWakeFromRegime) {
        log.info('cron.tick.regime_wake', {
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
        log.info('cron.tick.market_open_wake', {
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
        // AgentRunInflightError means another run (cron overlap, manual
        // trigger racing with cron) holds the per-user slot. Not a failure —
        // skip this tick and let the next one pick it up.
        if (err instanceof AgentRunInflightError) {
          outcomes.push({
            userId: account.userId,
            skipped: true,
            reason: `inflight:${err.inflightRunId.slice(0, 8)}`,
          });
          continue;
        }
        log.error('cron.tick.agent_failed', err, { userId: account.userId });
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

    return NextResponse.json(
      {
        total: outcomes.length,
        ran,
        skipped,
        failed,
        outcomes,
        crypto: cryptoResults,
        regime: regimeResult?.assessment ?? null,
        regimeChanged,
      },
      { status: failed > 0 ? 207 : 200 }
    );
  } catch (err) {
    return apiError(err, 500, 'cron tick failed', 'cron.tick');
  }
}

export async function GET(req: Request) {
  return POST(req);
}
