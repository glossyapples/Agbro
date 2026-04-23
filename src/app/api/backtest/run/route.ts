// POST /api/backtest/run — run a single backtest for the caller.
//
// Creates a BacktestRun row immediately (status='running'), runs the
// simulator synchronously, writes results back on the same row. Keeps
// the request lifecycle simple; acceptable because Alpaca bar fetches
// are the only slow part and they're cached per-process.
//
// Rate-limited via the default bucket — backtests aren't free (Alpaca
// bar fetches + modest DB writes) so cap per-user per-minute.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';
import { log } from '@/lib/logger';
import { runSimulation } from '@/lib/backtest/simulator';
import {
  STRATEGY_KEYS,
  DEFAULT_UNIVERSES,
  type StrategyKey,
} from '@/lib/backtest/rules';
import { computeMetrics } from '@/lib/backtest/metrics';

export const runtime = 'nodejs';
export const maxDuration = 180;

const Body = z.object({
  strategyKey: z.enum(STRATEGY_KEYS as [string, ...string[]]),
  universe: z.array(z.string().min(1).max(12)).max(30).optional(),
  benchmarkSymbol: z.string().min(1).max(12).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startingCashUsd: z.number().positive().max(10_000_000),
  label: z.string().max(120).optional(),
  // 'tier1' = deterministic rules only; 'tier2' = also apply
  // point-in-time EDGAR fundamentals filters.
  mode: z.enum(['tier1', 'tier2']).optional(),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const gate = await checkLimit(user.id, 'default');
  if (!gate.success) return rateLimited(gate);

  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { strategyKey, startDate, endDate, startingCashUsd, label } = parsed.data;
    const strategyKeyTyped = strategyKey as StrategyKey;
    const universe = parsed.data.universe ?? DEFAULT_UNIVERSES[strategyKeyTyped];
    const benchmarkSymbol = parsed.data.benchmarkSymbol ?? 'SPY';
    // Default mode = tier1 (classic, proven). Tier 2 must be opted into
    // explicitly so the stable path stays the default.
    const mode = parsed.data.mode ?? 'tier1';

    const run = await prisma.backtestRun.create({
      data: {
        userId: user.id,
        strategyKey,
        mode,
        label: label ?? null,
        universe,
        benchmarkSymbol,
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: new Date(`${endDate}T23:59:59Z`),
        startingCashCents: BigInt(Math.round(startingCashUsd * 100)),
        status: 'running',
      },
    });

    try {
      const startingCashCents = BigInt(Math.round(startingCashUsd * 100));
      const result = await runSimulation({
        strategyKey: strategyKeyTyped,
        universe,
        benchmarkSymbol,
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: new Date(`${endDate}T23:59:59Z`),
        startingCashCents,
        mode,
      });
      const metrics = computeMetrics(result.equitySeries);
      await prisma.backtestRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          endingEquityCents: result.endingEquityCents,
          benchmarkEndingCents: result.benchmarkEndingCents,
          totalReturnPct: metrics.totalReturnPct,
          benchmarkReturnPct: metrics.benchmarkReturnPct,
          cagrPct: metrics.cagrPct,
          sharpeAnnual: metrics.sharpeAnnual,
          maxDrawdownPct: metrics.maxDrawdownPct,
          worstMonthPct: metrics.worstMonthPct,
          tradeCount: result.tradeCount,
          equitySeries: result.equitySeries as unknown as Prisma.InputJsonValue,
          eventLog: result.eventLog as unknown as Prisma.InputJsonValue,
        },
      });
      log.info('backtest.completed', {
        userId: user.id,
        runId: run.id,
        strategyKey,
        totalReturnPct: metrics.totalReturnPct?.toFixed(2),
        vsBenchmarkPct:
          metrics.totalReturnPct != null && metrics.benchmarkReturnPct != null
            ? (metrics.totalReturnPct - metrics.benchmarkReturnPct).toFixed(2)
            : null,
        tradeCount: result.tradeCount,
      });
      revalidatePath('/backtest');
      return NextResponse.json({
        runId: run.id,
        status: 'completed',
        metrics,
        tradeCount: result.tradeCount,
      });
    } catch (simErr) {
      await prisma.backtestRun
        .update({
          where: { id: run.id },
          data: {
            status: 'errored',
            errorMessage: (simErr as Error).message.slice(0, 500),
            completedAt: new Date(),
          },
        })
        .catch(() => {});
      throw simErr;
    }
  } catch (err) {
    return apiError(err, 500, 'backtest failed', 'backtest.run');
  }
}
