// Called by Railway cron. Requires header x-agbro-cron-secret matching env.
// Only wakes the agent if:
//   - account not paused/stopped
//   - current time is within user's trading hours (ET)
//   - cadence since last run has elapsed

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { runAgent } from '@/lib/agents/orchestrator';
import { getCurrentUser } from '@/lib/auth';
import { apiError, assertCronSecret } from '@/lib/api';

export const runtime = 'nodejs';
export const maxDuration = 300;

function withinTradingHours(now: Date, start: string, end: string): boolean {
  // Compare in US/Eastern.
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

export async function POST(req: Request) {
  const unauthorized = assertCronSecret(req);
  if (unauthorized) return unauthorized;

  try {
    const user = await getCurrentUser();
    const account = user.account!;
    if (account.isPaused || account.isStopped) {
      return NextResponse.json({ skipped: true, reason: 'paused_or_stopped' });
    }

    const now = new Date();
    // Skip weekends — US market is closed.
    const dow = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
    }).format(now);
    if (dow === 'Sat' || dow === 'Sun') {
      return NextResponse.json({ skipped: true, reason: 'weekend' });
    }

    if (!withinTradingHours(now, account.tradingHoursStart, account.tradingHoursEnd)) {
      return NextResponse.json({ skipped: true, reason: 'outside_trading_hours' });
    }

    const lastRun = await prisma.agentRun.findFirst({ orderBy: { startedAt: 'desc' } });
    if (lastRun) {
      const mins = (now.getTime() - lastRun.startedAt.getTime()) / 60_000;
      if (mins < account.agentCadenceMinutes) {
        return NextResponse.json({
          skipped: true,
          reason: 'cadence_not_elapsed',
          minutesSinceLast: Math.round(mins),
        });
      }
    }

    const result = await runAgent({ userId: user.id, trigger: 'schedule' });
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err, 500, 'cron tick failed', 'cron.tick');
  }
}

export async function GET(req: Request) {
  // Convenience alias for cron runners that only support GET.
  return POST(req);
}
