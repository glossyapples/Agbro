// GET /api/debug/scheduler-lease — inspect the SchedulerLease row.
// DELETE /api/debug/scheduler-lease — force-clear it.
//
// Built because we found the in-process scheduler was 100% taking the
// lease-skip path on every tick (runTickBody never entered, so accounts
// query never ran). That can only happen if someone else holds the
// lease consistently. This endpoint surfaces the row contents and gives
// a one-call escape hatch.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const rows = await prisma.schedulerLease.findMany({
      orderBy: { acquiredAt: 'desc' },
    });
    const now = Date.now();
    return NextResponse.json({
      ok: true,
      now: new Date(now).toISOString(),
      leases: rows.map((r) => ({
        leaseId: r.leaseId,
        heldBy: r.heldBy,
        acquiredAt: r.acquiredAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        msSinceAcquire: now - r.acquiredAt.getTime(),
        msUntilExpiry: r.expiresAt.getTime() - now,
        expired: r.expiresAt.getTime() < now,
      })),
    });
  } catch (err) {
    return apiError(err, 500, 'failed to read leases', 'debug.scheduler_lease.get');
  }
}

export async function DELETE() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const result = await prisma.schedulerLease.deleteMany({});
    return NextResponse.json({
      ok: true,
      deletedCount: result.count,
      note: 'Next scheduler tick (within 2 min) will reacquire from a clean slate.',
    });
  } catch (err) {
    return apiError(err, 500, 'failed to delete leases', 'debug.scheduler_lease.delete');
  }
}
