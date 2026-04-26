// POST /api/backtest/walk-forward — run a walk-forward validation for
// the caller. Creates a WalkForwardRun row, runs the harness
// synchronously (each window's simulator call is sequential), writes
// per-window metrics + aggregate to the row. Slower than /run because
// it's running N simulations; rate-limited via the default bucket so a
// user can't hammer it.
//
// The single-run endpoint (/api/backtest/run) tells you what a strategy
// did on ONE slice of history. This one tells you what it does across
// many — the consistencyScore in the response is the headline.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';
import { log } from '@/lib/logger';
import { runWalkForward } from '@/lib/backtest/walk-forward';
import {
  STRATEGY_KEYS,
  DEFAULT_UNIVERSES,
  type StrategyKey,
} from '@/lib/backtest/rules';

export const runtime = 'nodejs';
// N windows × ~5-15s per window = comfortably under 5 min. The
// individual simulator already enforces a 180s ceiling.
export const maxDuration = 300;

const Body = z.object({
  strategyKey: z.enum(STRATEGY_KEYS as [string, ...string[]]),
  // ISO YYYY-MM-DD strings for the total span; the harness slices
  // them into rolling windows.
  totalStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Window length in months. 24 (two years) is a sane default —
  // long enough for a strategy's holding-period rules to play out,
  // short enough to give multiple samples in a 10-year span.
  windowMonths: z.number().int().min(6).max(120),
  // Step size. Smaller = more windows = more statistical power, but
  // also more correlation between windows. 12 (one year) gives
  // reasonable independence + good sample count.
  stepMonths: z.number().int().min(1).max(60),
  universe: z.array(z.string().min(1).max(12)).max(30).optional(),
  benchmarkSymbol: z.string().min(1).max(12).optional(),
  startingCashUsd: z.number().positive().max(10_000_000).optional(),
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
    const v = parsed.data;
    const strategyKeyTyped = v.strategyKey as StrategyKey;
    const universe = v.universe ?? DEFAULT_UNIVERSES[strategyKeyTyped];
    const benchmarkSymbol = v.benchmarkSymbol ?? 'SPY';
    const startingCashCents = BigInt(
      Math.round((v.startingCashUsd ?? 100_000) * 100)
    );
    const mode = v.mode ?? 'tier1';

    const totalStart = new Date(v.totalStart + 'T00:00:00Z');
    const totalEnd = new Date(v.totalEnd + 'T00:00:00Z');
    if (totalEnd.getTime() <= totalStart.getTime()) {
      return NextResponse.json(
        { error: 'totalEnd must be strictly after totalStart' },
        { status: 400 }
      );
    }

    // Persist the run row up front so the UI can poll for progress
    // (status === 'running' until the harness finishes). Same pattern
    // the single-run endpoint uses.
    const created = await prisma.walkForwardRun.create({
      data: {
        userId: user.id,
        strategyKey: v.strategyKey,
        mode,
        totalStart,
        totalEnd,
        windowMonths: v.windowMonths,
        stepMonths: v.stepMonths,
        universe,
        benchmarkSymbol,
        // Empty-shape placeholders until the harness writes back.
        windows: [] as unknown as Prisma.InputJsonValue,
        aggregate: {} as unknown as Prisma.InputJsonValue,
        status: 'running',
      },
    });

    log.info('walk_forward.start', {
      userId: user.id,
      runId: created.id,
      strategy: v.strategyKey,
      windowMonths: v.windowMonths,
      stepMonths: v.stepMonths,
    });

    try {
      const result = await runWalkForward({
        strategyKey: strategyKeyTyped,
        totalStart,
        totalEnd,
        windowMonths: v.windowMonths,
        stepMonths: v.stepMonths,
        universe,
        benchmarkSymbol,
        startingCashCents,
        mode,
      });

      const updated = await prisma.walkForwardRun.update({
        where: { id: created.id },
        data: {
          windows: result.windows as unknown as Prisma.InputJsonValue,
          aggregate: result.aggregate as unknown as Prisma.InputJsonValue,
          status: 'completed',
          completedAt: new Date(),
        },
      });

      log.info('walk_forward.completed', {
        userId: user.id,
        runId: created.id,
        windowCount: result.aggregate.windowCount,
        consistencyScore: result.aggregate.consistencyScore,
        medianCagrPct: result.aggregate.medianCagrPct,
      });

      revalidatePath('/backtest/walk-forward');
      return NextResponse.json({
        ok: true,
        id: updated.id,
        windows: result.windows,
        aggregate: result.aggregate,
      });
    } catch (runErr) {
      await prisma.walkForwardRun.update({
        where: { id: created.id },
        data: {
          status: 'errored',
          errorMessage: (runErr as Error).message.slice(0, 500),
          completedAt: new Date(),
        },
      });
      log.error('walk_forward.run_failed', runErr, { runId: created.id });
      return apiError(runErr, 500, 'walk-forward run failed', 'walk_forward.run');
    }
  } catch (err) {
    return apiError(err, 500, 'walk-forward request failed', 'walk_forward.post');
  }
}
