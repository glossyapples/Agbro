'use client';

import { useState } from 'react';

// Advisory wizard panel. User-triggered button → Opus 4.7 ranks the
// pending candidates and returns structured verdicts. The user then still
// uses the existing Approve/Reject buttons on each candidate card — this
// panel is decision support, not an auto-approve path.

type WizardRecommendation = 'approve' | 'reject' | 'defer';

type Verdict = {
  symbol: string;
  rank: number;
  recommendation: WizardRecommendation;
  confidence: number;
  bullCase: string;
  bearCase: string;
  fitWithStrategy: string;
  concerns: string;
};

type WizardResult = {
  overallSummary: string;
  topPick: string | null;
  verdicts: Verdict[];
  costUsd: number;
  latencyMs: number;
  model: string;
};

export function CandidateWizardPanel({
  candidateCount,
  onVerdictsChange,
}: {
  candidateCount: number;
  // Surfaced so the parent can annotate its own cards with the wizard's
  // verdict. Called whenever the wizard runs (including clear).
  onVerdictsChange?: (verdicts: Verdict[]) => void;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WizardResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runWizard() {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch('/api/candidates/wizard', { method: 'POST' });
      if (res.status === 429) {
        setError('Rate limit hit — wizard is capped at 6 runs/hour.');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'wizard failed');
        return;
      }
      const data = (await res.json()) as WizardResult;
      setResult(data);
      onVerdictsChange?.(data.verdicts);
    } catch {
      setError('Network error — try again.');
    } finally {
      setRunning(false);
    }
  }

  function clear() {
    setResult(null);
    setError(null);
    onVerdictsChange?.([]);
  }

  if (candidateCount === 0) return null;

  return (
    <section className="card flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">Wizard</h2>
          <p className="mt-0.5 text-[11px] text-ink-400">
            Ask Opus 4.7 to rank your pending candidates against your active
            strategy + Buffett principles. Advisory only — you still click
            Approve/Reject. ~$0.30–0.60 per run, capped at 6/hr.
          </p>
        </div>
        {result ? (
          <button onClick={clear} className="btn-ghost text-xs" disabled={running}>
            Clear
          </button>
        ) : (
          <button
            onClick={runWizard}
            disabled={running}
            className="btn-primary text-xs disabled:opacity-50"
          >
            {running ? 'Thinking…' : 'Ask the wizard'}
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {result && (
        <div className="rounded-md border border-brand-500/40 bg-brand-500/5 p-3 text-xs text-ink-200">
          <p className="font-semibold text-ink-100">
            Verdict{result.topPick && <> · top pick: <span className="text-brand-300">{result.topPick}</span></>}
          </p>
          <p className="mt-1">{result.overallSummary}</p>
          <p className="mt-2 text-[10px] text-ink-500">
            {result.model} · {result.latencyMs}ms · ${result.costUsd.toFixed(3)} ·{' '}
            {result.verdicts.filter((v) => v.recommendation === 'approve').length} approve ·{' '}
            {result.verdicts.filter((v) => v.recommendation === 'reject').length} reject ·{' '}
            {result.verdicts.filter((v) => v.recommendation === 'defer').length} wait
          </p>
          <p className="mt-2 text-[11px] text-ink-400">
            Per-candidate Bull/Bear cases are shown directly on each candidate card below — scroll
            down to read them alongside the Approve/Reject buttons.
          </p>
        </div>
      )}
    </section>
  );
}

export type { Verdict as WizardVerdict };
