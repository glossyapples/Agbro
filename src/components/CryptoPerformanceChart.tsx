'use client';

// Crypto-book performance chart. Pure SVG, parallel to the stocks-side
// PerformanceChart. Shows crypto book value + BTC benchmark as % returns
// from range start — same y-axis so they're directly comparable.
//
// Data fills in over time as the daily cron snapshot builds a series. A
// brand-new user sees an empty state until at least two snapshots exist.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatUsd } from '@/lib/money';

type Range = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | 'ALL';
const RANGES: Range[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'];

type Summary = {
  currentBookValue: number;
  rangePnl: number;
  rangePnlPct: number;
} | null;

type Payload = {
  range: Range;
  summary: Summary;
  book: Array<{ t: number; v: number; pct: number }>;
  btc: Array<{ t: number; pct: number }>;
};

export function CryptoPerformanceChart({ initial }: { initial: Payload }) {
  const [range, setRange] = useState<Range>(initial.range);
  const [data, setData] = useState<Payload>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRange = useCallback(async (r: Range) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/crypto/performance?range=${r}`);
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

  // Re-fetch when the selected range diverges from the currently-displayed
  // data's range. Comparing against `data.range` (local state) not
  // `initial.range` (a prop that never changes after mount) means clicking
  // back to the initial range after exploring others also triggers a fetch.
  useEffect(() => {
    if (range !== data.range) fetchRange(range);
  }, [range, data.range, fetchRange]);

  const { path, btcPath, viewBox, minPct, maxPct } = useMemo(() => {
    const b = data.book;
    const btc = data.btc;
    if (b.length < 2) {
      return { path: '', btcPath: '', viewBox: '0 0 400 120', minPct: 0, maxPct: 0 };
    }
    const allPcts = [...b.map((p) => p.pct), ...btc.map((p) => p.pct)];
    const lo = Math.min(...allPcts);
    const hi = Math.max(...allPcts);
    const pad = Math.max((hi - lo) * 0.1, 0.5);
    const minY = lo - pad;
    const maxY = hi + pad;
    const w = 400;
    const h = 120;
    const tMin = b[0].t;
    const tMax = b[b.length - 1].t;
    const scaleX = (t: number) => ((t - tMin) / Math.max(tMax - tMin, 1)) * w;
    const scaleY = (pct: number) =>
      h - ((pct - minY) / Math.max(maxY - minY, 0.01)) * h;
    const bookD = b
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(p.t).toFixed(1)},${scaleY(p.pct).toFixed(1)}`)
      .join(' ');
    const btcD = btc
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(p.t).toFixed(1)},${scaleY(p.pct).toFixed(1)}`)
      .join(' ');
    return { path: bookD, btcPath: btcD, viewBox: `0 0 ${w} ${h}`, minPct: minY, maxPct: maxY };
  }, [data]);

  const summary = data.summary;
  const pnlColor = summary && summary.rangePnl >= 0 ? 'text-brand-400' : 'text-red-300';
  const btcEnd = data.btc[data.btc.length - 1]?.pct ?? null;
  const vsBtcPct = summary && btcEnd != null ? summary.rangePnlPct - btcEnd : null;

  return (
    <section className="card">
      <div className="flex items-start justify-between">
        <div>
          <p className="stat-label">Crypto book</p>
          {summary ? (
            <>
              <p className="text-2xl font-semibold text-ink-50">
                {formatUsd(BigInt(Math.round(summary.currentBookValue * 100)))}
              </p>
              <p className={`mt-0.5 text-sm font-medium ${pnlColor}`}>
                {summary.rangePnl >= 0 ? '+' : ''}
                {summary.rangePnl.toFixed(2)} ({summary.rangePnlPct >= 0 ? '+' : ''}
                {summary.rangePnlPct.toFixed(2)}%)
                <span className="ml-1 text-[11px] font-normal text-ink-400">
                  {range === '1D'
                    ? 'today'
                    : range === '1W'
                      ? 'this week'
                      : range === '1M'
                        ? 'this month'
                        : range === '3M'
                          ? 'past 3 months'
                          : range === 'YTD'
                            ? 'YTD'
                            : range === '1Y'
                              ? 'past year'
                              : 'all time'}
                </span>
              </p>
              {vsBtcPct != null && (
                <p className="mt-0.5 text-xs text-ink-400">
                  vs BTC {vsBtcPct >= 0 ? '+' : ''}
                  {vsBtcPct.toFixed(2)}%
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-ink-400">
              Collecting data — chart fills in after ~48h of snapshots.
            </p>
          )}
        </div>
        <Link
          href="/crypto/positions"
          prefetch={false}
          className="text-xs text-brand-400"
          aria-label="View all crypto holdings"
        >
          Holdings →
        </Link>
      </div>

      {data.book.length >= 2 ? (
        <svg viewBox={viewBox} className="mt-3 h-32 w-full" preserveAspectRatio="none">
          {/* Zero baseline */}
          {minPct < 0 && maxPct > 0 && (
            <line
              x1={0}
              x2={400}
              y1={120 - ((0 - minPct) / (maxPct - minPct)) * 120}
              y2={120 - ((0 - minPct) / (maxPct - minPct)) * 120}
              stroke="currentColor"
              strokeOpacity="0.15"
              strokeDasharray="2 4"
            />
          )}
          {btcPath && (
            <path d={btcPath} fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1" />
          )}
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-400" />
        </svg>
      ) : (
        <div className="mt-3 flex h-32 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-ink-700/60 px-4 text-center text-xs text-ink-400">
          <p>Chart fills in after the first daily snapshot.</p>
          <p>
            The crypto engine takes one snapshot per tick once DCA is active —
            give it a day or two and a line will appear.
          </p>
        </div>
      )}

      <div className="mt-3 flex gap-1 overflow-x-auto text-[11px]">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            disabled={busy}
            className={`rounded-md px-2 py-1 font-medium ${
              r === range ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'
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
