import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { toCents } from '@/lib/money';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const { amount, note } = (await req.json()) as { amount: number; note?: string };
  if (!(amount > 0)) return NextResponse.json({ error: 'amount must be > 0' }, { status: 400 });
  const user = await getCurrentUser();
  if (!user.account) return NextResponse.json({ error: 'no account' }, { status: 400 });

  const cents = toCents(amount);
  await prisma.$transaction([
    prisma.deposit.create({
      data: { accountId: user.account.id, amountCents: cents, note },
    }),
    prisma.account.update({
      where: { id: user.account.id },
      data: {
        depositedCents: { increment: cents },
        principalCents: { increment: cents },
      },
    }),
  ]);
  return NextResponse.json({ ok: true });
}
