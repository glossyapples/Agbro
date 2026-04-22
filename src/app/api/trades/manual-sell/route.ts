// POST /api/trades/manual-sell — user-initiated sell of an open position.
//
// Bypasses the agent loop entirely. Goes straight to Alpaca via the
// existing placeOrder wrapper, records a Trade row with thesis="manual
// sell by user" and agentRunId=null so it's distinguishable from agent
// decisions in the trade log. Respects the user's account pause/stop
// flags the same way place_trade does.
//
// Not connected to the exit framework — this is the "I changed my mind"
// escape hatch, not a thesis-driven exit. Audit trail notes that.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import {
  cancelOrder,
  getLatestPrice,
  getPositions,
  placeOrder,
} from '@/lib/alpaca';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  symbol: z.string().min(1).max(12),
  // Optional partial-sell: if omitted, sell the full position at Alpaca.
  qty: z.number().positive().finite().optional(),
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

    // Pause/stop still apply — if the user paused trading, a manual sell
    // is still a trade and should be blocked consistently.
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

    // Resolve qty: either user-specified or full broker qty.
    type BrokerPosition = { symbol?: string; qty?: string };
    const positions = (await getPositions()) as BrokerPosition[];
    const pos = positions.find((p) => p.symbol?.toUpperCase() === symbol);
    if (!pos) {
      return NextResponse.json(
        { error: `no open position for ${symbol}` },
        { status: 404 }
      );
    }
    const heldQty = Number(pos.qty ?? 0);
    const qty = parsed.data.qty ?? heldQty;
    if (qty <= 0 || qty > heldQty) {
      return NextResponse.json(
        { error: `invalid qty — held ${heldQty} shares of ${symbol}` },
        { status: 400 }
      );
    }

    // Write a pending Trade row BEFORE hitting the broker so we have an
    // audit trail even if Alpaca errors out. thesis is a fixed string —
    // manual sells don't carry a bull/bear case.
    const pending = await prisma.trade.create({
      data: {
        userId: user.id,
        alpacaOrderId: null,
        symbol,
        side: 'sell',
        qty,
        status: 'pending',
        orderType: 'market',
        bullCase: null,
        bearCase: null,
        thesis: 'manual sell by user (not a thesis-driven exit)',
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
        side: 'sell',
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
      return apiError(brokerErr, 500, 'broker rejected manual sell', 'trade.manual_sell');
    }

    // Record realized P/L estimate the same way the agent path does.
    const dbPos = await prisma.position.findUnique({
      where: { userId_symbol: { userId: user.id, symbol } },
    });
    const price = await getLatestPrice(symbol).catch(() => null);
    let realizedPnlCents: bigint | null = null;
    if (dbPos && price != null && price > 0) {
      const avgCostPerShareCents = Number(dbPos.avgCostCents);
      const totalCostBasisCents = avgCostPerShareCents * qty;
      const totalProceedsCents = price * qty * 100;
      realizedPnlCents = BigInt(Math.round(totalProceedsCents - totalCostBasisCents));
    }

    try {
      await prisma.trade.update({
        where: { id: pending.id },
        data: {
          alpacaOrderId: order.id,
          status: 'submitted',
          fillPriceCents: price != null ? BigInt(Math.round(price * 100)) : null,
          realizedPnlCents,
          closedAt: new Date(),
        },
      });
    } catch (dbErr) {
      log.error('trade.manual_sell_db_update_failed', dbErr, {
        tradeId: pending.id,
        alpacaOrderId: order.id,
      });
      await cancelOrder(order.id);
      return apiError(dbErr, 500, 'internal state after broker accept', 'trade.manual_sell');
    }

    await prisma.notification
      .create({
        data: {
          userId: user.id,
          tradeId: pending.id,
          kind: 'trade_placed',
          title: `SELL ${qty} ${symbol} (manual)`,
          body: 'Manual sell triggered from the UI.',
        },
      })
      .catch(() => {});

    log.info('trade.manual_sell', {
      userId: user.id,
      symbol,
      qty,
      tradeId: pending.id,
      alpacaOrderId: order.id,
      realizedPnlCents: realizedPnlCents?.toString() ?? null,
    });

    revalidatePath('/trades');
    revalidatePath('/analytics');
    revalidatePath('/');

    return NextResponse.json({
      tradeId: pending.id,
      alpacaOrderId: order.id,
      status: 'submitted',
    });
  } catch (err) {
    return apiError(err, 500, 'manual sell failed', 'trade.manual_sell');
  }
}
