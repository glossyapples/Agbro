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

// Loose UUID-ish shape — we don't care if it's a real RFC 4122 UUID, just
// that it looks like a stable client token and isn't absurdly long.
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

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

    // Idempotency: if the client sends an Idempotency-Key header and we've
    // already recorded a deposit with that (accountId, key), return the
    // existing row instead of creating a duplicate. Covers: network retries,
    // double-clicks, serverless re-invocations of the same request.
    const rawKey = req.headers.get('idempotency-key');
    const idempotencyKey = rawKey && IDEMPOTENCY_KEY_RE.test(rawKey) ? rawKey : null;
    if (rawKey && !idempotencyKey) {
      return NextResponse.json(
        { error: { formErrors: ['invalid Idempotency-Key header'], fieldErrors: {} } },
        { status: 400 }
      );
    }

    if (idempotencyKey) {
      const existing = await prisma.deposit.findFirst({
        where: { accountId: user.account.id, idempotencyKey },
        select: { id: true },
      });
      if (existing) {
        // Idempotent replay — return OK without a second increment.
        return NextResponse.json({ ok: true, duplicate: true, depositId: existing.id });
      }
    }

    const cents = toCents(amount);
    try {
      const deposit = await prisma.$transaction(async (tx) => {
        const created = await tx.deposit.create({
          data: {
            accountId: user.account!.id,
            idempotencyKey,
            amountCents: cents,
            note,
          },
        });
        await tx.account.update({
          where: { id: user.account!.id },
          data: {
            depositedCents: { increment: cents },
            principalCents: { increment: cents },
          },
        });
        return created;
      });
      revalidatePath('/');
      revalidatePath('/settings');
      revalidatePath('/analytics');
      return NextResponse.json({ ok: true, depositId: deposit.id });
    } catch (err) {
      // P2002 = unique constraint violation — another concurrent request with
      // the same key won the race. Treat as idempotent success.
      if (
        idempotencyKey &&
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === 'P2002'
      ) {
        const winner = await prisma.deposit.findFirst({
          where: { accountId: user.account.id, idempotencyKey },
          select: { id: true },
        });
        return NextResponse.json({ ok: true, duplicate: true, depositId: winner?.id ?? null });
      }
      throw err;
    }
  } catch (err) {
    return apiError(err, 500, 'deposit failed', 'account.deposit');
  }
}
