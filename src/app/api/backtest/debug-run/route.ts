// GET /api/backtest/debug-run
//
// Operator-side endpoint that runs a real Tier 2 simulation server-side
// and returns the full event log inline (no DB persistence). Lets us
// verify the filter pass/reject behaviour without needing a UI session
// or polluting the user's BacktestRun history.
//
// Defaults to Buffett Core, 2018-01-01 → 2023-01-01, $100k. Override
// via query params: ?strategy=quality_compounders&start=2010-01-01&end=2020-01-01
//
// TEMPORARY auth bypass for the same reason as debug-fundamentals —
// remove from middleware exclusion when diagnostic session ends.

import { NextResponse } from 'next/server';
import { runSimulation, type BacktestMode } from '@/lib/backtest/simulator';
import { requireUser } from '@/lib/api';
import {
  STRATEGY_KEYS,
  DEFAULT_UNIVERSES,
  type StrategyKey,
} from '@/lib/backtest/rules';

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const strategyKey = (url.searchParams.get('strategy') ?? 'buffett_core') as StrategyKey;
  const mode = (url.searchParams.get('mode') ?? 'tier2') as BacktestMode;
  const startDate = url.searchParams.get('start') ?? '2018-01-01';
  const endDate = url.searchParams.get('end') ?? '2023-01-01';
  const startingCash = Number(url.searchParams.get('cash') ?? '100000');

  if (!STRATEGY_KEYS.includes(strategyKey)) {
    return NextResponse.json({ error: `unknown strategy: ${strategyKey}` }, { status: 400 });
  }

  const universe = DEFAULT_UNIVERSES[strategyKey];
  const startedAt = Date.now();
  const result = await runSimulation({
    strategyKey,
    universe,
    benchmarkSymbol: 'SPY',
    startDate: new Date(`${startDate}T00:00:00Z`),
    endDate: new Date(`${endDate}T23:59:59Z`),
    startingCashCents: BigInt(Math.round(startingCash * 100)),
    mode,
  });
  const elapsedMs = Date.now() - startedAt;

  // Classify events for a compact summary
  const filterPass = result.eventLog.filter((e) => e.event === 'filter_pass');
  const filterPassNoData = result.eventLog.filter((e) => e.event === 'filter_pass_no_data');
  const filterReject = result.eventLog.filter((e) => e.event === 'filter_reject');
  const filterEjection = result.eventLog.filter((e) => e.event === 'filter_rebalance_sell');

  // Per-symbol latest reason (collapse repeats)
  const passSymbols = Array.from(new Set(filterPass.map((e) => String(e.details.symbol ?? ''))));
  const noDataSymbols = Array.from(new Set(filterPassNoData.map((e) => String(e.details.symbol ?? ''))));
  const rejectFirstReason = new Map<string, string>();
  for (const e of filterReject) {
    const sym = String(e.details.symbol ?? '');
    if (!rejectFirstReason.has(sym)) {
      rejectFirstReason.set(sym, String(e.details.reason ?? ''));
    }
  }
  const ejectionFirstReason = new Map<string, string>();
  for (const e of filterEjection) {
    const sym = String(e.details.symbol ?? '');
    if (!ejectionFirstReason.has(sym)) {
      ejectionFirstReason.set(sym, String(e.details.reason ?? ''));
    }
  }

  const equityFirst = result.equitySeries[0]?.equity ?? 0;
  const equityLast = result.equitySeries[result.equitySeries.length - 1]?.equity ?? 0;
  const benchmarkFirst = result.equitySeries[0]?.benchmark ?? 0;
  const benchmarkLast = result.equitySeries[result.equitySeries.length - 1]?.benchmark ?? 0;
  const totalReturn = equityFirst > 0 ? ((equityLast - equityFirst) / equityFirst) * 100 : null;
  const benchReturn = benchmarkFirst > 0 ? ((benchmarkLast - benchmarkFirst) / benchmarkFirst) * 100 : null;

  return NextResponse.json({
    config: { strategyKey, mode, universe, startDate, endDate, startingCash },
    elapsedMs,
    summary: {
      tradeCount: result.tradeCount,
      equityStart: equityFirst,
      equityEnd: equityLast,
      totalReturnPct: totalReturn,
      benchmarkStart: benchmarkFirst,
      benchmarkEnd: benchmarkLast,
      benchmarkReturnPct: benchReturn,
      vsBenchmarkPct: totalReturn != null && benchReturn != null ? totalReturn - benchReturn : null,
    },
    filterAudit: {
      passSymbols,
      noDataSymbols,
      rejectsBySymbol: Object.fromEntries(rejectFirstReason),
      ejectionsBySymbol: Object.fromEntries(ejectionFirstReason),
      // Counts so we can see the audit at a glance
      counts: {
        pass: passSymbols.length,
        passNoData: noDataSymbols.length,
        rejectUniqueSymbols: rejectFirstReason.size,
        rejectEvents: filterReject.length,
        ejectionUniqueSymbols: ejectionFirstReason.size,
      },
    },
    // Last 10 events of any kind for tail context
    eventLogTail: result.eventLog.slice(-10),
  });
}
