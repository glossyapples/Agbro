'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { DeepResearchModal } from './DeepResearchModal';
import { ManualBuyModal } from './ManualBuyModal';

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
  fundamentalsSource: string | null;
  fundamentalsUpdatedAt: string | null;
  // 'agent' = agent added this row directly via add_to_watchlist.
  // 'screener' = candidate that was promoted (typically by user).
  // null / 'watchlist' = user-curated.
  candidateSource: string | null;
  candidateNotes: string | null;
};

// Map a data source + age to a tiny status pill. We want the agent AND the
// user to be able to glance at the watchlist and see which rows are trustworthy.
function dataFreshness(s: WatchlistStock): { label: string; className: string } {
  if (s.fundamentalsSource === 'edgar' && s.fundamentalsUpdatedAt) {
    const ageDays = (Date.now() - new Date(s.fundamentalsUpdatedAt).getTime()) / 86_400_000;
    if (ageDays < 7) return { label: 'EDGAR · fresh', className: 'pill-good' };
    if (ageDays < 30) return { label: `EDGAR · ${Math.round(ageDays)}d`, className: 'pill' };
    return { label: `EDGAR · ${Math.round(ageDays)}d old`, className: 'pill-warn' };
  }
  if (s.fundamentalsSource === 'agent') return { label: 'Agent-entered', className: 'pill' };
  if (s.fundamentalsSource === 'seed') return { label: 'Seed (unverified)', className: 'pill-warn' };
  return { label: 'No data yet', className: 'pill-warn' };
}

export function WatchlistManager({ initial }: { initial: WatchlistStock[] }) {
  const router = useRouter();
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();
  // One modal at a time. Either "research" or "buy" for a given symbol.
  const [researchSymbol, setResearchSymbol] = useState<string | null>(null);
  const [buySymbol, setBuySymbol] = useState<string | null>(null);

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

  async function refreshFromSec() {
    setError(null);
    startBusy(async () => {
      const res = await fetch('/api/watchlist/refresh-fundamentals', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Refresh failed. Check server logs.');
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Watchlist ({initial.length})</h2>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={refreshFromSec}
                disabled={busy}
                className="rounded-md border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs font-medium text-ink-100 transition hover:bg-ink-700 disabled:opacity-50"
                title="Pulls fresh filings data directly from SEC EDGAR for every symbol below. Takes ~10-30 seconds."
              >
                ↻ Refresh from SEC
              </button>
              {/* "Load 29 starter stocks" is a one-time onboarding helper.
                  Once the user has built up their own watchlist (≥10
                  symbols of any provenance), the button is just visual
                  noise that risks duplicating work — hide it. The actual
                  add-symbol input above remains the path for incremental
                  additions. */}
              {initial.length < 10 && (
                <button
                  onClick={loadDefaults}
                  disabled={busy}
                  className="rounded-md border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs font-medium text-ink-100 transition hover:bg-ink-700 disabled:opacity-50"
                  title="Adds 29 high-quality starter names (BRK.B, V, MA, KO, PEP, etc.) to your watchlist."
                >
                  + Load 29 starter stocks
                </button>
              )}
            </div>
          </div>
          <ul className="divide-y divide-ink-700/60">
            {initial.map((s) => (
              <li key={s.symbol} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink-50">
                    {s.symbol}
                    <span className="ml-2 text-xs font-normal text-ink-400">{s.name}</span>
                    {s.candidateSource === 'agent' && (
                      <span
                        className="ml-2 rounded-sm bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-300"
                        title="Added by the agent during research"
                      >
                        Agent-added
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-400">
                    {s.sector ?? 'sector —'} ·{' '}
                    {s.buffettScore != null ? `Buffett ${s.buffettScore}` : 'not scored yet'} ·{' '}
                    {s.moatScore != null ? `Moat ${s.moatScore}` : 'moat —'}
                    {s.dividendYield != null && s.dividendYield > 0 && ` · Div ${s.dividendYield.toFixed(2)}%`}
                  </p>
                  <p className="mt-0.5">
                    {(() => {
                      const f = dataFreshness(s);
                      return <span className={`${f.className} text-[10px]`}>{f.label}</span>;
                    })()}
                  </p>
                  {s.candidateSource === 'agent' && s.candidateNotes && (
                    <p className="mt-1 text-[11px] italic text-ink-400">
                      {s.candidateNotes}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setResearchSymbol(s.symbol)}
                    className="rounded-md border border-ink-700 px-2 py-1 text-[11px] font-medium text-ink-300 hover:bg-ink-800 hover:text-ink-100"
                    aria-label={`Run deep research on ${s.symbol}`}
                    title="Deep research (~$0.50-1.50, Opus 4.7)"
                  >
                    Research
                  </button>
                  <button
                    onClick={() => setBuySymbol(s.symbol)}
                    className="rounded-md bg-emerald-700 px-2 py-1 text-[11px] font-semibold text-emerald-50 hover:bg-emerald-600"
                    aria-label={`Manually buy ${s.symbol}`}
                    title="Place a manual market-buy on this symbol (paper account)"
                  >
                    Buy
                  </button>
                  <button
                    onClick={() => remove(s.symbol)}
                    disabled={busy}
                    className="text-xs text-red-300 hover:text-red-400 disabled:opacity-50"
                    aria-label={`Remove ${s.symbol}`}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {researchSymbol && (
        <DeepResearchModal
          symbol={researchSymbol}
          onClose={() => setResearchSymbol(null)}
        />
      )}
      {buySymbol && (
        <ManualBuyModal
          symbol={buySymbol}
          onClose={() => {
            setBuySymbol(null);
            // Refresh watchlist + positions after a buy. The buy itself
            // doesn't add the row to /positions immediately (Alpaca
            // settles asynchronously) but a soft refresh keeps the
            // surrounding numbers — Buffett scores, fundamentals — fresh.
            router.refresh();
          }}
        />
      )}
    </>
  );
}
