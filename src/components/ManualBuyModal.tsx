'use client';

// Modal for placing a manual market-buy on a single symbol. Posts to
// /api/trades/manual-buy. The agent loop sees the new position on its
// next sync and reacts — that's the loop the user wants to feel:
// place a trade, watch the team respond.

import { useState } from 'react';

type State =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'done'; tradeId: string }
  | { status: 'error'; message: string };

export function ManualBuyModal({
  symbol,
  onClose,
}: {
  symbol: string;
  onClose: () => void;
}) {
  const [qty, setQty] = useState('1');
  const [state, setState] = useState<State>({ status: 'idle' });

  async function submit() {
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) {
      setState({ status: 'error', message: 'Enter a positive share count.' });
      return;
    }
    setState({ status: 'submitting' });
    try {
      const res = await fetch('/api/trades/manual-buy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, qty: n }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body.error === 'string'
            ? body.error
            : body.error?.formErrors?.[0] ?? `HTTP ${res.status}`;
        setState({ status: 'error', message: msg });
        return;
      }
      setState({ status: 'done', tradeId: body.tradeId });
    } catch (err) {
      setState({ status: 'error', message: (err as Error).message });
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Buy ${symbol}`}
    >
      <div
        className="w-full max-w-md rounded-t-xl border border-ink-700 bg-ink-950 p-5 sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-ink-400">Manual buy</p>
            <h2 className="text-2xl font-semibold text-ink-100">{symbol}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-ink-700 px-3 py-1 text-xs text-ink-300 hover:bg-ink-800"
            aria-label="Close"
          >
            Close
          </button>
        </header>

        {state.status !== 'done' && (
          <>
            <label className="block text-sm">
              <span className="text-ink-300">Shares</span>
              <input
                type="number"
                min="0"
                step="any"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                disabled={state.status === 'submitting'}
                className="mt-1 w-full rounded-sm border border-ink-700 bg-ink-900 p-2 text-ink-100"
              />
            </label>
            <p className="mt-2 text-[11px] text-ink-400">
              Market order, paper account. Bypasses the agent — fires straight
              to Alpaca. Your team will see the new position on the next sync
              and react.
            </p>

            {state.status === 'error' && (
              <p className="mt-3 rounded-sm bg-rose-950 p-2 text-xs text-rose-300">
                {state.message}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={state.status === 'submitting'}
                className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:bg-ink-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={state.status === 'submitting'}
                className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-emerald-50 hover:bg-emerald-600 disabled:opacity-50"
              >
                {state.status === 'submitting' ? 'Placing…' : `Buy ${qty || '?'} ${symbol}`}
              </button>
            </div>
          </>
        )}

        {state.status === 'done' && (
          <div className="space-y-3 text-sm text-ink-200">
            <div className="rounded-md border border-emerald-900 bg-emerald-950/20 p-3">
              <p className="font-semibold text-emerald-200">Order submitted</p>
              <p className="mt-1 text-xs text-emerald-300/80">
                Trade {state.tradeId.slice(0, 8)}… is on its way to Alpaca.
                Check the Trades page for fill confirmation. The agent will
                pick it up on its next wake.
              </p>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:bg-ink-800"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
