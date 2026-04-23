// POST /api/backtest/grid — batch-run the robustness grid for one or
// more strategies across the visible (or held-out) window set.
//
// GET /api/backtest/grid — fetch the latest BacktestRun per
// (strategyKey, windowKey) cell for the caller. Used to render the
// grid on page load without kicking off fresh runs.
//
// Runs are executed with bounded parallelism (5 at a time) so the
// Alpaca bars API isn't pounded and the total request stays under the
// Railway 300s ceiling. The per-process bar cache makes the second
// wave fast because most symbols are already loaded.

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
import {
  BACKTEST_WINDOWS,
  VISIBLE_WINDOWS,
  HELDOUT_WINDOWS,
  windowByKey,
  type BacktestWindow,
} from '@/lib/backtest/windows';

export const runtime = 'nodejs';
export const maxDuration = 300;

const Body = z.object({
  strategyKeys: z
    .array(z.enum(STRATEGY_KEYS as [string, ...string[]]))
    .min(1)
    .max(STRATEGY_KEYS.length),
  // 'visible' runs the visible window set (for normal grid use).
  // 'held_out' runs the held-out set (for validating a hypothesised
  // improvement). Explicitly separate endpoints so the Proposer can
  // never accidentally see held-out results.
  windowSet: z.enum(['visible', 'held_out']),
});

async function runOneCell(
  userId: string,
  strategyKey: StrategyKey,
  window: BacktestWindow
): Promise<{ runId: string; ok: boolean; error?: string }> {
  const universe = DEFAULT_UNIVERSES[strategyKey];
  const startingCashCents = BigInt(100_000 * 100); // $100k fixed for cross-cell comparability
  const run = await prisma.backtestRun.create({
    data: {
      userId,
      strategyKey,
      windowKey: window.key,
      label: `${strategyKey} · ${window.label}`,
      universe,
      benchmarkSymbol: 'SPY',
      startDate: new Date(`${window.startDate}T00:00:00Z`),
      endDate: new Date(`${window.endDate}T23:59:59Z`),
      startingCashCents,
      status: 'running',
    },
  });
  try {
    const result = await runSimulation({
      strategyKey,
      universe,
      benchmarkSymbol: 'SPY',
      startDate: new Date(`${window.startDate}T00:00:00Z`),
      endDate: new Date(`${window.endDate}T23:59:59Z`),
      startingCashCents,
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
    return { runId: run.id, ok: true };
  } catch (err) {
    await prisma.backtestRun
      .update({
        where: { id: run.id },
        data: {
          status: 'errored',
          errorMessage: (err as Error).message.slice(0, 500),
          completedAt: new Date(),
        },
      })
      .catch(() => {});
    return { runId: run.id, ok: false, error: (err as Error).message };
  }
}

async function runInWaves<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 5
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(fn));
    out.push(...results);
  }
  return out;
}

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
    const { strategyKeys, windowSet } = parsed.data;
    const windows = windowSet === 'visible' ? VISIBLE_WINDOWS : HELDOUT_WINDOWS;

    const cells: Array<{ strategyKey: StrategyKey; window: BacktestWindow }> = [];
    for (const strategyKey of strategyKeys) {
      for (const window of windows) {
        cells.push({ strategyKey: strategyKey as StrategyKey, window });
      }
    }

    log.info('backtest.grid_start', {
      userId: user.id,
      strategyKeys,
      windowSet,
      cellCount: cells.length,
    });

    const t0 = Date.now();
    const results = await runInWaves(cells, (cell) =>
      runOneCell(user.id, cell.strategyKey, cell.window)
    );
    const elapsedMs = Date.now() - t0;
    const okCount = results.filter((r) => r.ok).length;
    const errCount = results.filter((r) => !r.ok).length;

    log.info('backtest.grid_complete', {
      userId: user.id,
      strategyKeys,
      windowSet,
      okCount,
      errCount,
      elapsedMs,
    });

    revalidatePath('/backtest/grid');
    return NextResponse.json({
      ok: true,
      ran: results.length,
      completed: okCount,
      errored: errCount,
      elapsedMs,
    });
  } catch (err) {
    return apiError(err, 500, 'grid run failed', 'backtest.grid');
  }
}

// GET: pull the latest BacktestRun per (strategyKey, windowKey). Feeds
// the grid UI so it renders whatever was last run for each cell without
// kicking off a fresh batch.
export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const runs = await prisma.backtestRun.findMany({
      where: {
        userId: user.id,
        windowKey: { not: null },
      },
      orderBy: { runAt: 'desc' },
      take: 500,
    });

    // Keep only the newest per (strategyKey, windowKey) pair.
    const latest = new Map<string, (typeof runs)[number]>();
    for (const r of runs) {
      const k = `${r.strategyKey}|${r.windowKey}`;
      if (!latest.has(k)) latest.set(k, r);
    }

    const cells = Array.from(latest.values()).map((r) => ({
      id: r.id,
      strategyKey: r.strategyKey,
      windowKey: r.windowKey!,
      totalReturnPct: r.totalReturnPct,
      benchmarkReturnPct: r.benchmarkReturnPct,
      cagrPct: r.cagrPct,
      sharpeAnnual: r.sharpeAnnual,
      maxDrawdownPct: r.maxDrawdownPct,
      tradeCount: r.tradeCount,
      status: r.status,
      runAt: r.runAt.toISOString(),
    }));

    return NextResponse.json({
      cells,
      windows: BACKTEST_WINDOWS,
    });
  } catch (err) {
    return apiError(err, 500, 'grid fetch failed', 'backtest.grid_get');
  }
}
