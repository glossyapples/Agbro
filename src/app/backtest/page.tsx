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
    runAt: r.runAt.toISOString(),
    errorMessage: r.errorMessage,
  }));

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3 pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Backtest</h1>
          <p className="mt-1 text-xs text-ink-400">
            Replay a strategy against historical prices. Deterministic rules only
            (Tier 1) — no LLM judgement is simulated. Use to validate exit
            framework + rebalance + regime detection against real crash windows.
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
            <strong>Does test:</strong> rebalance mechanics, target-sell +
            time-stop exits (Graham), buy-and-hold through crashes, regime
            detection vs. historical crises, strategy comparison across the
            same window.
          </li>
          <li>
            <strong>Does not test:</strong> LLM stock-picking quality (too
            expensive to run Opus historically). Day-zero universe is either
            an equal-weight of what you supply or Boglehead&apos;s fixed
            target weights — not the agent&apos;s picks.
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
