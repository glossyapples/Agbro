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
  // Optional on prior runs — defaults to false so old persisted rows
  // don't misreport as data-starved.
  dataStarved?: boolean;
};

type AggregateView = {
  medianCagrPct: number | null;
  medianMaxDrawdownPct: number;
  medianAlphaPct: number | null;
  consistencyScore: number;
  windowCount: number;
  // Data-quality signals (added for the diagnostic surface). Empty
  // optional on prior runs that pre-date the field — we treat
  // missing as undefined and the UI shows a "—" so older rows don't
  // misreport as "0 windows had data".
  windowsWithData?: number;
  tradesTotal?: number;
  // Count of windows excluded from medians + consistency due to data
  // starvation (Alpaca IEX coverage gap). Optional for back-compat.
  windowsStarved?: number;
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

// Consistency is measured on ALPHA (strategy CAGR minus benchmark
// CAGR), not raw CAGR — our strategies are rule-based so they can't
// be curve-fit, but their edge over the benchmark CAN be regime-
// dependent. A stable alpha across windows = real edge; a wildly
// varying alpha = the strategy only worked in one regime.
function consistencyLabel(score: number): {
  label: string;
  color: string;
  description: string;
} {
  if (score >= 0.8) {
    return {
      label: 'Stable edge',
      color: 'text-emerald-400',
      description:
        "Alpha vs benchmark stays roughly the same across every window — whatever the strategy is doing, it's doing it consistently across regimes.",
    };
  }
  if (score >= 0.6) {
    return {
      label: 'Mostly stable',
      color: 'text-emerald-300',
      description:
        'Alpha varies modestly across windows but no extreme era-dependent gaps.',
    };
  }
  if (score >= 0.4) {
    return {
      label: 'Mixed',
      color: 'text-amber-300',
      description:
        'Wider alpha spread between best and worst windows. Investigate which eras drive the variance.',
    };
  }
  if (score >= 0.2) {
    return {
      label: 'Regime-dependent',
      color: 'text-amber-400',
      description:
        "Strategy's edge over the benchmark depends heavily on market regime. The single-window alpha you see on /backtest is unlikely to repeat.",
    };
  }
  return {
    label: 'Highly regime-dependent',
    color: 'text-rose-400',
    description:
      "Alpha swings widely across windows — strategy beats benchmark in some eras and trails badly in others. Don't extrapolate any single in-sample run.",
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
  // Default totalStart bumped 2017 → 2019 after the first walk-forward
  // sweeps showed Alpaca's IEX free feed has gaps for VXUS / BND
  // (Boglehead) and many small-cap names well into 2018. Pre-2019
  // windows were running with cash sat idle (1 trade, 0% CAGR), and
  // even after the data-starved exclusion logic those windows are
  // wasted compute. 2019-start gives 6 yearly-step windows of clean
  // data, which is enough samples for the consistency metric. Users
  // who want the longer history can pick 2015/2017 manually — sparse
  // windows now self-flag in the UI rather than poisoning the median.
  const [totalStart, setTotalStart] = useState('2019-01-01');
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
          gives 5 samples across 2019-2024.
        </p>
        <p className="mt-1 text-[11px] text-ink-400">
          Default total-start is <strong>2019-01-01</strong> because Alpaca's
          free IEX feed has gaps for several Boglehead / small-cap symbols
          before then — earlier ranges produced "1 trade, 0% CAGR" windows
          where cash sat idle. Pick an earlier date if you want the longer
          history; data-starved windows now self-flag in the table and are
          excluded from aggregate medians.
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
        const starved = w.dataStarved === true;
        // Mute the whole card when starved — the numbers are
        // technically valid but reflect "cash sat idle" not strategy
        // performance, and we don't want them to read as a verdict.
        const muted = starved ? 'opacity-50' : '';
        const cagrColor =
          starved
            ? 'text-ink-400'
            : cagr == null
              ? 'text-ink-400'
              : cagr >= 0
                ? 'text-emerald-400'
                : 'text-rose-400';
        const alphaColor =
          starved
            ? 'text-ink-400'
            : w.alphaPct == null
              ? 'text-ink-400'
              : w.alphaPct >= 0
                ? 'text-emerald-300'
                : 'text-rose-300';
        return (
          <li
            key={`${w.startISO}-${w.endISO}`}
            className={`rounded-sm border p-3 text-xs ${
              starved ? 'border-amber-900 bg-amber-950/10' : 'border-ink-800'
            }`}
          >
            <div className="flex items-baseline justify-between">
              <span className={`font-semibold text-ink-200 ${muted}`}>
                {w.startISO} → {w.endISO}
              </span>
              <span className="flex items-baseline gap-2">
                {starved && (
                  <span
                    className="rounded-sm border border-amber-700 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-amber-300"
                    title="Strategy didn't deploy in this window — Alpaca IEX bar coverage gap. Excluded from aggregate medians + consistency."
                  >
                    Data starved
                  </span>
                )}
                <span className="text-ink-400">
                  {w.tradeCount} trade{w.tradeCount === 1 ? '' : 's'}
                </span>
              </span>
            </div>
            <div className={`mt-2 grid grid-cols-3 gap-2 tabular-nums ${muted}`}>
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
              <th
                className="py-2 px-2 text-right font-medium"
                title="Windows where the simulator actually produced an equity series. A low ratio means most windows hit the no-data short-circuit (Alpaca IEX coverage gaps, missing bars on a watchlist symbol). Treat metrics on a sparse-data row as a data verdict, not a strategy verdict."
              >
                Data
              </th>
              <th
                className="py-2 px-2 text-right font-medium"
                title="Total trades placed across every window in the sweep."
              >
                Trades
              </th>
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
        <div className="mt-3 space-y-1 text-[11px] text-ink-400">
          <p>
            <strong className="text-ink-300">Read order:</strong> check{' '}
            <em>Data</em> first. A row showing few "windows with data" or zero{' '}
            <em>Trades</em> means the simulator hit Alpaca's no-bars
            short-circuit on most slices — the strategy metrics aren't a
            verdict, they're missing data. Sparse-data rows are flagged and
            their strategy cells muted.
          </p>
          <p>
            <strong className="text-ink-300">Then:</strong> sorted by
            consistency score, tiebreak by median CAGR. Consistency here
            measures how stable the strategy's alpha is across windows
            (rule-based strategies can't curve-fit, but their edge can be
            regime-dependent). A high consistency + positive median alpha
            is the only combination that suggests a real edge.
          </p>
        </div>
      )}
    </section>
  );
}

function CompareRowView({ row }: { row: CompareRow }) {
  const a = row.aggregate;
  // Data quality. The "live windows" count = windows that produced an
  // equity series MINUS windows where the strategy didn't actually
  // deploy (data-starved). Aggregate medians + consistency are
  // computed on the live subset only, so this is the number that
  // backs the headline metrics. Sparse-data rows (< 50% live, or
  // zero trades total) get the strategy-metric cells de-emphasised
  // so the user reads them as "data verdict, not strategy verdict."
  const windowsWithData = a?.windowsWithData;
  const windowsStarved = a?.windowsStarved ?? 0;
  const tradesTotal = a?.tradesTotal;
  const liveWindows =
    a != null && windowsWithData != null ? windowsWithData - windowsStarved : null;
  const dataRatio =
    a && liveWindows != null && a.windowCount > 0
      ? liveWindows / a.windowCount
      : null;
  const sparseData =
    a != null &&
    ((dataRatio != null && dataRatio < 0.5) ||
      (tradesTotal != null && tradesTotal === 0));
  const dataColor = sparseData
    ? 'text-rose-400'
    : dataRatio == null
      ? 'text-ink-400'
      : dataRatio >= 0.9
        ? 'text-emerald-300'
        : dataRatio >= 0.5
          ? 'text-amber-300'
          : 'text-rose-400';
  // Strategy metrics get muted when data is sparse — so the eye
  // skips past them rather than reading "0% consistency" as a
  // strategy verdict.
  const muted = sparseData ? 'opacity-40' : '';
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
      <td className="py-2 pr-3">
        {STRATEGY_LABELS[row.strategyKey]}
        {sparseData && (
          <span
            className="ml-2 rounded-sm bg-rose-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-rose-300"
            title="Most windows had no bar data — Alpaca IEX feed didn't return prices for the universe in this range. Strategy metrics on this row reflect missing data, not the strategy's behaviour."
          >
            sparse data
          </span>
        )}
      </td>
      <td
        className={`py-2 px-2 text-right tabular-nums ${dataColor}`}
        title={
          a && liveWindows != null
            ? `${liveWindows} of ${a.windowCount} windows ran the strategy with enough data` +
              (windowsStarved > 0
                ? ` (${windowsStarved} excluded as data-starved — Alpaca IEX coverage gap)`
                : '')
            : undefined
        }
      >
        {a && liveWindows != null ? (
          <>
            {liveWindows}/{a.windowCount}
            {windowsStarved > 0 && (
              <span className="ml-1 text-amber-400" aria-label="data-starved windows excluded">
                ⚠
              </span>
            )}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="py-2 px-2 text-right tabular-nums text-ink-300">
        {a && tradesTotal != null ? tradesTotal.toLocaleString() : '—'}
      </td>
      <td className={`py-2 px-2 text-right tabular-nums ${consistencyColor} ${muted}`}>
        {a ? `${(a.consistencyScore * 100).toFixed(0)}%` : '—'}
      </td>
      <td className={`py-2 px-2 text-right tabular-nums ${cagrColor} ${muted}`}>
        {a?.medianCagrPct != null
          ? `${a.medianCagrPct >= 0 ? '+' : ''}${a.medianCagrPct.toFixed(1)}%`
          : '—'}
      </td>
      <td className={`py-2 px-2 text-right tabular-nums ${alphaColor} ${muted}`}>
        {a?.medianAlphaPct != null
          ? `${a.medianAlphaPct >= 0 ? '+' : ''}${a.medianAlphaPct.toFixed(1)}%`
          : '—'}
      </td>
      <td className={`py-2 px-2 text-right tabular-nums text-rose-300 ${muted}`}>
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
