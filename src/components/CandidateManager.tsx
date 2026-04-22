'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CandidateWizardPanel, type WizardVerdict } from './CandidateWizardPanel';

export type Candidate = {
  symbol: string;
  name: string;
  sector: string | null;
  candidateNotes: string | null;
  businessDescription: string | null;
  discoveredAt: string | null;
  fundamentalsSource: string | null;
  fundamentalsUpdatedAt: string | null;
  peRatio: number | null;
  dividendYield: number | null;
  debtToEquity: number | null;
  returnOnEquity: number | null;
  grossMarginPct: number | null;
  epsTTM: number | null;
  bookValuePerShare: number | null;
};

type Cooldown = { daysSinceLastScreen: number; blocked: boolean };

// Compact line of the key EDGAR-fetched ratios so the user can make an
// approve/reject decision without context-switching.
function fundamentalsLine(c: Candidate): string {
  const parts: string[] = [];
  if (c.peRatio != null) parts.push(`P/E ${c.peRatio.toFixed(1)}`);
  if (c.returnOnEquity != null) parts.push(`ROE ${c.returnOnEquity.toFixed(1)}%`);
  if (c.debtToEquity != null) parts.push(`D/E ${c.debtToEquity.toFixed(2)}`);
  if (c.grossMarginPct != null) parts.push(`GM ${c.grossMarginPct.toFixed(1)}%`);
  if (c.dividendYield != null && c.dividendYield > 0)
    parts.push(`Div ${c.dividendYield.toFixed(2)}%`);
  return parts.length ? parts.join(' · ') : 'no fundamentals fetched';
}

export function CandidateManager({
  initial,
  initialCooldown,
}: {
  initial: Candidate[];
  initialCooldown: Cooldown;
}) {
  const router = useRouter();
  const [candidates, setCandidates] = useState(initial);
  const [cooldown, setCooldown] = useState(initialCooldown);
  const [busy, startBusy] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [screenMsg, setScreenMsg] = useState<string | null>(null);
  // Keyed by symbol → the wizard's verdict for that candidate, so each
  // card can inline a "wizard says" badge. Cleared when the user re-screens
  // (new candidates invalidate old opinions) or explicitly clears via the
  // panel's Clear button.
  const [verdictsBySymbol, setVerdictsBySymbol] = useState<Record<string, WizardVerdict>>({});

  async function act(symbol: string, action: 'promote' | 'reject') {
    setError(null);
    startBusy(async () => {
      const res = await fetch(`/api/candidates/${encodeURIComponent(symbol)}/${action}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : `${action} failed`);
        return;
      }
      // Optimistic remove from the list; server-side revalidatePath handles
      // /watchlist + / refresh so those views match.
      setCandidates((prev) => prev.filter((c) => c.symbol !== symbol));
      router.refresh();
    });
  }

  async function runScreen() {
    setError(null);
    setScreenMsg(null);
    startBusy(async () => {
      const res = await fetch('/api/candidates/screen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'screen failed');
        return;
      }
      const data = await res.json();
      const n = data.candidates?.length ?? 0;
      setScreenMsg(
        n === 0
          ? 'No fresh candidates found on this pass. Market context may be expensive or exclusions too broad.'
          : `${n} new candidate${n === 1 ? '' : 's'} added — review below.`
      );
      setCooldown({ daysSinceLastScreen: 0, blocked: true });
      router.refresh();
    });
  }

  return (
    <>
      <section className="card flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Run a fresh screen</h2>
            <p className="mt-0.5 text-[11px] text-ink-400">
              {cooldown.daysSinceLastScreen >= 9999
                ? 'Never run before.'
                : `Last screen ${cooldown.daysSinceLastScreen} day${cooldown.daysSinceLastScreen === 1 ? '' : 's'} ago.`}{' '}
              Agent is rate-limited to one screen per 7 days; you can trigger
              one any time.
            </p>
          </div>
          <button onClick={runScreen} disabled={busy} className="btn-primary disabled:opacity-50">
            {busy ? 'Screening…' : 'Screen now'}
          </button>
        </div>
        {screenMsg && <p className="text-[11px] text-ink-300">{screenMsg}</p>}
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </section>

      {candidates.length === 0 ? (
        <section className="card text-sm text-ink-300">
          No pending candidates. The next agent wake-up or a manual screen above
          will populate this.
        </section>
      ) : (
        <>
          <section className="card border border-ink-700/60 bg-ink-800/40 text-[11px] text-ink-300">
            <p className="font-semibold text-ink-100">How this works</p>
            <p className="mt-1">
              Candidates sit here until you <strong>Approve</strong> (adds to
              watchlist — agent can trade) or <strong>Reject</strong> (screener
              won&apos;t surface again). If you ignore them, they stay put —
              the agent will <strong>not</strong> research or trade them until
              you say yes. Turn on <em>auto-promote high-conviction</em> in
              Settings to let the screener add clear Buffett-bar names for you,
              or use the <em>Wizard</em> below for a second opinion before
              committing.
            </p>
          </section>
          <CandidateWizardPanel
            candidateCount={candidates.length}
            onVerdictsChange={(verdicts) => {
              const map: Record<string, WizardVerdict> = {};
              for (const v of verdicts) map[v.symbol] = v;
              setVerdictsBySymbol(map);
            }}
          />
          <ul className="flex flex-col gap-3">
          {candidates.map((c) => (
            <li key={c.symbol} className="card">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-ink-50">
                    {c.symbol}
                    {c.name && c.name !== c.symbol && (
                      <span className="ml-2 text-xs font-normal text-ink-400">{c.name}</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-400">
                    {c.sector ?? 'sector —'}
                    {c.discoveredAt &&
                      ` · found ${Math.round(
                        (Date.now() - new Date(c.discoveredAt).getTime()) / 86_400_000
                      )}d ago`}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {verdictsBySymbol[c.symbol] && (
                    <span
                      className={`text-[10px] ${
                        verdictsBySymbol[c.symbol].recommendation === 'approve'
                          ? 'pill-good'
                          : verdictsBySymbol[c.symbol].recommendation === 'reject'
                            ? 'pill-bad'
                            : 'pill-warn'
                      }`}
                      title={`Wizard: ${verdictsBySymbol[c.symbol].recommendation} · confidence ${(verdictsBySymbol[c.symbol].confidence * 100).toFixed(0)}%`}
                    >
                      Wizard #{verdictsBySymbol[c.symbol].rank}
                    </span>
                  )}
                  <span
                    className={
                      c.fundamentalsSource === 'edgar' ? 'pill-good text-[10px]' : 'pill-warn text-[10px]'
                    }
                  >
                    {c.fundamentalsSource === 'edgar' ? 'EDGAR' : 'no data'}
                  </span>
                </div>
              </div>

              {c.businessDescription && (
                <p className="mt-2 text-xs text-ink-100">{c.businessDescription}</p>
              )}

              {c.candidateNotes && (
                <p className="mt-2 text-xs text-ink-300 italic">
                  <span className="not-italic text-ink-400">Thesis: </span>
                  {c.candidateNotes}
                </p>
              )}

              <p className="mt-2 text-[11px] text-ink-400">{fundamentalsLine(c)}</p>

              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => act(c.symbol, 'promote')}
                  disabled={busy}
                  className="btn-primary flex-1 disabled:opacity-50"
                  title="Add to main watchlist — agent can then research and trade this name"
                >
                  Approve → watchlist
                </button>
                <button
                  onClick={() => act(c.symbol, 'reject')}
                  disabled={busy}
                  className="btn-ghost flex-1 disabled:opacity-50"
                  title="Reject — screener won't suggest this name again"
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
        </>
      )}
    </>
  );
}
