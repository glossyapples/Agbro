'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

type WatchlistStock = {
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  buffettScore: number | null;
  moatScore: number | null;
  peRatio: number | null;
  dividendYield: number | null;
  notes: string | null;
  lastAnalyzedAt: string | null;
};

export function WatchlistManager({ initial }: { initial: WatchlistStock[] }) {
  const router = useRouter();
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  async function add() {
    const clean = symbol.trim().toUpperCase();
    if (!clean) {
      setError('Enter a ticker symbol.');
      return;
    }
    setError(null);
    startBusy(async () => {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: clean, name: name.trim() || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Could not add — check the symbol.');
        return;
      }
      setSymbol('');
      setName('');
      router.refresh();
    });
  }

  async function remove(sym: string) {
    setError(null);
    startBusy(async () => {
      const res = await fetch(`/api/watchlist?symbol=${encodeURIComponent(sym)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(`Failed to remove ${sym}`);
        return;
      }
      router.refresh();
    });
  }

  async function loadDefaults() {
    if (!confirm('Load the 29 Buffett-style starter stocks? Existing stocks are preserved.')) return;
    setError(null);
    startBusy(async () => {
      const res = await fetch('/api/watchlist/load-defaults', { method: 'POST' });
      if (!res.ok) {
        setError('Failed to load starter universe.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <section className="card flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Add a ticker</h2>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <input
            type="text"
            placeholder="Symbol (e.g. AAPL)"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            autoCapitalize="characters"
            maxLength={12}
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
          <button onClick={add} disabled={busy || !symbol.trim()} className="btn-primary disabled:opacity-50">
            Add
          </button>
        </div>
        <p className="text-[11px] text-ink-400">
          Just the symbol is enough. The agent enriches fundamentals (P/E, ROE, moat, Buffett score) over time via research.
        </p>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </section>

      {initial.length === 0 && (
        <section className="card flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Empty watchlist</h2>
          <p className="text-sm text-ink-300">
            Your watchlist is empty. The agent won&apos;t have a research universe to pull from
            unless you add tickers. Want to load the 29 Buffett-style defaults as a starting point?
          </p>
          <button onClick={loadDefaults} disabled={busy} className="btn-primary self-start disabled:opacity-50">
            Load starter universe (29 stocks)
          </button>
        </section>
      )}

      {initial.length > 0 && (
        <section className="card flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Watchlist ({initial.length})</h2>
            <button onClick={loadDefaults} disabled={busy} className="btn-ghost text-xs disabled:opacity-50">
              + Load 29 starter stocks
            </button>
          </div>
          <ul className="divide-y divide-ink-700/60">
            {initial.map((s) => (
              <li key={s.symbol} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink-50">
                    {s.symbol}
                    <span className="ml-2 text-xs font-normal text-ink-400">{s.name}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-400">
                    {s.sector ?? 'sector —'} ·{' '}
                    {s.buffettScore != null ? `Buffett ${s.buffettScore}` : 'not scored yet'} ·{' '}
                    {s.moatScore != null ? `Moat ${s.moatScore}` : 'moat —'}
                    {s.dividendYield != null && s.dividendYield > 0 && ` · Div ${s.dividendYield.toFixed(2)}%`}
                  </p>
                </div>
                <button
                  onClick={() => remove(s.symbol)}
                  disabled={busy}
                  className="text-xs text-red-300 hover:text-red-400 disabled:opacity-50"
                  aria-label={`Remove ${s.symbol}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
