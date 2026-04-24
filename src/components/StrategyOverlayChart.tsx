'use client';

// Strategy-overlay chart — all strategies + SPY benchmark in a single
// window, each a differently-coloured line, rebased to 0% at start so
// trajectories compare directly. Reading is about SHAPE and RELATIVE
// performance, not dollar totals.

import { useEffect, useMemo, useState } from 'react';
import {
  STRATEGY_KEYS,
  STRATEGY_LABELS,
  type StrategyKey,
} from '@/lib/backtest/rules';
import type { BacktestWindow } from '@/lib/backtest/windows';

type SeriesPoint = { t: number; pct: number };

type Payload = {
  windowKey: string;
  strategies: Array<{
    strategyKey: string;
    runId: string;
    points: SeriesPoint[];
    noData?: boolean;
  }>;
  benchmark: SeriesPoint[];
};

// Fixed palette. Each strategy keeps its colour across windows so the
// eye learns them — Quality Compounders is always sky, Graham is
// always amber, etc.
const STRATEGY_COLORS: Record<StrategyKey, string> = {
  buffett_core: '#44e39c',
  deep_value_graham: '#fbbf24',
  quality_compounders: '#38bdf8',
  dividend_growth: '#a78bfa',
  boglehead_index: '#f472b6',
  burry_deep_research: '#f97316', // highlighter-orange, his signature colour
};

export function StrategyOverlayChart({ windows }: { windows: BacktestWindow[] }) {
  const visible = useMemo(() => windows.filter((w) => !w.heldOut), [windows]);
  // Default to the first visible window whose start date is inside
  // Alpaca's free-tier data coverage (~2016+). Picking the very first
  // visible window defaulted us to GFC 2008-09, which always shows
  // the 'no usable data' banner — confusing first impression.
  const defaultWindow = useMemo(() => {
    const ALPACA_DATA_EPOCH = '2016-01-01';
    const withData = visible.find((w) => w.startDate >= ALPACA_DATA_EPOCH);
    return withData?.key ?? visible[0]?.key ?? windows[0]?.key ?? '';
  }, [visible, windows]);
  const [windowKey, setWindowKey] = useState<string>(defaultWindow);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Bumping this triggers the fetch effect to rerun — used so the
  // chart refreshes when a "Run visible grid" completes without the
  // user reloading the page.
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!windowKey) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/backtest/grid/series?windowKey=${encodeURIComponent(windowKey)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setPayload(data as Payload);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [windowKey, refreshTick]);

  // Listen for grid-run completions dispatched by BacktestGrid. When
  // a new batch lands, refetch the series for the currently selected
  // window so the overlay updates without a page reload.
  useEffect(() => {
    function onGridUpdated() {
      setRefreshTick((n) => n + 1);
    }
    window.addEventListener('agbro:grid-runs-updated', onGridUpdated);
    return () => window.removeEventListener('agbro:grid-runs-updated', onGridUpdated);
  }, []);

  const chart = useMemo(() => renderChart(payload, hidden), [payload, hidden]);
  const windowMeta = windows.find((w) => w.key === windowKey);

  function toggle(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <section className="card flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">Overlay chart</h2>
        <p className="mt-0.5 text-[11px] text-ink-400">
          All strategies + SPY in the same window, rebased to 0% at start.
          Shows how each strategy TRAVELLED through the window, not just
          where it ended up. Click a legend pill to hide / show.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex flex-col">
          <span className="text-[10px] uppercase tracking-[0.1em] text-ink-400">Window</span>
          <select
            value={windowKey}
            onChange={(e) => setWindowKey(e.target.value)}
            className="mt-0.5 max-w-[260px]"
          >
            {windows.map((w) => (
              <option key={w.key} value={w.key}>
                {w.heldOut ? '◆ ' : ''}
                {w.label} ({w.startDate.slice(0, 7)} → {w.endDate.slice(0, 7)})
              </option>
            ))}
          </select>
        </label>
        {windowMeta && <p className="text-[11px] text-ink-400">{windowMeta.description}</p>}
      </div>

      <div className="flex flex-wrap gap-1 text-[11px]">
        {STRATEGY_KEYS.map((k) => {
          const isHidden = hidden.has(k);
          return (
            <button
              key={k}
              onClick={() => toggle(k)}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
                isHidden ? 'border-ink-700/60 text-ink-500' : 'border-ink-600 text-ink-200'
              }`}
              title={isHidden ? 'Show' : 'Hide'}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{
                  backgroundColor: STRATEGY_COLORS[k],
                  opacity: isHidden ? 0.3 : 1,
                }}
              />
              {STRATEGY_LABELS[k]}
            </button>
          );
        })}
        <button
          onClick={() => toggle('__benchmark')}
          className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
            hidden.has('__benchmark')
              ? 'border-ink-700/60 text-ink-500'
              : 'border-ink-600 text-ink-200'
          }`}
        >
          <span
            className="inline-block h-2 w-2 rounded-full border border-dashed border-ink-400"
            style={{ opacity: hidden.has('__benchmark') ? 0.3 : 1 }}
          />
          SPY benchmark
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-ink-400">Loading series…</p>
      ) : error ? (
        <p className="text-xs text-red-400">Failed to load: {error}</p>
      ) : payload == null || payload.strategies.length === 0 ? (
        <p className="text-xs text-ink-400">
          No completed runs for this window yet. Click &quot;Run visible grid&quot;
          above to populate.
        </p>
      ) : payload.strategies.every((s) => s.noData) ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-[11px] text-amber-100">
          <p className="font-semibold">⚠ No usable data for this window</p>
          <p className="mt-1 text-amber-100/80">
            Every strategy&apos;s run completed but returned zero equity
            points — Alpaca&apos;s free IEX feed doesn&apos;t cover the
            universe back this far. Its history starts around 2015–2016.
            Pick a more recent window (COVID 2020, Rate Cycle 2022, etc.)
            to see trajectories.
          </p>
        </div>
      ) : (
        <svg viewBox={chart.viewBox} className="h-48 w-full" preserveAspectRatio="none">
          {chart.hasZero && (
            <line
              x1={0}
              x2={400}
              y1={chart.zeroY}
              y2={chart.zeroY}
              stroke="currentColor"
              strokeOpacity="0.15"
              strokeDasharray="2 4"
            />
          )}
          {!hidden.has('__benchmark') && chart.benchmarkPath && (
            <path
              d={chart.benchmarkPath}
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.5"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
          )}
          {chart.strategyPaths.map((s) =>
            hidden.has(s.strategyKey) ? null : (
              <path
                key={s.strategyKey}
                d={s.path}
                fill="none"
                stroke={STRATEGY_COLORS[s.strategyKey as StrategyKey]}
                strokeWidth="1.5"
              />
            )
          )}
        </svg>
      )}

      {payload && payload.strategies.length > 0 && (
        <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
          {STRATEGY_KEYS.filter((k) => !hidden.has(k)).map((k) => {
            const s = payload.strategies.find((x) => x.strategyKey === k);
            if (!s) return null;
            const last = s.points[s.points.length - 1];
            if (!last) return null;
            return (
              <div key={k} className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-ink-300">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: STRATEGY_COLORS[k] }}
                  />
                  {STRATEGY_LABELS[k]}
                </span>
                <span
                  className={`font-semibold tabular-nums ${
                    last.pct >= 0 ? 'text-brand-400' : 'text-red-300'
                  }`}
                >
                  {last.pct >= 0 ? '+' : ''}
                  {last.pct.toFixed(1)}%
                </span>
              </div>
            );
          })}
          {!hidden.has('__benchmark') && payload.benchmark.length > 0 && (
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-ink-300">
                <span className="inline-block h-2 w-2 rounded-full border border-dashed border-ink-400" />
                SPY
              </span>
              <span
                className={`font-semibold tabular-nums ${
                  payload.benchmark[payload.benchmark.length - 1].pct >= 0
                    ? 'text-brand-400'
                    : 'text-red-300'
                }`}
              >
                {payload.benchmark[payload.benchmark.length - 1].pct >= 0 ? '+' : ''}
                {payload.benchmark[payload.benchmark.length - 1].pct.toFixed(1)}%
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function renderChart(
  payload: Payload | null,
  hidden: Set<string>
): {
  viewBox: string;
  strategyPaths: Array<{ strategyKey: string; path: string }>;
  benchmarkPath: string;
  zeroY: number;
  hasZero: boolean;
} {
  const w = 400;
  const h = 192;
  const empty = {
    viewBox: `0 0 ${w} ${h}`,
    strategyPaths: [] as Array<{ strategyKey: string; path: string }>,
    benchmarkPath: '',
    zeroY: h / 2,
    hasZero: false,
  };
  if (!payload) return empty;

  const seriesForScale: SeriesPoint[][] = [];
  for (const s of payload.strategies) {
    if (!hidden.has(s.strategyKey)) seriesForScale.push(s.points);
  }
  if (!hidden.has('__benchmark') && payload.benchmark.length > 0) {
    seriesForScale.push(payload.benchmark);
  }
  if (seriesForScale.length === 0) return empty;

  let minPct = Infinity;
  let maxPct = -Infinity;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const s of seriesForScale) {
    for (const p of s) {
      if (p.pct < minPct) minPct = p.pct;
      if (p.pct > maxPct) maxPct = p.pct;
      if (p.t < tMin) tMin = p.t;
      if (p.t > tMax) tMax = p.t;
    }
  }
  if (!Number.isFinite(minPct) || !Number.isFinite(maxPct)) return empty;
  const pad = Math.max((maxPct - minPct) * 0.1, 0.5);
  minPct -= pad;
  maxPct += pad;
  const yScale = (pct: number) => h - ((pct - minPct) / Math.max(maxPct - minPct, 0.01)) * h;
  const xScale = (t: number) => ((t - tMin) / Math.max(tMax - tMin, 1)) * w;

  const toPath = (pts: SeriesPoint[]) =>
    pts
      .map(
        (p, i) =>
          `${i === 0 ? 'M' : 'L'}${xScale(p.t).toFixed(1)},${yScale(p.pct).toFixed(1)}`
      )
      .join(' ');

  return {
    viewBox: `0 0 ${w} ${h}`,
    strategyPaths: payload.strategies.map((s) => ({
      strategyKey: s.strategyKey,
      path: toPath(s.points),
    })),
    benchmarkPath: toPath(payload.benchmark),
    zeroY: yScale(0),
    hasZero: minPct < 0 && maxPct > 0,
  };
}
