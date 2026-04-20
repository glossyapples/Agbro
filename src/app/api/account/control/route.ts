import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const { action } = (await req.json()) as { action: 'pause' | 'continue' | 'stop' };
  const user = await getCurrentUser();
  if (!user.account) return NextResponse.json({ error: 'no account' }, { status: 400 });

  let patch: { isPaused?: boolean; isStopped?: boolean };
  switch (action) {
    case 'pause':
      patch = { isPaused: true, isStopped: false };
      break;
    case 'continue':
      patch = { isPaused: false, isStopped: false };
      break;
    case 'stop':
      patch = { isStopped: true, isPaused: true };
      break;
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }

  await prisma.account.update({ where: { userId: user.id }, data: patch });
  await prisma.auditLog.create({
    data: { actor: 'user', action: `account.${action}`, payload: patch },
  });
  await prisma.notification.create({
    data: {
      userId: user.id,
      kind: 'agent_paused',
      title: `Account ${action}`,
      body: `User ${action}d the agent at ${new Date().toISOString()}`,
    },
  });
  return NextResponse.json({ ok: true });
}
