'use client';

// Robinhood-style hero chart. Pure SVG, no chart libraries — keeps the bundle
// small and gives us precise control over the look.
//
// What it shows:
//   - Big current portfolio value
//   - Range P&L as $ and %, coloured green/red
//   - vs-SPY line ("vs SPY +1.2%") so every glance tells you whether the
//     agent is earning its cost of capital
//   - A single-line area chart of portfolio % return from range start
//   - A thin gray line overlaying SPY % return, same y-axis for honesty
//   - Time-range chips underneath: 1D · 1W · 1M · 3M · YTD · 1Y · ALL

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatUsd } from '@/lib/money';

type Range = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | 'ALL';
const RANGES: Range[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'];

type Summary = {
  currentEquity: number;
  rangePnl: number;
  rangePnlPct: number;
  spyPnlPct: number | null;
} | null;

type Payload = {
  range: Range;
  summary: Summary;
  portfolio: Array<{ t: number; v: number; pct: number }>;
  spy: Array<{ t: number; pct: number }>;
};

export function PerformanceChart({ initial }: { initial: Payload }) {
  const [range, setRange] = useState<Range>(initial.range);
  const [data, setData] = useState<Payload>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRange = useCallback(async (r: Range) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/performance?range=${r}`);
      if (!res.ok) {
        setError('Could not load chart');
        return;
      }
      setData((await res.json()) as Payload);
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (range !== data.range) void fetchRange(range);
  }, [range, data.range, fetchRange]);

  const up = (data.summary?.rangePnl ?? 0) >= 0;
  const colorClass = up ? 'text-brand-400' : 'text-red-400';
  const lineColor = up ? 'var(--chart-up, #44e39c)' : 'var(--chart-down, #f87171)';
  // Range-specific suffix so "▼ $22 (-0.02%)" isn't read as total
  // return. This P/L is a window delta, not an all-time number —
  // the Holdings page shows unrealized-since-cost for that view.
  const rangeLabel: Record<Range, string> = {
    '1D': 'today',
    '1W': 'this week',
    '1M': 'this month',
    '3M': 'past 3 months',
    'YTD': 'YTD',
    '1Y': 'past year',
    'ALL': 'all time',
  };

  return (
    <section className="card">
      <div className="flex items-start justify-between">
        <p className="stat-label">Portfolio · stocks</p>
        <Link
          href="/positions"
          prefetch={false}
          className="text-xs text-brand-400"
          aria-label="View all stock holdings"
        >
          Holdings →
        </Link>
      </div>
      <p className="stat-value">
        {data.summary ? formatUsd(BigInt(Math.round(data.summary.currentEquity * 100))) : '—'}
      </p>
      <p className={`mt-0.5 text-sm font-medium ${colorClass}`}>
        {data.summary ? (
          <>
            {up ? '▲' : '▼'} {formatUsd(BigInt(Math.round(Math.abs(data.summary.rangePnl) * 100)))}{' '}
            ({up ? '+' : ''}{data.summary.rangePnlPct.toFixed(2)}%)
            <span className="ml-1 text-[11px] font-normal text-ink-400">
              {rangeLabel[range]}
            </span>
            {data.summary.spyPnlPct != null && (
              <span className="ml-2 text-[11px] font-normal text-ink-400">
                vs SPY {data.summary.spyPnlPct >= 0 ? '+' : ''}
                {data.summary.spyPnlPct.toFixed(2)}%
              </span>
            )}
          </>
        ) : (
          <span className="text-ink-400">Waiting for data — run the agent or deposit first.</span>
        )}
      </p>

      <ChartSvg portfolio={data.portfolio} spy={data.spy} lineColor={lineColor} />

      <div className="mt-3 flex flex-wrap gap-1">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            disabled={busy}
            className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
              r === range
                ? 'bg-ink-700 text-ink-50'
                : 'bg-transparent text-ink-400 hover:bg-ink-700/60'
            } disabled:opacity-50`}
          >
            {r}
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
    </section>
  );
}

// -----------------------------------------------------------------------
// SVG renderer. Takes portfolio + SPY series (in % return from range start)
// and draws them on the same y-axis. 100% client-side, zero dependencies.
// -----------------------------------------------------------------------

function ChartSvg({
  portfolio,
  spy,
  lineColor,
}: {
  portfolio: Array<{ t: number; pct: number }>;
  spy: Array<{ t: number; pct: number }>;
  lineColor: string;
}) {
  const W = 600;
  const H = 140;
  const PAD_Y = 6;

  const { portfolioPath, portfolioArea, spyPath, baseline } = useMemo(() => {
    if (portfolio.length < 2) {
      return { portfolioPath: '', portfolioArea: '', spyPath: '', baseline: H / 2 };
    }
    // Combined y-range so both series are visible — minimum ±0.1% so a flat
    // day doesn't collapse to a horizontal line right at the axis.
    const allPcts = [...portfolio.map((p) => p.pct), ...spy.map((p) => p.pct)];
    const min = Math.min(...allPcts, -0.1);
    const max = Math.max(...allPcts, 0.1);
    const yScale = (pct: number) => {
      const normalised = (pct - min) / (max - min);
      return H - PAD_Y - normalised * (H - 2 * PAD_Y);
    };
    // Share the x-domain across both series so they align visually.
    const tMin = portfolio[0].t;
    const tMax = portfolio[portfolio.length - 1].t;
    const xScale = (t: number) => {
      const normalised = (t - tMin) / Math.max(tMax - tMin, 1);
      return normalised * W;
    };

    const buildPath = (series: Array<{ t: number; pct: number }>) =>
      series
        .filter((p) => p.t >= tMin && p.t <= tMax)
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.t).toFixed(2)},${yScale(p.pct).toFixed(2)}`)
        .join(' ');

    const pPath = buildPath(portfolio);
    // Close the area under the portfolio line for a subtle fill.
    const area = pPath
      ? `${pPath} L${xScale(tMax).toFixed(2)},${H} L${xScale(tMin).toFixed(2)},${H} Z`
      : '';
    const sPath = spy.length > 1 ? buildPath(spy) : '';

    return {
      portfolioPath: pPath,
      portfolioArea: area,
      spyPath: sPath,
      baseline: yScale(0),
    };
  }, [portfolio, spy]);

  if (portfolio.length < 2) {
    return (
      <div className="mt-3 flex h-[140px] items-center justify-center rounded-lg bg-ink-800/40 text-xs text-ink-500">
        No history for this range yet.
      </div>
    );
  }

  return (
    <svg
      className="mt-3 block w-full"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-label="Portfolio performance chart"
    >
      <defs>
        <linearGradient id="portfolioFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity="0.35" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* zero-return baseline so user can see where they'd be if flat */}
      <line
        x1="0"
        x2={W}
        y1={baseline}
        y2={baseline}
        stroke="rgba(255,255,255,0.08)"
        strokeDasharray="4 4"
        strokeWidth="1"
      />
      {portfolioArea && <path d={portfolioArea} fill="url(#portfolioFill)" />}
      {spyPath && (
        <path
          d={spyPath}
          fill="none"
          stroke="rgba(191,198,212,0.45)"
          strokeWidth="1.25"
          strokeDasharray="3 3"
        />
      )}
      {portfolioPath && (
        <path d={portfolioPath} fill="none" stroke={lineColor} strokeWidth="1.75" />
      )}
    </svg>
  );
}
