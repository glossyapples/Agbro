// GET /api/debug/performance-raw?range=1D|1W|1M|3M|YTD|1Y|ALL
//
// Returns raw Alpaca portfolio_history numbers plus the broker's live
// portfolio_value, so we can diagnose discrepancies between what the
// chart shows and what's actually in the account. No auth — same
// reasoning as the rest of /api/debug/*: no secrets in the payload,
// purpose is breaking the "user pastes screenshots, I guess" loop.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getPortfolioHistory,
  getBrokerAccount,
  type PortfolioHistoryRange,
} from '@/lib/alpaca';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({
  range: z.enum(['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL']).default('1W'),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({ range: url.searchParams.get('range') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const range = parsed.data.range as PortfolioHistoryRange;

  const out: Record<string, unknown> = { ok: true, range, now: new Date().toISOString() };

  try {
    const broker = await getBrokerAccount();
    out.broker = {
      portfolioValueUsd: Number(broker.portfolioValueCents) / 100,
      cashUsd: Number(broker.cashCents) / 100,
    };
  } catch (err) {
    out.broker = { error: (err as Error).message };
  }

  try {
    const series = await getPortfolioHistory(range);
    if (series.length === 0) {
      out.portfolio = { error: 'empty series' };
    } else {
      const first = series[0];
      const last = series[series.length - 1];
      const equityDiff = last.equity - first.equity;
      out.portfolio = {
        pointCount: series.length,
        firstTimestamp: new Date(first.timestampMs).toISOString(),
        firstEquity: first.equity,
        firstProfitLoss: first.profitLoss,
        firstProfitLossPct: first.profitLossPct,
        lastTimestamp: new Date(last.timestampMs).toISOString(),
        lastEquity: last.equity,
        lastProfitLoss: last.profitLoss,
        lastProfitLossPct: last.profitLossPct,
        equityDiff,
        // Quick comparison: if profit_loss agrees with raw equity diff,
        // alpaca isn't deposit-adjusting. If they differ, the gap = net
        // deposits/withdrawals over the range.
        profitLossVsEquityDiffGap: last.profitLoss - equityDiff,
      };
    }
  } catch (err) {
    out.portfolio = { error: (err as Error).message };
  }

  return NextResponse.json(out);
}
