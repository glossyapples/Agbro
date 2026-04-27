'use client';

// Bottom-sheet modal that shows the deep-research output for a single
// symbol. Owns the API call lifecycle (fetch on mount, render
// loading / error / done states) so the parent (HoldingsList) just
// has to control which symbol is open.

import { useEffect, useState } from 'react';
import type { DeepResearchOutput } from '@/lib/agents/deep-research';

type State =
  | { status: 'loading' }
  | { status: 'done'; output: DeepResearchOutput; costUsd: number; createdAtISO: string }
  | { status: 'error'; message: string; kind?: string };

export function DeepResearchModal({
  symbol,
  onClose,
}: {
  symbol: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/research/deep', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbol }),
        });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !body.ok) {
          setState({
            status: 'error',
            message: body.error ?? `HTTP ${res.status}`,
            kind: body.kind,
          });
          return;
        }
        setState({
          status: 'done',
          output: body.output,
          costUsd: body.costUsd,
          createdAtISO: body.createdAtISO,
        });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'error', message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Deep research for ${symbol}`}
    >
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-xl border border-ink-700 bg-ink-950 p-5 sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-ink-400">Deep research</p>
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

        {state.status === 'loading' && <LoadingView symbol={symbol} />}
        {state.status === 'error' && <ErrorView message={state.message} kind={state.kind} />}
        {state.status === 'done' && (
          <DoneView
            output={state.output}
            costUsd={state.costUsd}
            createdAtISO={state.createdAtISO}
          />
        )}
      </div>
    </div>
  );
}

function LoadingView({ symbol }: { symbol: string }) {
  return (
    <div className="space-y-3 py-8 text-sm text-ink-300">
      <p className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
        Pulling SEC fundamentals + recent price for {symbol}...
      </p>
      <p className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
        Asking Opus 4.7 to write the research note (extended thinking enabled)...
      </p>
      <p className="text-xs text-ink-500">
        Typically takes 30-60s. Cost per click: ~$0.50-1.50. Capped server-side.
      </p>
    </div>
  );
}

function ErrorView({ message, kind }: { message: string; kind?: string }) {
  // Friendly labels per failure mode + a hint at how to fix.
  const HINTS: Record<string, { title: string; hint: string }> = {
    anthropic_auth: {
      title: 'Anthropic API not configured',
      hint: 'ANTHROPIC_API_KEY is missing or invalid on the server. Set it in Railway env vars.',
    },
    rate_limit: {
      title: 'Rate limit hit',
      hint: 'You clicked Research too many times in a short window. Wait a minute and retry.',
    },
    model_output_parse: {
      title: 'Model returned malformed JSON',
      hint: 'Opus failed to follow the schema. Retry once — usually transient.',
    },
    invalid_symbol: {
      title: 'Invalid symbol',
      hint: 'The ticker contains characters the agent rejected. Use a normal stock ticker.',
    },
    timeout: {
      title: 'Request timed out',
      hint: 'The model took longer than 120s. Retry; if it persists, the symbol may have unusually large fundamentals data.',
    },
  };
  const friendly = kind ? HINTS[kind] : undefined;
  return (
    <div className="rounded-md border border-rose-900 bg-rose-950/30 p-4 text-sm text-rose-200">
      <p className="font-semibold">{friendly?.title ?? 'Research failed'}</p>
      <p className="mt-1 break-words text-rose-300">{message}</p>
      {friendly?.hint && <p className="mt-3 text-xs text-rose-400/80">{friendly.hint}</p>}
      <p className="mt-3 text-[11px] text-rose-400/60">
        Server logs (Railway) have the full stack. Search for "research.deep.post" or the symbol.
      </p>
    </div>
  );
}

function DoneView({
  output,
  costUsd,
  createdAtISO,
}: {
  output: DeepResearchOutput;
  costUsd: number;
  createdAtISO: string;
}) {
  const conv = output.convictionScore;
  const convColor =
    conv >= 70
      ? 'text-emerald-400'
      : conv >= 40
        ? 'text-amber-300'
        : 'text-rose-400';
  return (
    <div className="space-y-5 text-sm text-ink-200">
      <section>
        <p className="stat-label">Thesis</p>
        <p className="mt-1 text-base">{output.thesis}</p>
      </section>

      <section className="rounded-md border border-ink-800 p-3">
        <div className="flex items-baseline justify-between">
          <p className="stat-label">Conviction</p>
          <p className={`text-2xl font-semibold tabular-nums ${convColor}`}>{conv}/100</p>
        </div>
        <p className="mt-1 text-[11px] text-ink-400">
          Reflects strength of evidence, not enthusiasm. Sparse-data names should score lower.
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-emerald-900/60 bg-emerald-950/10 p-3">
          <p className="stat-label text-emerald-300">Bull case</p>
          <p className="mt-1 whitespace-pre-line">{output.bullCase}</p>
        </div>
        <div className="rounded-md border border-rose-900/60 bg-rose-950/10 p-3">
          <p className="stat-label text-rose-300">Bear case</p>
          <p className="mt-1 whitespace-pre-line">{output.bearCase}</p>
        </div>
      </section>

      <section>
        <p className="stat-label">Summary</p>
        <p className="mt-1 whitespace-pre-line">{output.summary}</p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="stat-label">Kill criteria</p>
          <ul className="mt-1 list-disc pl-5 space-y-1">
            {output.killCriteria.map((k, i) => (
              <li key={i}>{k}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="stat-label">Primary risks</p>
          <ul className="mt-1 list-disc pl-5 space-y-1">
            {output.primaryRisks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="mt-4 flex items-center justify-between border-t border-ink-800 pt-3 text-[11px] text-ink-500">
        <span>Saved to research notes · {new Date(createdAtISO).toLocaleString()}</span>
        <span>Cost: ${costUsd.toFixed(3)}</span>
      </footer>
    </div>
  );
}
