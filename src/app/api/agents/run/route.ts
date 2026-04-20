import { NextResponse } from 'next/server';
import { runAgent } from '@/lib/agents/orchestrator';
import { getCurrentUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST() {
  try {
    const user = await getCurrentUser();
    const result = await runAgent({ userId: user.id, trigger: 'manual' });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
