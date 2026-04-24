'use client';

// Robinhood-style holdings list. One row per symbol: ticker +
// shares + inline sparkline + tappable value pill. The pill cycles
// through six display modes with a single tap (no bottom sheet for
// v1 — cheaper on the first ship, easy to upgrade). Cycle state is
// shared across all rows so the list reads consistently.

import { useState } from 'react';
import { formatUsd } from '@/lib/money';
import { Sparkline } from './Sparkline';

// Serializable shape the server page passes down. BigInt → string so
// props survive Next.js server→client boundary. All numerics already
// stringified cents or decimals; component re-inflates on render.
export type HoldingView = {
  symbol: string;
  qty: number;
  currentPrice: number;
  avgEntryPrice: number;
  marketValueCents: string;
  costBasisCents: string;
  unrealizedPlCents: string;
  unrealizedPlPct: number;
  changeTodayCents: string;
  changeTodayPct: number;
  sparkline: number[];
};

// Display modes, in the order the pill cycles through on tap.
// Matches the Robinhood "Display data" bottom sheet the user
// referenced: last price, percent change (today), your equity,
// today's return, total return, total percent change.
const MODES = [
  'last_price',
  'change_today_pct',
  'equity',
  'today_return',
  'total_return',
  'total_pct',
] as const;
type Mode = (typeof MODES)[number];

const MODE_LABEL: Record<Mode, string> = {
  last_price: 'Last price',
  change_today_pct: 'Today %',
  equity: 'Your equity',
  today_return: "Today's return",
  total_return: 'Unrealized P/L ($)',
  total_pct: 'Unrealized P/L (%)',
};

function centsToUsd(str: string): string {
  return formatUsd(BigInt(str));
}

function pctSign(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function usdSign(str: string): string {
  const n = BigInt(str);
  const dollars = Number(n) / 100;
  const formatted = `$${Math.abs(dollars).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  return n >= 0n ? `+${formatted}` : `-${formatted}`;
}

function renderMode(h: HoldingView, mode: Mode): { label: string; up: boolean } {
  switch (mode) {
    case 'last_price':
      return { label: `$${h.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, up: true };
    case 'change_today_pct':
      return { label: pctSign(h.changeTodayPct), up: h.changeTodayPct >= 0 };
    case 'equity':
      return { label: centsToUsd(h.marketValueCents), up: true };
    case 'today_return':
      return { label: usdSign(h.changeTodayCents), up: BigInt(h.changeTodayCents) >= 0n };
    case 'total_return':
      return { label: usdSign(h.unrealizedPlCents), up: BigInt(h.unrealizedPlCents) >= 0n };
    case 'total_pct':
      return { label: pctSign(h.unrealizedPlPct), up: h.unrealizedPlPct >= 0 };
  }
}

export function HoldingsList({
  holdings,
  emptyMessage = 'No positions yet.',
}: {
  holdings: HoldingView[];
  emptyMessage?: string;
}) {
  const [mode, setMode] = useState<Mode>('total_pct');

  function cycle() {
    const i = MODES.indexOf(mode);
    setMode(MODES[(i + 1) % MODES.length]);
  }

  if (holdings.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-ink-700/60 p-8 text-center text-sm text-ink-400">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div>
      <p className="mb-2 text-[11px] uppercase tracking-wide text-ink-400">
        Tap a pill to cycle · showing{' '}
        <span className="text-ink-200">{MODE_LABEL[mode]}</span>
      </p>
      <ul className="divide-y divide-ink-800">
        {holdings.map((h) => {
          const r = renderMode(h, mode);
          const neutral = mode === 'last_price' || mode === 'equity';
          return (
            <li key={h.symbol} className="flex items-center gap-3 py-3">
              <div className="min-w-[72px] flex-shrink-0">
                <p className="text-sm font-semibold">{h.symbol}</p>
                <p className="text-[11px] text-ink-400">
                  {h.qty.toLocaleString('en-US', { maximumFractionDigits: 4 })} shares
                </p>
              </div>
              <div className="flex-1 overflow-hidden">
                <Sparkline values={h.sparkline} />
              </div>
              <button
                type="button"
                onClick={cycle}
                className={`min-w-[88px] rounded-md px-3 py-1.5 text-right text-sm font-semibold tabular-nums transition ${
                  neutral
                    ? 'bg-ink-800 text-ink-100'
                    : r.up
                      ? 'bg-emerald-900/40 text-emerald-300'
                      : 'bg-rose-900/40 text-rose-300'
                }`}
                aria-label={`Cycle display mode — currently ${MODE_LABEL[mode]}`}
              >
                {r.label}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
