import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { WalkForwardRunner } from '@/components/WalkForwardRunner';
import type { StrategyKey } from '@/lib/backtest/rules';

export const runtime = 'nodejs';

// Per-run row shape passed to the client. Mirrors the shape returned
// by POST /api/backtest/walk-forward, plus the persisted columns. We
// keep windows / aggregate as the structured Json so the heatmap can
// render without re-derivation.
type WindowView = {
  startISO: string;
  endISO: string;
  metrics: {
    cagrPct: number | null;
    maxDrawdownPct: number;
    sharpeAnnual: number | null;
    totalReturnPct: number;
    benchmarkReturnPct: number;
  };
  alphaPct: number | null;
  tradeCount: number;
};

type AggregateView = {
  medianCagrPct: number | null;
  medianMaxDrawdownPct: number;
  medianAlphaPct: number | null;
  consistencyScore: number;
  windowCount: number;
};

export default async function WalkForwardPage() {
  const user = await requirePageUser('/backtest/walk-forward');
  const runs = await prisma.walkForwardRun.findMany({
    where: { userId: user.id },
    orderBy: { startedAt: 'desc' },
    take: 12,
  });

  const serialized = runs.map((r) => ({
    id: r.id,
    strategyKey: r.strategyKey as StrategyKey,
    mode: r.mode as 'tier1' | 'tier2',
    totalStart: r.totalStart.toISOString().slice(0, 10),
    totalEnd: r.totalEnd.toISOString().slice(0, 10),
    windowMonths: r.windowMonths,
    stepMonths: r.stepMonths,
    universe: r.universe,
    benchmarkSymbol: r.benchmarkSymbol,
    status: r.status,
    errorMessage: r.errorMessage,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    windows: Array.isArray(r.windows) ? (r.windows as unknown as WindowView[]) : [],
    aggregate:
      r.aggregate && typeof r.aggregate === 'object'
        ? (r.aggregate as unknown as AggregateView | null)
        : null,
  }));

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Walk-forward</h1>
          <p className="mt-1 text-xs text-ink-400">
            Out-of-sample validation across rolling windows. A robust
            strategy looks similar in every window; a curve-fit one
            falls apart in any window that doesn't match the era it
            was tuned for.
          </p>
        </div>
        <Link href="/backtest" className="text-xs text-brand-400">
          ← Backtest
        </Link>
      </header>

      <WalkForwardRunner priorRuns={serialized} />
    </div>
  );
}
