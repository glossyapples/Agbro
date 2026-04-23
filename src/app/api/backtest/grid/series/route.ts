// GET /api/backtest/grid/series?windowKey=X — returns the equity series
// for every strategy's latest run in the given window, plus the shared
// benchmark series. Used by the overlay chart on /backtest/grid.
//
// Shapes kept narrow: we only send timestamp + percent-return-from-
// start per point, not the full BacktestRun object. Each series is
// rebased to 0% at the first point so strategies + benchmark can share
// a y-axis — the whole point of the overlay is direct visual
// comparison of trajectories, not dollar totals.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const windowKey = url.searchParams.get('windowKey');
  if (!windowKey) {
    return NextResponse.json({ error: 'windowKey required' }, { status: 400 });
  }

  try {
    const runs = await prisma.backtestRun.findMany({
      where: { userId: user.id, windowKey, status: 'completed' },
      orderBy: { runAt: 'desc' },
      select: {
        id: true,
        strategyKey: true,
        runAt: true,
        equitySeries: true,
      },
      take: 100,
    });

    // Keep the newest run per strategy (DB is ordered desc so first hit wins).
    const latest = new Map<string, (typeof runs)[number]>();
    for (const r of runs) {
      if (!latest.has(r.strategyKey)) latest.set(r.strategyKey, r);
    }

    type EquityPoint = { t: number; equity: number; benchmark: number };

    const strategySeries: Array<{
      strategyKey: string;
      runId: string;
      points: Array<{ t: number; pct: number }>;
      noData: boolean;
    }> = [];
    // We pick ONE run's benchmark as THE benchmark overlay — they should
    // all be identical since the benchmark is SPY for the same window
    // across all strategies. Grab from the newest run.
    let benchmarkPoints: Array<{ t: number; pct: number }> = [];
    let benchmarkTaken = false;

    for (const r of latest.values()) {
      const series = Array.isArray(r.equitySeries)
        ? (r.equitySeries as unknown as EquityPoint[])
        : [];

      // Runs with <2 equity points happen when Alpaca's free IEX feed
      // had no bars for the universe in the requested window (e.g.
      // pre-2015 dates). The run completed, but there's nothing to
      // chart. Previously we silently skipped these, which made the
      // overlay show 'No completed runs for this window yet' even
      // though the grid table right above it showed '+0.0%' cells —
      // confusing. Now we include them with noData: true so the
      // frontend can show an honest empty-for-data-reasons state.
      if (series.length < 2) {
        strategySeries.push({
          strategyKey: r.strategyKey,
          runId: r.id,
          points: [],
          noData: true,
        });
        continue;
      }

      const basis = series[0].equity;
      const benchBasis = series[0].benchmark;

      const pts = series.map((p) => ({
        t: p.t,
        pct: basis > 0 ? ((p.equity - basis) / basis) * 100 : 0,
      }));
      strategySeries.push({
        strategyKey: r.strategyKey,
        runId: r.id,
        points: pts,
        noData: false,
      });

      if (!benchmarkTaken) {
        benchmarkPoints = series.map((p) => ({
          t: p.t,
          pct: benchBasis > 0 ? ((p.benchmark - benchBasis) / benchBasis) * 100 : 0,
        }));
        benchmarkTaken = true;
      }
    }

    return NextResponse.json({
      windowKey,
      strategies: strategySeries,
      benchmark: benchmarkPoints,
    });
  } catch (err) {
    return apiError(err, 500, 'series fetch failed', 'backtest.grid_series');
  }
}
