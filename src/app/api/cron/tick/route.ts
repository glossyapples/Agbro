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
import { runAgent } from '@/lib/agents/orchestrator';
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
    const now = new Date();
    const dow = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
    }).format(now);
    if (dow === 'Sat' || dow === 'Sun') {
      return NextResponse.json({ skipped: true, reason: 'weekend' });
    }

    const accounts = await prisma.account.findMany({
      where: { isStopped: false, isPaused: false },
      include: { user: true },
    });

    const outcomes: Outcome[] = [];
    for (const account of accounts) {
      if (!withinTradingHours(now, account.tradingHoursStart, account.tradingHoursEnd)) {
        outcomes.push({ userId: account.userId, skipped: true, reason: 'outside_trading_hours' });
        continue;
      }
      const lastRun = await prisma.agentRun.findFirst({
        where: { userId: account.userId },
        orderBy: { startedAt: 'desc' },
      });
      if (lastRun) {
        const mins = (now.getTime() - lastRun.startedAt.getTime()) / 60_000;
        if (mins < account.agentCadenceMinutes) {
          outcomes.push({
            userId: account.userId,
            skipped: true,
            reason: `cadence_not_elapsed:${Math.round(mins)}m`,
          });
          continue;
        }
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
      { total: outcomes.length, ran, skipped, failed, outcomes },
      { status: failed > 0 ? 207 : 200 }
    );
  } catch (err) {
    return apiError(err, 500, 'cron tick failed', 'cron.tick');
  }
}

export async function GET(req: Request) {
  return POST(req);
}
