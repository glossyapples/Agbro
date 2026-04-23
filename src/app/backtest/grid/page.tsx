import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { BACKTEST_WINDOWS } from '@/lib/backtest/windows';
import { BacktestGrid } from '@/components/BacktestGrid';

export const runtime = 'nodejs';

export default async function BacktestGridPage() {
  const user = await requirePageUser('/backtest/grid');

  // Pull the latest run per (strategyKey, windowKey) so the grid
  // paints on first byte. Client component refreshes after batch runs.
  const runs = await prisma.backtestRun.findMany({
    where: {
      userId: user.id,
      windowKey: { not: null },
    },
    orderBy: { runAt: 'desc' },
    take: 500,
  });
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    const key = `${r.strategyKey}|${r.windowKey}`;
    if (!latest.has(key)) latest.set(key, r);
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

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3 pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Robustness grid</h1>
          <p className="mt-1 text-xs text-ink-400">
            Every strategy across every historical window. Used to tell
            which strategies are consistently decent vs. which ones
            won a single lucky year.
          </p>
        </div>
        <Link href="/backtest" className="text-xs text-brand-400">
          ← Single run
        </Link>
      </header>

      <section className="card border border-ink-700/60 bg-ink-800/40 text-[11px] text-ink-300">
        <p className="font-semibold text-ink-100">How to use this grid without fooling yourself</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-4">
          <li>Make a change in the code based on a real hypothesis (e.g. "add dividend-safety exit per the Dividend Growth canon"). Never &quot;tweak numbers until things look better.&quot;</li>
          <li>Re-run the <strong>visible grid</strong>.</li>
          <li>Only keep the change if it improves on <strong>3+ windows</strong>.</li>
          <li>Then run <strong>held-out validation</strong>. The change must hold up there too — that&apos;s the anti-overfitting check.</li>
          <li>If held-out validates, ship. If not, back out and try a different hypothesis.</li>
        </ol>
        <p className="mt-2 text-ink-400">
          Cells show strategy total return · second line is vs-SPY delta.
          ⚠ icon means max drawdown exceeded -30% in that window.
          Click a cell to open the full run.
        </p>
      </section>

      <BacktestGrid initialCells={cells} windows={BACKTEST_WINDOWS} />
    </div>
  );
}
