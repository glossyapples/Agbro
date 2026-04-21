import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { toCents } from '@/lib/money';

export const runtime = 'nodejs';

const DepositBody = z.object({
  // Dollars. Bounds keep one mis-typed decimal from creating a catastrophic deposit row.
  amount: z.number().positive().finite().max(10_000_000),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const parsed = DepositBody.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { amount, note } = parsed.data;
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
    revalidatePath('/');
    revalidatePath('/settings');
    revalidatePath('/analytics');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err, 500, 'deposit failed', 'account.deposit');
  }
}
