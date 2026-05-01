// GET /api/debug/meetings-status — last weekly meeting per user, plus
// the next Friday window the runner will check. Lets us answer "are
// the agents holding their weekly meetings?" against the DB instead
// of scrolling Friday afternoon logs. No auth — diagnostic only.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function nextFridayWindowOpen(now: Date): Date {
  // Find the next Friday 16:00 ET >= now. Done in UTC by stepping
  // day-by-day until Intl resolves the weekday to Fri, then jamming
  // 16:00 ET back into a UTC instant. Approximation is fine for
  // diagnostic display.
  const ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const ETT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
  });
  const cursor = new Date(now);
  for (let i = 0; i < 8; i++) {
    if (ETF.format(cursor) === 'Fri') {
      const hour = Number(ETT.format(cursor));
      // If it's Friday before 18:00 ET, the window is today.
      if (hour < 18) {
        // Set ET hour to 16:00. EDT = UTC-4, EST = UTC-5; we approximate
        // with -4 since the autonomous test will run in late spring.
        const utc = new Date(cursor);
        utc.setUTCHours(20, 0, 0, 0); // 16:00 ET (EDT) = 20:00 UTC
        return utc;
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return cursor;
}

export async function GET() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  const meetings = await prisma.meeting.findMany({
    where: { startedAt: { gte: sevenDaysAgo } },
    orderBy: { startedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      userId: true,
      kind: true,
      startedAt: true,
      completedAt: true,
      status: true,
    },
  });
  // Per-user latest weekly meeting (any history, not just last 7 days).
  const accounts = await prisma.account.findMany({ select: { userId: true } });
  const perUser = await Promise.all(
    accounts.map(async (a) => {
      const last = await prisma.meeting.findFirst({
        where: { userId: a.userId, kind: 'weekly' },
        orderBy: { startedAt: 'desc' },
        select: { id: true, startedAt: true, completedAt: true, status: true },
      });
      return {
        userId: a.userId,
        lastWeekly: last
          ? {
              id: last.id,
              startedAt: last.startedAt.toISOString(),
              completedAt: last.completedAt?.toISOString() ?? null,
              status: last.status,
              daysAgo:
                Math.round(((now.getTime() - last.startedAt.getTime()) / 86_400_000) * 10) / 10,
            }
          : null,
      };
    })
  );
  return NextResponse.json({
    ok: true,
    now: now.toISOString(),
    nowET: new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(now),
    fridayWindowETToday: '16:00 ET — 18:00 ET',
    nextFridayWindowOpensAt: nextFridayWindowOpen(now).toISOString(),
    perUser,
    recentMeetings: meetings.map((m) => ({
      id: m.id,
      userId: m.userId,
      kind: m.kind,
      startedAt: m.startedAt.toISOString(),
      completedAt: m.completedAt?.toISOString() ?? null,
      status: m.status,
    })),
  });
}
