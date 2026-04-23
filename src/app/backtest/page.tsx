import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { BacktestRunner } from '@/components/BacktestRunner';
import type { StrategyKey } from '@/lib/backtest/rules';

export const runtime = 'nodejs';

export default async function BacktestPage() {
  const user = await requirePageUser('/backtest');
  const runs = await prisma.backtestRun.findMany({
    where: { userId: user.id },
    orderBy: { runAt: 'desc' },
    take: 20,
  });

  const serialized = runs.map((r) => ({
    id: r.id,
    strategyKey: r.strategyKey as StrategyKey,
    mode: (r.mode as 'tier1' | 'tier2') ?? 'tier1',
    label: r.label,
    universe: r.universe,
    benchmarkSymbol: r.benchmarkSymbol,
    startDate: r.startDate.toISOString(),
    endDate: r.endDate.toISOString(),
    startingCashCents: r.startingCashCents.toString(),
    status: r.status,
    totalReturnPct: r.totalReturnPct,
    benchmarkReturnPct: r.benchmarkReturnPct,
    cagrPct: r.cagrPct,
    sharpeAnnual: r.sharpeAnnual,
    maxDrawdownPct: r.maxDrawdownPct,
    worstMonthPct: r.worstMonthPct,
    tradeCount: r.tradeCount,
    endingEquityCents: r.endingEquityCents?.toString() ?? null,
    equitySeries:
      r.equitySeries && Array.isArray(r.equitySeries)
        ? (r.equitySeries as Array<{ t: number; equity: number; benchmark: number }>)
        : null,
    eventLog:
      r.eventLog && Array.isArray(r.eventLog)
        ? (r.eventLog as Array<{
            date: string;
            event: string;
            details: Record<string, unknown>;
          }>)
        : null,
    runAt: r.runAt.toISOString(),
    errorMessage: r.errorMessage,
  }));

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3 pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Backtest</h1>
          <p className="mt-1 text-xs text-ink-400">
            Single-run backtester for custom date ranges. For the
            strategy-vs-window comparison matrix, use the{' '}
            <Link href="/backtest/grid" className="text-brand-400">
              robustness grid →
            </Link>
          </p>
        </div>
        <Link href="/" className="text-xs text-brand-400">
          ← Home
        </Link>
      </header>

      <section className="card border border-ink-700/60 bg-ink-800/40 text-[11px] text-ink-300">
        <p className="font-semibold text-ink-100">What this does + doesn&apos;t test</p>
        <ul className="mt-1 list-inside list-disc space-y-0.5">
          <li>
            <strong>Classic mode:</strong> deterministic strategy rules only —
            equal-weight day-zero deploy, rebalance on drift, target-sell,
            time-stop, regime detection. Same path that&apos;s been proven
            working. No LLM, no fundamentals screen.
          </li>
          <li>
            <strong>Fundamentals-aware mode:</strong> Classic plus a
            point-in-time EDGAR screen (ROE, P/E, D/E, gross margin, yield) at
            the decision date — no look-ahead. Symbols with no fundamentals
            data pass through unscreened (flagged in the audit) so partial
            coverage doesn&apos;t flatline a run.
          </li>
          <li>
            <strong>Does not test:</strong> LLM stock-picking (too expensive
            to run Opus historically). Neither mode uses the agent&apos;s
            picks — day-zero universe is what you supply.
          </li>
          <li>
            <strong>Suggested windows:</strong> 2008-01-01 → 2010-01-01 (GFC),
            2020-01-01 → 2021-01-01 (COVID), 2022-01-01 → 2023-01-01 (rate
            cycle), 2015-01-01 → 2020-01-01 (5y normal).
          </li>
          <li>
            Some symbols (newer ETFs like VXUS) have limited pre-2011 history.
            Expect fewer bars = fewer data points in the output chart.
          </li>
        </ul>
      </section>

      <BacktestRunner initialRuns={serialized} />
    </div>
  );
}
