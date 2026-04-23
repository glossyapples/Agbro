'use client';

// Robustness grid — strategies × historical windows. Each cell shows
// the strategy's total return in that window, coloured green/red vs.
// zero, with a secondary "vs benchmark" line underneath. Click a cell
// to jump to the full run detail.
//
// Two batch buttons:
//   - "Run visible grid" — fills the displayed cells. Fine to re-run
//     whenever the rule set changes and the grid needs a refresh.
//   - "Run held-out validation" — runs the separate held-out window
//     set. Results are NOT shown in the main grid by default; they
//     appear in a collapsed "held-out" section. This discipline
//     matters — a change that only improves the visible grid is
//     probably overfit; you need it to improve held-out too.

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  STRATEGY_KEYS,
  STRATEGY_LABELS,
  type StrategyKey,
} from '@/lib/backtest/rules';
import type { BacktestWindow } from '@/lib/backtest/windows';

type Cell = {
  id: string;
  strategyKey: string;
  windowKey: string;
  totalReturnPct: number | null;
  benchmarkReturnPct: number | null;
  cagrPct: number | null;
  sharpeAnnual: number | null;
  maxDrawdownPct: number | null;
  tradeCount: number | null;
  status: string;
  runAt: string;
};

export function BacktestGrid({
  initialCells,
  windows,
}: {
  initialCells: Cell[];
  windows: BacktestWindow[];
}) {
  const router = useRouter();
  const [cells, setCells] = useState(initialCells);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [showHeldOut, setShowHeldOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const inFlight = useRef(false);

  const visibleWindows = useMemo(() => windows.filter((w) => !w.heldOut), [windows]);
  const heldOutWindows = useMemo(() => windows.filter((w) => w.heldOut), [windows]);

  function cellFor(strategyKey: string, windowKey: string): Cell | null {
    return cells.find((c) => c.strategyKey === strategyKey && c.windowKey === windowKey) ?? null;
  }

  async function runBatch(windowSet: 'visible' | 'held_out') {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setLastResult(null);
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    try {
      const res = await fetch('/api/backtest/grid', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategyKeys: STRATEGY_KEYS,
          windowSet,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(
          typeof body.error === 'string'
            ? body.error
            : 'grid run failed — check server log'
        );
        return;
      }
      const data = await res.json();
      setLastResult(
        `Completed ${data.completed}/${data.ran} cells in ${(data.elapsedMs / 1000).toFixed(0)}s` +
          (data.errored > 0 ? ` · ${data.errored} errored` : '')
      );
      // Refetch the grid cells.
      const g = await fetch('/api/backtest/grid');
      if (g.ok) {
        const payload = await g.json();
        setCells(payload.cells);
      }
      // Signal sibling components (StrategyOverlayChart) that fresh
      // runs have landed so they can refetch without a full page
      // reload. Window-event glue is intentionally loose — components
      // that want to react just listen for 'agbro:grid-runs-updated'.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agbro:grid-runs-updated'));
      }
      router.refresh();
    } catch (e) {
      setError(`Network error — ${(e as Error).message.slice(0, 120)}`);
    } finally {
      clearInterval(timer);
      setBusy(false);
      setElapsed(0);
      inFlight.current = false;
    }
  }

  return (
    <>
      <section className="card flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Batch runs</h2>
            <p className="mt-0.5 text-[11px] text-ink-400">
              &quot;Run visible grid&quot; runs every strategy across every visible
              window (~1–3 min). Held-out validation is separate so the data used to
              form a hypothesis stays distinct from the data used to validate it.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => runBatch('visible')}
            disabled={busy}
            className={`btn-primary ${busy ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            {busy ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-ink-900/50 border-t-ink-900" />
                Running {elapsed}s
              </span>
            ) : (
              `↻ Run visible grid (${STRATEGY_KEYS.length} × ${visibleWindows.length})`
            )}
          </button>
          <button
            onClick={() => runBatch('held_out')}
            disabled={busy}
            className="btn-ghost disabled:opacity-50"
          >
            Run held-out validation ({STRATEGY_KEYS.length} × {heldOutWindows.length})
          </button>
        </div>

        {busy && (
          <div className="rounded-md border border-brand-500/40 bg-brand-500/5 p-3 text-xs">
            <p className="flex items-center gap-2 font-semibold text-brand-300">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-400" />
              Grid running · {elapsed}s elapsed
            </p>
            <p className="mt-1 text-ink-300">
              Running cells in waves of 5. Alpaca bar cache warms up after the first
              couple waves so later cells complete faster. You can navigate away —
              results save as each cell finishes.
            </p>
          </div>
        )}

        {lastResult && <p className="text-xs text-brand-400">✓ {lastResult}</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </section>

      <GridTable
        title="Visible grid"
        subtitle="Used to reason about strategy performance. If a change improves these cells, validate it against held-out before shipping."
        windows={visibleWindows}
        strategyKeys={STRATEGY_KEYS}
        cellFor={cellFor}
      />

      <section className="card">
        <button
          onClick={() => setShowHeldOut((v) => !v)}
          className="flex w-full items-center justify-between text-left"
        >
          <div>
            <h2 className="text-sm font-semibold">Held-out validation</h2>
            <p className="mt-0.5 text-[11px] text-ink-400">
              Kept separate. Only check these after you&apos;ve made a change
              based on visible-grid reasoning — if it wins here too, it&apos;s
              more likely generalising than overfitting.
            </p>
          </div>
          <span className="text-brand-400">{showHeldOut ? '▾' : '▸'}</span>
        </button>
        {showHeldOut && (
          <div className="mt-3">
            <GridTable
              title=""
              subtitle=""
              windows={heldOutWindows}
              strategyKeys={STRATEGY_KEYS}
              cellFor={cellFor}
              compact
            />
          </div>
        )}
      </section>
    </>
  );
}

function GridTable({
  title,
  subtitle,
  windows,
  strategyKeys,
  cellFor,
  compact = false,
}: {
  title: string;
  subtitle: string;
  windows: BacktestWindow[];
  strategyKeys: readonly StrategyKey[];
  cellFor: (s: string, w: string) => Cell | null;
  compact?: boolean;
}) {
  if (windows.length === 0) return null;
  return (
    <section className={compact ? undefined : 'card'}>
      {title && (
        <div className="mb-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[11px] text-ink-400">{subtitle}</p>}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-ink-400">
              <th className="p-2 pl-0">Strategy</th>
              {windows.map((w) => (
                <th key={w.key} className="p-2 text-right" title={w.description}>
                  {w.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {strategyKeys.map((s) => (
              <tr key={s} className="border-t border-ink-700/60">
                <th className="p-2 pl-0 text-left text-ink-200">{STRATEGY_LABELS[s]}</th>
                {windows.map((w) => {
                  const cell = cellFor(s, w.key);
                  return (
                    <td key={w.key} className="p-2 text-right tabular-nums">
                      <CellDisplay cell={cell} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CellDisplay({ cell }: { cell: Cell | null }) {
  if (!cell) {
    return <span className="text-ink-500">—</span>;
  }
  if (cell.status === 'running') {
    return <span className="text-ink-400">…</span>;
  }
  if (cell.status === 'errored') {
    return <span className="text-red-300">err</span>;
  }
  const total = cell.totalReturnPct;
  const bench = cell.benchmarkReturnPct;
  const vs = total != null && bench != null ? total - bench : null;
  const color = total == null ? 'text-ink-300' : total >= 0 ? 'text-brand-400' : 'text-red-300';
  const vsColor = vs == null ? 'text-ink-500' : vs >= 0 ? 'text-brand-300' : 'text-red-300';
  const drawdownSevere = cell.maxDrawdownPct != null && cell.maxDrawdownPct <= -30;
  return (
    <Link href={`/backtest?run=${cell.id}`} className="flex flex-col items-end">
      <span className={`flex items-center gap-1 font-semibold ${color}`}>
        {fmtPct(total)}
        {drawdownSevere && (
          <span
            title={`Max drawdown ${fmtPct(cell.maxDrawdownPct)}`}
            className="text-[10px] text-red-400"
          >
            ⚠
          </span>
        )}
      </span>
      {vs != null && (
        <span className={`text-[10px] ${vsColor}`}>
          vs {vs >= 0 ? '+' : ''}
          {vs.toFixed(1)}
        </span>
      )}
    </Link>
  );
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}
