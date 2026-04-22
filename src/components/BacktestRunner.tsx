'use client';

// Backtest launcher + results viewer. Pure client component — all the
// historical data fetching happens server-side via /api/backtest/run.
// UI shows the previous runs plus a form to launch a new one, and
// renders the equity curve + metrics table for whichever run is
// selected.

import { useMemo, useState } from 'react';
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
  runAt: string;
  errorMessage: string | null;
};

export function BacktestRunner({ initialRuns }: { initialRuns: Run[] }) {
  const router = useRouter();
  const [runs, setRuns] = useState(initialRuns);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialRuns.find((r) => r.status === 'completed')?.id ?? null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [strategyKey, setStrategyKey] = useState<StrategyKey>('buffett_core');
  const [startDate, setStartDate] = useState('2020-01-01');
  const [endDate, setEndDate] = useState('2021-01-01');
  const [cash, setCash] = useState('100000');
  const [universe, setUniverse] = useState<string>(
    DEFAULT_UNIVERSES.buffett_core.join(',')
  );

  const selected = selectedId ? runs.find((r) => r.id === selectedId) ?? null : null;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategyKey,
          universe: universe
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
          startDate,
          endDate,
          startingCashUsd: Number(cash) || 100000,
          label: `${STRATEGY_LABELS[strategyKey]} ${startDate}→${endDate}`,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'backtest failed');
        return;
      }
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
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
            Tier 1 backtest: deterministic rules only (no LLM reasoning). See /backtest
            for full scope notes.
          </p>
          <button onClick={run} disabled={busy} className="btn-primary disabled:opacity-50">
            {busy ? 'Running…' : 'Run backtest'}
          </button>
        </div>

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
    </section>
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
