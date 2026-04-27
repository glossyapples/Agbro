// GET /api/debug/last-agent-run — returns the most recent AgentRun
// for the current user, including the errorMessage. Cheap diagnostic
// endpoint added because Railway's log forwarder is silently dropping
// the structured-log payloads from log.error/info, so the actual
// failure reason for "last agent wake failed" is invisible from the
// log stream. AgentRun rows are persisted regardless and capture
// errorMessage; this endpoint just reads them back.
//
// Auth-gated to the current user — never returns another user's
// agent state.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const recent = await prisma.agentRun.findMany({
      where: { userId: user.id },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        status: true,
        trigger: true,
        startedAt: true,
        endedAt: true,
        decision: true,
        errorMessage: true,
        costUsd: true,
        summary: true,
      },
    });
    return NextResponse.json({
      ok: true,
      runs: recent.map((r) => ({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        startedAt: r.startedAt.toISOString(),
        endedAt: r.endedAt?.toISOString() ?? null,
        durationMs:
          r.endedAt
            ? r.endedAt.getTime() - r.startedAt.getTime()
            : null,
        decision: r.decision,
        errorMessage: r.errorMessage,
        costUsd: r.costUsd,
        summary: r.summary,
      })),
    });
  } catch (err) {
    return apiError(err, 500, 'failed to read agent runs', 'debug.last_agent_run');
  }
}
