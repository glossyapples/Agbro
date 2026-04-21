import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

const ControlBody = z.object({
  action: z.enum(['pause', 'continue', 'stop']),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const parsed = ControlBody.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    if (!user.account) return NextResponse.json({ error: 'no account' }, { status: 400 });

    const { action } = parsed.data;
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
  } catch (err) {
    return apiError(err, 500, 'control action failed', 'account.control');
  }
}
