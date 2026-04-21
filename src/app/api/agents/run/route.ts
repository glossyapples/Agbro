import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { runAgent, AgentRunInflightError } from '@/lib/agents/orchestrator';
import { apiError, requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST() {
  log.info('agents.run.request_received');
  const user = await requireUser();
  if (user instanceof NextResponse) {
    log.warn('agents.run.unauthorized');
    return user;
  }

  const gate = await checkLimit(user.id, 'agents.run');
  if (!gate.success) {
    log.warn('agents.run.rate_limited', { userId: user.id, remaining: gate.remaining });
    return rateLimited(gate);
  }

  try {
    const result = await runAgent({ userId: user.id, trigger: 'manual' });
    revalidatePath('/');
    revalidatePath('/trades');
    revalidatePath('/brain');
    revalidatePath('/analytics');
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AgentRunInflightError) {
      // Another run is already in flight (cron or a prior click). Return 409
      // so the UI can show a polite "already running" instead of a generic 500.
      return NextResponse.json(
        { error: 'agent_run_inflight', inflightRunId: err.inflightRunId },
        { status: 409 }
      );
    }
    return apiError(err, 500, 'agent run failed', 'agents.run');
  }
}
