import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { runAgent } from '@/lib/agents/orchestrator';
import { apiError, requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const gate = await checkLimit(user.id, 'agents.run');
  if (!gate.success) return rateLimited(gate);

  try {
    const result = await runAgent({ userId: user.id, trigger: 'manual' });
    // Agent run touches AgentRun, Trade, BrainEntry, Position — invalidate
    // every page that might display them.
    revalidatePath('/');
    revalidatePath('/trades');
    revalidatePath('/brain');
    revalidatePath('/analytics');
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err, 500, 'agent run failed', 'agents.run');
  }
}
