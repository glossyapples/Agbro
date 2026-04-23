'use client';

// Backtest launcher + results viewer. Pure client component — all the
// historical data fetching happens server-side via /api/backtest/run.
// UI shows the previous runs plus a form to launch a new one, and
// renders the equity curve + metrics table for whichever run is
// selected.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  STRATEGY_KEYS,
  STRATEGY_LABELS,
  DEFAULT_UNIVERSES,
  type StrategyKey,
} from '@/lib/backtest/rules';
import { formatUsd } from '@/lib/money';

type Run = {
  id: string;
  strategyKey: StrategyKey;
  label: string | null;
  universe: string[];
  benchmarkSymbol: string;
  startDate: string;
  endDate: string;
  startingCashCents: string;
  status: string;
  totalReturnPct: number | null;
  benchmarkReturnPct: number | null;
  cagrPct: number | null;
  sharpeAnnual: number | null;
  maxDrawdownPct: number | null;
  worstMonthPct: number | null;
  tradeCount: number | null;
  endingEquityCents: string | null;
  equitySeries: Array<{ t: number; equity: number; benchmark: number }> | null;
  eventLog: Array<{
    date: string;
    event: string;
    details: Record<string, unknown>;
  }> | null;
  runAt: string;
  errorMessage: string | null;
};

export function BacktestRunner({ initialRuns }: { initialRuns: Run[] }) {
  const router = useRouter();
  const [runs, setRuns] = useState(initialRuns);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialRuns.find((r) => r.status === 'completed')?.id ?? null
  );

  // Sync local state when the server re-renders with fresh data after
  // router.refresh() (post-run). Without this, useState(initialRuns)
  // only captures the first render, so a newly-completed run never
  // appeared in the list until a manual page refresh.
  //
  // Also auto-select the newest completed run if the current selection
  // is an optimistic 'pending-...' row whose real counterpart has just
  // arrived. Matches by label as a heuristic — strategyKey + window
  // dates would be more robust but label is reliable enough since we
  // construct it deterministically at click time.
  useEffect(() => {
    setRuns(initialRuns);
    setSelectedId((current) => {
      if (current == null) {
        return initialRuns.find((r) => r.status === 'completed')?.id ?? null;
      }
      if (current.startsWith('pending-')) {
        // Our optimistic row just got replaced by a real one. Find the
        // newest completed run and select it.
        const newest = initialRuns.find((r) => r.status === 'completed');
        return newest?.id ?? null;
      }
      // Keep current selection if the run still exists in the new list.
      if (initialRuns.some((r) => r.id === current)) return current;
      return initialRuns.find((r) => r.status === 'completed')?.id ?? null;
    });
  }, [initialRuns]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Belt-and-suspenders against double-submit: React's disabled attribute
  // stops onClick from firing, but a rapid keystroke or framework hiccup
  // could theoretically slip through. inFlight is a ref so it updates
  // synchronously (not batched like state) and guards the function body.
  const inFlight = useRef(false);
  // Elapsed seconds for the progress indicator — a running counter
  // reassures the user that something is actually happening.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!busy) {
      setElapsedSec(0);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(interval);
  }, [busy]);

  const [strategyKey, setStrategyKey] = useState<StrategyKey>('buffett_core');
  const [startDate, setStartDate] = useState('2020-01-01');
  const [endDate, setEndDate] = useState('2021-01-01');
  const [cash, setCash] = useState('100000');
  const [universe, setUniverse] = useState<string>(
    DEFAULT_UNIVERSES.buffett_core.join(',')
  );

  const selected = selectedId ? runs.find((r) => r.id === selectedId) ?? null : null;

  async function run() {
    if (inFlight.current) return; // synchronous guard against duplicate submits
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const label = `${STRATEGY_LABELS[strategyKey]} ${startDate}→${endDate}`;
    // Optimistic pending row so the user sees the run appear in the list
    // the moment they click. Replaced by the real row on completion via
    // router.refresh().
    const pendingId = `pending-${Date.now()}`;
    const optimistic: Run = {
      id: pendingId,
      strategyKey,
      label,
      universe: universe
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      benchmarkSymbol: 'SPY',
      startDate: `${startDate}T00:00:00Z`,
      endDate: `${endDate}T23:59:59Z`,
      startingCashCents: String(Math.round((Number(cash) || 100000) * 100)),
      status: 'running',
      totalReturnPct: null,
      benchmarkReturnPct: null,
      cagrPct: null,
      sharpeAnnual: null,
      maxDrawdownPct: null,
      worstMonthPct: null,
      tradeCount: null,
      endingEquityCents: null,
      equitySeries: null,
      eventLog: null,
      runAt: new Date().toISOString(),
      errorMessage: null,
    };
    setRuns((r) => [optimistic, ...r]);
    setSelectedId(pendingId);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategyKey,
          universe: optimistic.universe,
          startDate,
          endDate,
          startingCashUsd: Number(cash) || 100000,
          label,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(extractError(body));
        setRuns((r) => r.filter((x) => x.id !== pendingId));
        return;
      }
      router.refresh();
    } catch (e) {
      setError(`Network error — ${(e as Error).message.slice(0, 120)}`);
      setRuns((r) => r.filter((x) => x.id !== pendingId));
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  // Fallback: presets can override universe when strategy changes.
  function onStrategyChange(k: StrategyKey) {
    setStrategyKey(k);
    setUniverse(DEFAULT_UNIVERSES[k].join(','));
  }

  return (
    <>
      <section className="card flex flex-col gap-3">
        <h2 className="text-sm font-semibold">New backtest</h2>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-ink-400">Strategy</label>
          <select
            value={strategyKey}
            onChange={(e) => onStrategyChange(e.target.value as StrategyKey)}
          >
            {STRATEGY_KEYS.map((k) => (
              <option key={k} value={k}>
                {STRATEGY_LABELS[k]}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] text-ink-400">Start date</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="text-[11px] text-ink-400">End date</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>

        <div>
          <label className="text-[11px] text-ink-400">Starting cash (USD)</label>
          <input
            type="number"
            value={cash}
            onChange={(e) => setCash(e.target.value)}
            min={1000}
            max={10_000_000}
          />
        </div>

        <div>
          <label className="text-[11px] text-ink-400">Universe (comma-separated)</label>
          <input
            type="text"
            value={universe}
            onChange={(e) => setUniverse(e.target.value)}
          />
          <p className="mt-0.5 text-[10px] text-ink-500">
            Default set for this strategy is filled in. Symbols must have bar history
            across the selected window — IPOs and new ETFs won&apos;t have data pre-launch.
          </p>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-[11px] text-ink-400">
            Tier 1 backtest: deterministic rules only (no LLM reasoning).
          </p>
          <button
            onClick={run}
            disabled={busy}
            className={`btn-primary ${busy ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            {busy ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-ink-900/50 border-t-ink-900" />
                Running…
              </span>
            ) : (
              'Run backtest'
            )}
          </button>
        </div>

        {busy && (
          <div className="rounded-md border border-brand-500/40 bg-brand-500/5 p-3 text-xs">
            <p className="flex items-center gap-2 font-semibold text-brand-300">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-400" />
              Backtest running · {elapsedSec}s elapsed
            </p>
            <p className="mt-1 text-ink-300">
              Fetching Alpaca historical bars → walking the simulator day-by-day →
              computing metrics. Typically 10–30s for a 1-year window, up to a
              minute for 5+ years. You can navigate away — the run is saved server-
              side as soon as it finishes.
            </p>
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">Runs</h2>
        {runs.length === 0 ? (
          <p className="mt-1 text-sm text-ink-400">No runs yet. Kick off one above.</p>
        ) : (
          <ul className="mt-2 divide-y divide-ink-700/60">
            {runs.map((r) => {
              const active = r.id === selectedId;
              const vsBench =
                r.totalReturnPct != null && r.benchmarkReturnPct != null
                  ? r.totalReturnPct - r.benchmarkReturnPct
                  : null;
              return (
                <li
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`flex cursor-pointer items-center justify-between py-2 text-sm ${
                    active ? 'text-ink-50' : 'text-ink-200'
                  }`}
                >
                  <div>
                    <p className="font-semibold">
                      {STRATEGY_LABELS[r.strategyKey] ?? r.strategyKey}
                      {r.label && <span className="ml-2 text-[10px] font-normal text-ink-400">{r.label}</span>}
                    </p>
                    <p className="text-[11px] text-ink-400">
                      {r.startDate.slice(0, 10)} → {r.endDate.slice(0, 10)} · {r.status}
                    </p>
                  </div>
                  <div className="text-right text-xs">
                    {r.status === 'completed' && r.totalReturnPct != null ? (
                      <>
                        <p className={r.totalReturnPct >= 0 ? 'text-brand-400' : 'text-red-300'}>
                          {r.totalReturnPct >= 0 ? '+' : ''}
                          {r.totalReturnPct.toFixed(1)}%
                        </p>
                        {vsBench != null && (
                          <p className={`text-[10px] ${vsBench >= 0 ? 'text-brand-300' : 'text-red-300'}`}>
                            vs bench {vsBench >= 0 ? '+' : ''}
                            {vsBench.toFixed(1)}%
                          </p>
                        )}
                      </>
                    ) : r.status === 'errored' ? (
                      <p className="text-red-300">errored</p>
                    ) : (
                      <p className="text-ink-400">…</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {selected && selected.status === 'completed' && selected.equitySeries && (
        <SelectedRun run={selected} />
      )}
      {selected && selected.status === 'errored' && (
        <section className="card border border-red-500/40 bg-red-500/5 text-xs text-red-300">
          <p className="font-semibold">Errored</p>
          <p className="mt-1">{selected.errorMessage ?? 'Unknown error'}</p>
        </section>
      )}
    </>
  );
}

function SelectedRun({ run }: { run: Run }) {
  const series = run.equitySeries ?? [];
  const { pathEquity, pathBenchmark, viewBox } = useMemo(() => {
    if (series.length < 2)
      return { pathEquity: '', pathBenchmark: '', viewBox: '0 0 400 120' };
    const vals = [...series.map((p) => p.equity), ...series.map((p) => p.benchmark)];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.05, 1);
    const min = lo - pad;
    const max = hi + pad;
    const w = 400;
    const h = 120;
    const tMin = series[0].t;
    const tMax = series[series.length - 1].t;
    const sx = (t: number) => ((t - tMin) / Math.max(tMax - tMin, 1)) * w;
    const sy = (v: number) => h - ((v - min) / Math.max(max - min, 0.01)) * h;
    const eq = series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.t).toFixed(1)},${sy(p.equity).toFixed(1)}`)
      .join(' ');
    const bn = series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.t).toFixed(1)},${sy(p.benchmark).toFixed(1)}`)
      .join(' ');
    return { pathEquity: eq, pathBenchmark: bn, viewBox: `0 0 ${w} ${h}` };
  }, [series]);

  return (
    <section className="card flex flex-col gap-3">
      <h2 className="text-sm font-semibold">
        Results — {STRATEGY_LABELS[run.strategyKey] ?? run.strategyKey}
      </h2>

      <svg viewBox={viewBox} className="h-32 w-full" preserveAspectRatio="none">
        {pathBenchmark && (
          <path
            d={pathBenchmark}
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.4"
            strokeWidth="1"
          />
        )}
        {pathEquity && (
          <path d={pathEquity} fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-400" />
        )}
      </svg>
      <p className="text-[10px] text-ink-500">
        Green = strategy · grey dashed = {run.benchmarkSymbol} benchmark (same starting cash).
      </p>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <Stat
          label="Total return"
          value={fmtPct(run.totalReturnPct)}
          positive={(run.totalReturnPct ?? 0) >= 0}
        />
        <Stat
          label="vs benchmark"
          value={fmtPct(
            run.totalReturnPct != null && run.benchmarkReturnPct != null
              ? run.totalReturnPct - run.benchmarkReturnPct
              : null
          )}
          positive={
            run.totalReturnPct != null && run.benchmarkReturnPct != null
              ? run.totalReturnPct - run.benchmarkReturnPct >= 0
              : true
          }
        />
        <Stat label="CAGR" value={fmtPct(run.cagrPct)} />
        <Stat label="Sharpe" value={run.sharpeAnnual?.toFixed(2) ?? '—'} />
        <Stat label="Max DD" value={fmtPct(run.maxDrawdownPct)} positive={false} />
        <Stat label="Worst month" value={fmtPct(run.worstMonthPct)} positive={false} />
        <Stat label="Final equity" value={formatUsd(BigInt(run.endingEquityCents ?? '0'))} />
        <Stat label="Trades" value={String(run.tradeCount ?? '—')} />
        <Stat label="Universe" value={`${run.universe.length} syms`} />
      </div>

      <FilterSummary eventLog={run.eventLog} />
    </section>
  );
}

// Condensed point-in-time filter audit. Shows how many names survived
// day-zero screening, which ones were cut (with the first reason), and
// any rebalance-time ejections when fundamentals deteriorated.
function FilterSummary({
  eventLog,
}: {
  eventLog: Run['eventLog'];
}) {
  if (!eventLog || eventLog.length === 0) return null;
  const passes = eventLog.filter((e) => e.event === 'filter_pass');
  const rejects = eventLog.filter((e) => e.event === 'filter_reject');
  const ejections = eventLog.filter((e) => e.event === 'filter_rebalance_sell');
  if (passes.length === 0 && rejects.length === 0 && ejections.length === 0) {
    return null;
  }

  // Collapse per-symbol reject reasons so the UI isn't noisy when the
  // same name fails at every quarterly re-check.
  const rejectsFirstReason = new Map<string, string>();
  for (const e of rejects) {
    const sym = String(e.details.symbol ?? '');
    if (!rejectsFirstReason.has(sym)) {
      rejectsFirstReason.set(sym, String(e.details.reason ?? 'n/a'));
    }
  }
  const ejectionsFirstReason = new Map<string, string>();
  for (const e of ejections) {
    const sym = String(e.details.symbol ?? '');
    if (!ejectionsFirstReason.has(sym)) {
      ejectionsFirstReason.set(sym, String(e.details.reason ?? 'n/a'));
    }
  }

  return (
    <div className="rounded-md border border-ink-700/60 bg-ink-800/30 p-3 text-[11px]">
      <p className="font-semibold text-ink-100">
        Point-in-time filter audit
      </p>
      <div className="mt-1 flex flex-wrap gap-3 text-ink-300">
        <span className="text-brand-300">
          {passes.length} pass{passes.length === 1 ? '' : 'es'}
        </span>
        <span className="text-amber-300">
          {rejectsFirstReason.size} day-0 reject
          {rejectsFirstReason.size === 1 ? '' : 's'}
        </span>
        <span className="text-red-300">
          {ejectionsFirstReason.size} rebalance ejection
          {ejectionsFirstReason.size === 1 ? '' : 's'}
        </span>
      </div>
      {rejectsFirstReason.size > 0 && (
        <div className="mt-2">
          <p className="text-ink-400">Rejected at day zero:</p>
          <ul className="mt-0.5 space-y-0.5">
            {Array.from(rejectsFirstReason.entries()).map(([sym, reason]) => (
              <li key={sym} className="text-ink-300">
                <span className="font-mono font-semibold text-ink-100">{sym}</span>
                <span className="ml-2 text-ink-400">— {reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ejectionsFirstReason.size > 0 && (
        <div className="mt-2">
          <p className="text-ink-400">Ejected mid-run:</p>
          <ul className="mt-0.5 space-y-0.5">
            {Array.from(ejectionsFirstReason.entries()).map(([sym, reason]) => (
              <li key={sym} className="text-ink-300">
                <span className="font-mono font-semibold text-ink-100">{sym}</span>
                <span className="ml-2 text-ink-400">— {reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  const color =
    positive === undefined
      ? 'text-ink-100'
      : positive
        ? 'text-brand-400'
        : 'text-red-300';
  return (
    <div>
      <p className="stat-label">{label}</p>
      <p className={`text-base font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

// Zod's error.flatten() returns { fieldErrors, formErrors } — my earlier
// handler only read string errors and silently dropped the detail, so
// users saw "backtest failed" with no indication WHY. Pull the most
// specific useful message whatever shape came back.
function extractError(body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const maybe = err as {
        fieldErrors?: Record<string, string[] | undefined>;
        formErrors?: string[];
      };
      if (maybe.fieldErrors) {
        for (const [field, msgs] of Object.entries(maybe.fieldErrors)) {
          const first = msgs?.[0];
          if (first) return `${field}: ${first}`;
        }
      }
      if (maybe.formErrors?.[0]) return maybe.formErrors[0];
    }
  }
  return 'backtest failed — check the server log';
}
