'use client';

// Walk-forward runner UI. Two modes via the tab switcher at the top:
//
//   • Single strategy — pick one preset, configure the harness, see
//     per-window CAGR / alpha / max drawdown plus the consistency
//     headline.
//   • Compare all presets — fan out the same harness across all six
//     preset strategies, render a progressive table that fills in
//     row by row as each preset completes. Sequential by design (the
//     simulator is heavy enough that we don't want six concurrent
//     runs hammering the DB pool); each preset reuses the same
//     /api/backtest/walk-forward endpoint, so this is a pure UI
//     orchestration on top of the existing server contract.
//
// Comparison runtime: ~2 min per preset × 6 = ~10-15 min wall-clock
// for a 10-year span at 24mo windows / 12mo step. Cost: $0 in API
// spend (the simulator has no LLM calls; Alpaca bars + EDGAR are
// free under our existing keys).

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

// State for one row of the compare-all-presets table. As each preset
// finishes its server-side walk-forward, the corresponding row flips
// from 'pending' → 'running' → 'completed' (or 'errored'). Aggregate
// is null until completed.
type CompareRow = {
  strategyKey: StrategyKey;
  status: 'pending' | 'running' | 'completed' | 'errored';
  aggregate: AggregateView | null;
  error: string | null;
};

function emptyCompareRows(): CompareRow[] {
  return STRATEGY_KEYS.map((k) => ({
    strategyKey: k,
    status: 'pending',
    aggregate: null,
    error: null,
  }));
}

export function WalkForwardRunner({ priorRuns }: { priorRuns: RunView[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<'single' | 'compare'>('single');
  const [strategyKey, setStrategyKey] = useState<StrategyKey>('buffett_core');
  const [totalStart, setTotalStart] = useState('2015-01-01');
  const [totalEnd, setTotalEnd] = useState('2024-12-31');
  const [windowMonths, setWindowMonths] = useState('24');
  const [stepMonths, setStepMonths] = useState('12');
  const [mode, setMode] = useState<'tier1' | 'tier2'>('tier1');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Compare-mode state. Distinct from single-mode busy/err so flipping
  // tabs mid-run doesn't lose the in-progress comparison.
  const [compareRows, setCompareRows] = useState<CompareRow[]>(emptyCompareRows);
  const [compareBusy, setCompareBusy] = useState(false);
  const [compareErr, setCompareErr] = useState<string | null>(null);

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

  // Sequential fan-out across all six preset strategies. Reuses the
  // single-strategy endpoint so this is pure UI orchestration — no
  // server changes. Each preset takes ~2 min, so the full sweep is
  // ~10-15 min wall-clock; the table fills in row by row as each
  // preset completes, so the page stays useful throughout.
  //
  // Sequential not parallel: six concurrent walk-forward calls would
  // each spawn N parallel simulator runs, hammering the DB pool.
  // Serial keeps the load profile identical to a single run.
  async function runComparison() {
    setCompareBusy(true);
    setCompareErr(null);
    setCompareRows(emptyCompareRows());

    for (const k of STRATEGY_KEYS) {
      // Mark this preset's row as running so the table shows progress
      // immediately rather than going dark for 2 min.
      setCompareRows((prev) =>
        prev.map((r) => (r.strategyKey === k ? { ...r, status: 'running' } : r))
      );
      try {
        const res = await fetch('/api/backtest/walk-forward', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            strategyKey: k,
            totalStart,
            totalEnd,
            windowMonths: Number(windowMonths),
            stepMonths: Number(stepMonths),
            mode,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            typeof body.error === 'string' ? body.error : `${res.status}`;
          setCompareRows((prev) =>
            prev.map((r) =>
              r.strategyKey === k
                ? { ...r, status: 'errored', error: msg }
                : r
            )
          );
          // Don't abort the sweep — one bad preset shouldn't stop the
          // others. The user wants the comparison; missing rows are
          // less useful than partial data.
          continue;
        }
        const aggregate = body.aggregate as AggregateView | undefined;
        setCompareRows((prev) =>
          prev.map((r) =>
            r.strategyKey === k
              ? { ...r, status: 'completed', aggregate: aggregate ?? null }
              : r
          )
        );
      } catch (e) {
        setCompareRows((prev) =>
          prev.map((r) =>
            r.strategyKey === k
              ? { ...r, status: 'errored', error: (e as Error).message }
              : r
          )
        );
      }
    }

    setCompareBusy(false);
    // Refresh the prior-runs section underneath — every preset's run
    // landed as a WalkForwardRun row.
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 rounded-md bg-ink-900 p-1 text-xs">
        <button
          type="button"
          onClick={() => setTab('single')}
          className={`flex-1 rounded-sm px-3 py-1.5 font-semibold transition ${
            tab === 'single'
              ? 'bg-ink-700 text-ink-50'
              : 'text-ink-400 hover:text-ink-200'
          }`}
        >
          Single strategy
        </button>
        <button
          type="button"
          onClick={() => setTab('compare')}
          className={`flex-1 rounded-sm px-3 py-1.5 font-semibold transition ${
            tab === 'compare'
              ? 'bg-ink-700 text-ink-50'
              : 'text-ink-400 hover:text-ink-200'
          }`}
        >
          Compare all presets
        </button>
      </div>

      <section className="card">
        <h2 className="text-sm font-semibold">Configure</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {tab === 'single' && (
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
          )}
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
        {tab === 'single' && err ? (
          <p className="mt-3 rounded-sm bg-rose-950 p-2 text-xs text-rose-300">
            {err}
          </p>
        ) : null}
        {tab === 'compare' && compareErr ? (
          <p className="mt-3 rounded-sm bg-rose-950 p-2 text-xs text-rose-300">
            {compareErr}
          </p>
        ) : null}
        {tab === 'compare' && (
          <p className="mt-3 text-[11px] text-ink-400">
            Runs the walk-forward harness against all six preset
            strategies sequentially. ~10-15 min wall-clock total; the
            table fills in row-by-row as each preset completes. $0 in
            API spend (the simulator is pure code; bar fetches + EDGAR
            are free under existing keys).
          </p>
        )}
        {tab === 'single' ? (
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {busy ? 'Running…' : 'Run walk-forward'}
          </button>
        ) : (
          <button
            type="button"
            onClick={runComparison}
            disabled={compareBusy}
            className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {compareBusy ? 'Comparing…' : 'Compare all six presets'}
          </button>
        )}
      </section>

      {tab === 'compare' && (
        <CompareTable rows={compareRows} busy={compareBusy} />
      )}

      {tab === 'single' && (priorRuns.length === 0 ? (
        <div className="rounded-md border border-dashed border-ink-700/60 p-6 text-center text-xs text-ink-400">
          No walk-forward runs yet. The first one validates whether your
          strategy actually has an out-of-sample edge.
        </div>
      ) : (
        priorRuns.map((r) => <RunCard key={r.id} run={r} />)
      ))}
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

// Comparison table — rows = presets, columns = consistency / median
// CAGR / median alpha / median DD / window count / status. Rows fill
// in progressively as each preset's walk-forward completes server-
// side. Cells stay grey while the preset is pending; current "running"
// preset gets a subtle pulse via opacity.
function CompareTable({
  rows,
  busy,
}: {
  rows: CompareRow[];
  busy: boolean;
}) {
  const completed = rows.filter((r) => r.status === 'completed');
  const sorted = [...rows].sort((a, b) => {
    // Stable order: completed rows ranked by consistency desc, then
    // by median CAGR. Pending / running / errored fall to the bottom
    // in their natural enum order.
    const order = (s: CompareRow['status']): number =>
      s === 'completed' ? 0 : s === 'running' ? 1 : s === 'errored' ? 2 : 3;
    const oa = order(a.status);
    const ob = order(b.status);
    if (oa !== ob) return oa - ob;
    if (a.aggregate && b.aggregate) {
      // Higher consistency first; tiebreak by median CAGR.
      const dc = b.aggregate.consistencyScore - a.aggregate.consistencyScore;
      if (dc !== 0) return dc;
      return (b.aggregate.medianCagrPct ?? 0) - (a.aggregate.medianCagrPct ?? 0);
    }
    return 0;
  });

  const heading =
    completed.length === rows.length
      ? `${completed.length} / ${rows.length} presets compared`
      : `${completed.length} / ${rows.length} presets — ${
          busy ? 'running' : 'paused'
        }`;

  return (
    <section className="card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Preset comparison</h2>
        <span className="text-[11px] text-ink-400">{heading}</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead className="text-ink-400">
            <tr className="border-b border-ink-800">
              <th className="py-2 pr-3 text-left font-medium">Strategy</th>
              <th className="py-2 px-2 text-right font-medium">Consistency</th>
              <th className="py-2 px-2 text-right font-medium">Median CAGR</th>
              <th className="py-2 px-2 text-right font-medium">Median alpha</th>
              <th className="py-2 px-2 text-right font-medium">Median DD</th>
              <th className="py-2 px-2 text-right font-medium">Windows</th>
              <th className="py-2 pl-2 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800/60">
            {sorted.map((r) => (
              <CompareRowView key={r.strategyKey} row={r} />
            ))}
          </tbody>
        </table>
      </div>
      {completed.length >= 2 && (
        <p className="mt-3 text-[11px] text-ink-400">
          Sorted by consistency score then median CAGR. A high consistency +
          positive median alpha is the only combination that suggests a real
          edge — high CAGR alone in one window is curve-fit by default.
        </p>
      )}
    </section>
  );
}

function CompareRowView({ row }: { row: CompareRow }) {
  const a = row.aggregate;
  const cagrColor =
    a?.medianCagrPct == null
      ? 'text-ink-400'
      : a.medianCagrPct >= 0
        ? 'text-emerald-400'
        : 'text-rose-400';
  const alphaColor =
    a?.medianAlphaPct == null
      ? 'text-ink-400'
      : a.medianAlphaPct >= 0
        ? 'text-emerald-300'
        : 'text-rose-300';
  const consistencyColor =
    a == null
      ? 'text-ink-400'
      : a.consistencyScore >= 0.6
        ? 'text-emerald-400'
        : a.consistencyScore >= 0.4
          ? 'text-amber-300'
          : 'text-rose-400';
  const opacity =
    row.status === 'running'
      ? 'opacity-70'
      : row.status === 'pending'
        ? 'opacity-40'
        : '';
  return (
    <tr className={`text-ink-200 ${opacity}`}>
      <td className="py-2 pr-3">{STRATEGY_LABELS[row.strategyKey]}</td>
      <td className={`py-2 px-2 text-right tabular-nums ${consistencyColor}`}>
        {a ? `${(a.consistencyScore * 100).toFixed(0)}%` : '—'}
      </td>
      <td className={`py-2 px-2 text-right tabular-nums ${cagrColor}`}>
        {a?.medianCagrPct != null
          ? `${a.medianCagrPct >= 0 ? '+' : ''}${a.medianCagrPct.toFixed(1)}%`
          : '—'}
      </td>
      <td className={`py-2 px-2 text-right tabular-nums ${alphaColor}`}>
        {a?.medianAlphaPct != null
          ? `${a.medianAlphaPct >= 0 ? '+' : ''}${a.medianAlphaPct.toFixed(1)}%`
          : '—'}
      </td>
      <td className="py-2 px-2 text-right tabular-nums text-rose-300">
        {a ? `${a.medianMaxDrawdownPct.toFixed(1)}%` : '—'}
      </td>
      <td className="py-2 px-2 text-right tabular-nums">
        {a ? a.windowCount : '—'}
      </td>
      <td className="py-2 pl-2 text-right text-[11px]">
        {row.status === 'pending' ? (
          <span className="text-ink-400">queued</span>
        ) : row.status === 'running' ? (
          <span className="text-amber-300">running…</span>
        ) : row.status === 'completed' ? (
          <span className="text-emerald-300">done</span>
        ) : (
          <span className="text-rose-400" title={row.error ?? ''}>
            error
          </span>
        )}
      </td>
    </tr>
  );
}
