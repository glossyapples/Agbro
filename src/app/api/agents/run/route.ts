import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { runAgent } from '@/lib/agents/orchestrator';
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
    return apiError(err, 500, 'agent run failed', 'agents.run');
  }
}
