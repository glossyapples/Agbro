// Tax-loss harvesting helpers. Two concerns:
//
//   1. Wash-sale avoidance (IRS §1091): if you sold a security at a loss, you
//      can't claim the loss if you (or your spouse) buy the same or
//      "substantially identical" security within 30 days on either side.
//      We prevent the sell-then-rebuy direction at the place_trade tool
//      level. The reverse direction (buy, then sell a separate lot at a
//      loss within 30 days of THAT buy) is harder to pre-empt and is rare
//      in a long-term value strategy — left unhandled for v1.
//
//   2. Q4 harvest opportunities: identify positions sitting on unrealised
//      losses late in the tax year where the thesis is already under
//      review. These are the ones worth harvesting — a broken thesis you
//      were going to exit anyway, done in December instead of January,
//      captures the loss for this year's tax return.
//
// Critical rule (encoded in prompts + here as a comment): NEVER harvest a
// conviction position just for the tax write-off. The signal only fires
// when the thesis is already weak.

import { prisma } from '@/lib/db';

const WASH_SALE_WINDOW_DAYS = 30;
const WASH_SALE_WINDOW_MS = WASH_SALE_WINDOW_DAYS * 86_400_000;

// Harvest threshold: dollar losses below this aren't worth the paperwork or
// the wash-sale risk. ~$100 is a reasonable floor for a retail account.
export const MIN_HARVEST_LOSS_USD = 100;

// Minimum holding period before a loss becomes harvest-eligible. Positions
// opened within the last 31 days are still close enough to a recent buy
// that selling would itself create a wash-sale risk (the buy-then-sell
// direction of §1091).
export const MIN_HARVEST_HELD_DAYS = 31;

export type WashSaleCheck = {
  blocked: boolean;
  reason?: string;
  recentSell?: {
    tradeId: string;
    submittedAt: Date;
    lossUsd: number;
  };
};

// Would buying `symbol` now trigger a wash-sale disallowance against a
// recent loss-realising sell? Returns blocked=true with a reason if yes.
export async function checkWashSaleBlock(
  userId: string,
  symbol: string,
  nowMs: number = Date.now()
): Promise<WashSaleCheck> {
  const cutoff = new Date(nowMs - WASH_SALE_WINDOW_MS);
  const recent = await prisma.trade.findFirst({
    where: {
      userId,
      symbol,
      side: 'sell',
      // submitted or filled — both count against the window
      status: { in: ['submitted', 'filled'] },
      submittedAt: { gte: cutoff },
      realizedPnlCents: { lt: BigInt(0) },
    },
    orderBy: { submittedAt: 'desc' },
    select: { id: true, submittedAt: true, realizedPnlCents: true },
  });
  if (!recent) return { blocked: false };
  const daysAgo = Math.floor((nowMs - recent.submittedAt.getTime()) / 86_400_000);
  const lossUsd = Math.abs(Number(recent.realizedPnlCents) / 100);
  return {
    blocked: true,
    reason: `buying ${symbol} would wash-sale against your ${daysAgo}-day-old loss-realising sale ($${lossUsd.toFixed(0)} loss). IRS §1091 disallows claiming the loss if you rebuy within 30 days. Wait ${WASH_SALE_WINDOW_DAYS - daysAgo} more day(s).`,
    recentSell: {
      tradeId: recent.id,
      submittedAt: recent.submittedAt,
      lossUsd,
    },
  };
}

// Is today inside the harvest-focus window? Standard practice: Q4. Outside
// this window, losses that warrant selling get handled by the normal thesis-
// break exit path without the "harvest" framing.
export function isHarvestSeason(now: Date = new Date()): boolean {
  // getMonth(): Oct=9, Nov=10, Dec=11
  return now.getMonth() >= 9;
}
