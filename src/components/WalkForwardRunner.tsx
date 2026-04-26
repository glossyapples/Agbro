'use client';

// Walk-forward runner UI. Form on top → submit kicks off a multi-window
// simulation (server runs each slice sequentially; ~5-15s per window
// × N windows). Result row appears below the form with:
//   • headline consistencyScore (0..1) — how much the strategy's
//     CAGR varied across windows. Closer to 1 = robust; closer to 0 =
//     curve-fit / regime-dependent
//   • per-window grid: each window as a card with CAGR, alpha vs
//     benchmark, max drawdown, trade count
// Prior runs render below.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { STRATEGY_KEYS, STRATEGY_LABELS, type StrategyKey } from '@/lib/backtest/rules';

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

type RunView = {
  id: string;
  strategyKey: StrategyKey;
  mode: 'tier1' | 'tier2';
  totalStart: string;
  totalEnd: string;
  windowMonths: number;
  stepMonths: number;
  universe: string[];
  benchmarkSymbol: string;
  status: string;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  windows: WindowView[];
  aggregate: AggregateView | null;
};

function consistencyLabel(score: number): {
  label: string;
  color: string;
  description: string;
} {
  if (score >= 0.8) {
    return {
      label: 'Robust',
      color: 'text-emerald-400',
      description: 'Performance similar across every window — looks real.',
    };
  }
  if (score >= 0.6) {
    return {
      label: 'Mostly stable',
      color: 'text-emerald-300',
      description: 'Some variation across windows but no era-dependent gaps.',
    };
  }
  if (score >= 0.4) {
    return {
      label: 'Mixed',
      color: 'text-amber-300',
      description: 'Wider spread between best and worst windows. Investigate which eras drive the variance.',
    };
  }
  if (score >= 0.2) {
    return {
      label: 'Era-dependent',
      color: 'text-amber-400',
      description: 'Strategy works in some regimes and fails in others. Treat any in-sample CAGR with skepticism.',
    };
  }
  return {
    label: 'Likely curve-fit',
    color: 'text-rose-400',
    description: 'CAGR swings wildly across windows. Whatever made it work in a single backtest probably won\'t hold up forward.',
  };
}

export function WalkForwardRunner({ priorRuns }: { priorRuns: RunView[] }) {
  const router = useRouter();
  const [strategyKey, setStrategyKey] = useState<StrategyKey>('buffett_core');
  const [totalStart, setTotalStart] = useState('2015-01-01');
  const [totalEnd, setTotalEnd] = useState('2024-12-31');
  const [windowMonths, setWindowMonths] = useState('24');
  const [stepMonths, setStepMonths] = useState('12');
  const [mode, setMode] = useState<'tier1' | 'tier2'>('tier1');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/backtest/walk-forward', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategyKey,
          totalStart,
          totalEnd,
          windowMonths: Number(windowMonths),
          stepMonths: Number(stepMonths),
          mode,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(typeof body.error === 'string' ? body.error : 'Run failed');
        setBusy(false);
        return;
      }
      router.refresh();
      setBusy(false);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="card">
        <h2 className="text-sm font-semibold">Configure</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="col-span-2 text-xs text-ink-400">
            Strategy
            <select
              value={strategyKey}
              onChange={(e) => setStrategyKey(e.target.value as StrategyKey)}
              className="mt-1 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-sm"
            >
              {STRATEGY_KEYS.map((k) => (
                <option key={k} value={k}>
                  {STRATEGY_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-400">
            Total start
            <input
              type="date"
              value={totalStart}
              onChange={(e) => setTotalStart(e.target.value)}
              className="mt-1 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-sm"
            />
          </label>
          <label className="text-xs text-ink-400">
            Total end
            <input
              type="date"
              value={totalEnd}
              onChange={(e) => setTotalEnd(e.target.value)}
              className="mt-1 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-sm"
            />
          </label>
          <label className="text-xs text-ink-400">
            Window (months)
            <input
              type="number"
              min={6}
              max={120}
              value={windowMonths}
              onChange={(e) => setWindowMonths(e.target.value)}
              className="mt-1 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-sm"
            />
          </label>
          <label className="text-xs text-ink-400">
            Step (months)
            <input
              type="number"
              min={1}
              max={60}
              value={stepMonths}
              onChange={(e) => setStepMonths(e.target.value)}
              className="mt-1 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-sm"
            />
          </label>
          <label className="col-span-2 text-xs text-ink-400">
            Mode
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'tier1' | 'tier2')}
              className="mt-1 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-sm"
            >
              <option value="tier1">Tier 1 — deterministic rules</option>
              <option value="tier2">Tier 2 — also screen by EDGAR fundamentals</option>
            </select>
          </label>
        </div>
        <p className="mt-3 text-[11px] text-ink-400">
          Step &lt; window = overlapping windows = more samples for the
          consistency score. Default 24-month windows / 12-month step
          gives 9 samples on a 10-year span.
        </p>
        {err ? (
          <p className="mt-3 rounded-sm bg-rose-950 p-2 text-xs text-rose-300">
            {err}
          </p>
        ) : null}
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? 'Running…' : 'Run walk-forward'}
        </button>
      </section>

      {priorRuns.length === 0 ? (
        <div className="rounded-md border border-dashed border-ink-700/60 p-6 text-center text-xs text-ink-400">
          No walk-forward runs yet. The first one validates whether your
          strategy actually has an out-of-sample edge.
        </div>
      ) : (
        priorRuns.map((r) => <RunCard key={r.id} run={r} />)
      )}
    </div>
  );
}

function RunCard({ run }: { run: RunView }) {
  const a = run.aggregate;
  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {STRATEGY_LABELS[run.strategyKey]}{' '}
          <span className="text-xs font-normal text-ink-400">
            {run.totalStart} → {run.totalEnd}
          </span>
        </h3>
        <span className="text-[11px] text-ink-400">
          {run.windowMonths}mo windows · {run.stepMonths}mo step
        </span>
      </div>

      {run.status === 'running' ? (
        <p className="mt-3 text-xs text-amber-400">Running…</p>
      ) : run.status === 'errored' ? (
        <p className="mt-3 text-xs text-rose-400">
          Errored: {run.errorMessage ?? 'unknown'}
        </p>
      ) : a ? (
        <>
          <ConsistencyHeadline aggregate={a} />
          <WindowGrid windows={run.windows} />
        </>
      ) : (
        <p className="mt-3 text-xs text-ink-400">No aggregate data.</p>
      )}
    </section>
  );
}

function ConsistencyHeadline({ aggregate }: { aggregate: AggregateView }) {
  const c = consistencyLabel(aggregate.consistencyScore);
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div>
        <p className="stat-label">Consistency</p>
        <p className={`mt-0.5 text-base font-semibold ${c.color}`}>
          {(aggregate.consistencyScore * 100).toFixed(0)}%
        </p>
        <p className="text-[10px] text-ink-400">{c.label}</p>
      </div>
      <div>
        <p className="stat-label">Median CAGR</p>
        <p className="mt-0.5 text-base font-semibold tabular-nums">
          {aggregate.medianCagrPct != null
            ? `${aggregate.medianCagrPct >= 0 ? '+' : ''}${aggregate.medianCagrPct.toFixed(1)}%`
            : '—'}
        </p>
      </div>
      <div>
        <p className="stat-label">Median alpha</p>
        <p
          className={`mt-0.5 text-base font-semibold tabular-nums ${
            (aggregate.medianAlphaPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
          }`}
        >
          {aggregate.medianAlphaPct != null
            ? `${aggregate.medianAlphaPct >= 0 ? '+' : ''}${aggregate.medianAlphaPct.toFixed(1)}%`
            : '—'}
        </p>
      </div>
      <div>
        <p className="stat-label">Median DD</p>
        <p className="mt-0.5 text-base font-semibold text-rose-300 tabular-nums">
          {aggregate.medianMaxDrawdownPct.toFixed(1)}%
        </p>
      </div>
      <p className="col-span-2 mt-1 text-[11px] text-ink-400 sm:col-span-4">
        {c.description}
      </p>
    </div>
  );
}

function WindowGrid({ windows }: { windows: WindowView[] }) {
  return (
    <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {windows.map((w) => {
        const cagr = w.metrics.cagrPct;
        const cagrColor =
          cagr == null
            ? 'text-ink-400'
            : cagr >= 0
              ? 'text-emerald-400'
              : 'text-rose-400';
        const alphaColor =
          w.alphaPct == null
            ? 'text-ink-400'
            : w.alphaPct >= 0
              ? 'text-emerald-300'
              : 'text-rose-300';
        return (
          <li
            key={`${w.startISO}-${w.endISO}`}
            className="rounded-sm border border-ink-800 p-3 text-xs"
          >
            <div className="flex items-baseline justify-between">
              <span className="font-semibold text-ink-200">
                {w.startISO} → {w.endISO}
              </span>
              <span className="text-ink-400">
                {w.tradeCount} trade{w.tradeCount === 1 ? '' : 's'}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 tabular-nums">
              <div>
                <p className="stat-label">CAGR</p>
                <p className={`text-sm font-semibold ${cagrColor}`}>
                  {cagr != null
                    ? `${cagr >= 0 ? '+' : ''}${cagr.toFixed(1)}%`
                    : '—'}
                </p>
              </div>
              <div>
                <p className="stat-label">Alpha</p>
                <p className={`text-sm font-semibold ${alphaColor}`}>
                  {w.alphaPct != null
                    ? `${w.alphaPct >= 0 ? '+' : ''}${w.alphaPct.toFixed(1)}%`
                    : '—'}
                </p>
              </div>
              <div>
                <p className="stat-label">Max DD</p>
                <p className="text-sm font-semibold text-rose-300">
                  {w.metrics.maxDrawdownPct.toFixed(1)}%
                </p>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
