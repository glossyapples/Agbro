// POST /api/wallet/transfer — move cash between "Active" (Alpaca-visible
// for the agent) and "Wallet" (AgBro-side reservation that the agent
// can't touch).
//
// Nothing actually moves at Alpaca — the money is all sitting in Alpaca
// cash either way. This endpoint just adjusts the AgBro-side
// walletBalanceCents field, which place_trade + crypto DCA subtract
// from effective buying power before deciding what to deploy.
//
// Direction semantics:
//   to_wallet   → increases walletBalanceCents by amount (more frozen)
//   from_wallet → decreases walletBalanceCents by amount (more active)
//
// Idempotency: this is a simple accounting adjustment. A double-click
// from the UI will double the transfer, which is fine — the user can
// always correct by transferring the other direction.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { getBrokerAccount } from '@/lib/alpaca';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';

const Body = z.object({
  direction: z.enum(['to_wallet', 'from_wallet']),
  amountUsd: z.number().positive().finite().max(10_000_000),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { direction, amountUsd } = parsed.data;
    const amountCents = BigInt(Math.round(amountUsd * 100));

    // Atomic update guards against concurrent transfers (double-click,
    // two tabs) from producing a negative wallet balance or over-reserving
    // past what Alpaca actually holds. Lock-then-validate.
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Account" WHERE "userId" = ${user.id} FOR UPDATE`;
      const acct = await tx.account.findUnique({ where: { userId: user.id } });
      if (!acct) throw new Error('account not found');

      // Moving TO wallet: verify Alpaca actually has enough cash to back
      // the reservation. Wallet can't exceed real Alpaca cash (otherwise
      // we'd claim to have reserved money that isn't there).
      if (direction === 'to_wallet') {
        const broker = await getBrokerAccount();
        const projected = acct.walletBalanceCents + amountCents;
        if (projected > broker.cashCents) {
          throw new Error(
            `cannot reserve $${amountUsd.toFixed(0)} — Alpaca cash is only $${(Number(broker.cashCents) / 100).toFixed(0)} and wallet would exceed that`
          );
        }
        return tx.account.update({
          where: { userId: user.id },
          data: { walletBalanceCents: projected },
        });
      }

      // Moving FROM wallet: cannot go below zero.
      const projected = acct.walletBalanceCents - amountCents;
      if (projected < BigInt(0)) {
        throw new Error(
          `cannot release $${amountUsd.toFixed(0)} — wallet only holds $${(Number(acct.walletBalanceCents) / 100).toFixed(0)}`
        );
      }
      return tx.account.update({
        where: { userId: user.id },
        data: { walletBalanceCents: projected },
      });
    });

    log.info('wallet.transfer', {
      userId: user.id,
      direction,
      amountCents: amountCents.toString(),
      newWalletBalanceCents: result.walletBalanceCents.toString(),
    });

    revalidatePath('/wallet');
    revalidatePath('/');
    revalidatePath('/settings');

    return NextResponse.json({
      ok: true,
      walletBalanceCents: result.walletBalanceCents.toString(),
    });
  } catch (err) {
    // Validation errors bubble up with their specific message. Other
    // failures (DB glitch, Alpaca down) get the generic 500.
    if (err instanceof Error && (err.message.startsWith('cannot ') || err.message === 'account not found')) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return apiError(err, 500, 'wallet transfer failed', 'wallet.transfer');
  }
}
