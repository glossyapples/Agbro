// GET /api/governor/stats — returns the behavior-alpha aggregate
// for the caller's user, default 7-day window. The /analytics page
// reads the same helper server-side; this endpoint exists so future
// client widgets (home banner, email digest) don't have to
// re-derive.

import { NextResponse } from 'next/server';
import { apiError, requireUser } from '@/lib/api';
import { getGovernorStats } from '@/lib/safety/governor-stats';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const url = new URL(req.url);
    const raw = url.searchParams.get('days');
    const parsed = raw != null ? Number(raw) : 7;
    // Clamp: 1 day minimum for mobile "today" widgets; 90 day
    // ceiling so we don't table-scan beyond a reasonable retention
    // window.
    const days =
      Number.isFinite(parsed) && parsed >= 1 && parsed <= 90 ? Math.round(parsed) : 7;
    const stats = await getGovernorStats(user.id, days);
    return NextResponse.json({
      windowDays: stats.windowDays,
      windowStart: stats.windowStart.toISOString(),
      totals: stats.totals,
      rejectionsByReason: stats.rejectionsByReason,
      protectedDollarsCents: stats.protectedDollarsCents.toString(),
      approvals: stats.approvals,
    });
  } catch (err) {
    return apiError(err, 500, 'failed to read governor stats', 'governor.stats');
  }
}
