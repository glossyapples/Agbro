// List the current user's pending approvals — trade proposals the
// autonomy ladder (observe | propose) has queued for user sign-off.
// The UI at /approvals reads from here.
//
// Returns only status='pending' rows whose expiresAt is still in
// the future. The sweep that marks expired rows runs separately
// (see /api/approvals/sweep); if that cron is behind, we still
// filter by expiresAt here so the user doesn't see "stale" items.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const now = new Date();
    const items = await prisma.pendingApproval.findMany({
      where: {
        userId: user.id,
        status: 'pending',
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return NextResponse.json({
      items: items.map((a) => ({
        id: a.id,
        agentRunId: a.agentRunId,
        symbol: a.symbol,
        side: a.side,
        qty: a.qty,
        orderType: a.orderType,
        limitPriceCents: a.limitPriceCents?.toString() ?? null,
        bullCase: a.bullCase,
        bearCase: a.bearCase,
        thesis: a.thesis,
        confidence: a.confidence,
        marginOfSafetyPct: a.marginOfSafetyPct,
        intrinsicValuePerShareCents: a.intrinsicValuePerShareCents?.toString() ?? null,
        expiresAt: a.expiresAt.toISOString(),
        createdAt: a.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    log.error('approvals.list_failed', err, { userId: user.id });
    return apiError(err, 500, 'failed to list approvals', 'approvals.list');
  }
}
