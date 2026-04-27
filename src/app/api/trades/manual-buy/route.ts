// POST /api/trades/manual-buy — user-initiated buy of a stock.
//
// Mirror of manual-sell: bypasses the agent loop, goes straight to
// Alpaca via placeOrder, records a Trade row with thesis="manual
// buy by user" and agentRunId=null. The agent loop will see the new
// position on its next sync and react to it (forming opinions,
// running its own research, possibly adjusting weights) — that's the
// "make a trade and watch the team respond" loop the user asked for.
//
// Pause/stop flags still apply.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { cancelOrder, getLatestPrice, placeOrder } from '@/lib/alpaca';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  symbol: z.string().min(1).max(12),
  // Whole-share market-buy for v1. Fractional + limit can land later
  // — keeping the API surface small until we see the user actually
  // hit the limits of the simple form.
  qty: z.number().positive().finite().max(100_000),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const symbol = parsed.data.symbol.toUpperCase();
    const qty = parsed.data.qty;

    const account = await prisma.account.findUnique({ where: { userId: user.id } });
    if (!account) {
      return NextResponse.json({ error: 'account not found' }, { status: 404 });
    }
    if (account.isStopped) {
      return NextResponse.json(
        { error: 'account is stopped — trading disabled' },
        { status: 409 }
      );
    }
    if (account.isPaused) {
      return NextResponse.json(
        { error: 'account is paused — trading disabled' },
        { status: 409 }
      );
    }

    // Audit row before broker call so we have a trail even on failure.
    const pending = await prisma.trade.create({
      data: {
        userId: user.id,
        alpacaOrderId: null,
        symbol,
        side: 'buy',
        qty,
        status: 'pending',
        orderType: 'market',
        bullCase: null,
        bearCase: null,
        thesis: 'manual buy by user',
        confidence: null,
        agentRunId: null,
        assetClass: 'stock',
      },
    });

    let order;
    try {
      order = await placeOrder({
        symbol,
        qty,
        side: 'buy',
        orderType: 'market',
      });
    } catch (brokerErr) {
      await prisma.trade
        .update({
          where: { id: pending.id },
          data: {
            status: 'rejected',
            errorMessage: (brokerErr as Error).message.slice(0, 500),
          },
        })
        .catch(() => {});
      return apiError(brokerErr, 500, 'broker rejected manual buy', 'trade.manual_buy');
    }

    const price = await getLatestPrice(symbol).catch(() => null);

    try {
      await prisma.trade.update({
        where: { id: pending.id },
        data: {
          alpacaOrderId: order.id,
          status: 'submitted',
          fillPriceCents: price != null ? BigInt(Math.round(price * 100)) : null,
        },
      });
    } catch (dbErr) {
      log.error('trade.manual_buy_db_update_failed', dbErr, {
        tradeId: pending.id,
        alpacaOrderId: order.id,
      });
      await cancelOrder(order.id);
      return apiError(dbErr, 500, 'internal state after broker accept', 'trade.manual_buy');
    }

    await prisma.notification
      .create({
        data: {
          userId: user.id,
          tradeId: pending.id,
          kind: 'trade_placed',
          title: `BUY ${qty} ${symbol} (manual)`,
          body: 'Manual buy triggered from the UI. Agent will react on next sync.',
        },
      })
      .catch(() => {});

    log.info('trade.manual_buy', {
      userId: user.id,
      symbol,
      qty,
      tradeId: pending.id,
      alpacaOrderId: order.id,
    });

    revalidatePath('/trades');
    revalidatePath('/positions');
    revalidatePath('/analytics');
    revalidatePath('/');

    return NextResponse.json({
      tradeId: pending.id,
      alpacaOrderId: order.id,
      status: 'submitted',
    });
  } catch (err) {
    return apiError(err, 500, 'manual buy failed', 'trade.manual_buy');
  }
}
