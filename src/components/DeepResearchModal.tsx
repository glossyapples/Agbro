'use client';

// Bottom-sheet modal that shows the deep-research output for a single
// symbol. Owns the API call lifecycle (open SSE on mount, render
// progress / done / error states) so the parent (HoldingsList /
// WatchlistManager) just has to control which symbol is open.
//
// Streaming: the modal opens a Server-Sent Events stream from
// /api/research/deep and updates the loading view as the agent
// progresses (fetching → thinking → writing → persisting). The
// connection stays alive for the duration of the Opus call, which
// fixes the "Load failed" mobile Safari timeout we saw with the
// blocking version. On unmount or close button, AbortController
// cancels the stream so we don't keep burning Opus tokens after
// the user walked away.

import { useEffect, useState } from 'react';
import type { DeepResearchOutput } from '@/lib/agents/deep-research';

type Phase = 'fetching' | 'thinking' | 'writing' | 'persisting';

type State =
  | {
      status: 'streaming';
      phase: Phase;
      thinkingChars: number;
      writingChars: number;
    }
  | { status: 'done'; output: DeepResearchOutput; costUsd: number; createdAtISO: string }
  | { status: 'error'; message: string; kind?: string };

// Trivial SSE parser. Reads the response body as a stream, splits on
// blank-line frames, and yields one (eventName, dataJson) tuple per
// frame. Inlined rather than pulled from a library because the
// surface area is tiny and our event names + JSON payloads are
// fully under our control.
async function* parseSseStream(
  res: Response
): AsyncGenerator<{ event: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      // Each frame may have multiple lines: `event: NAME` then `data: …`.
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue; // SSE comment line
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) yield { event, data };
    }
  }
}

export function DeepResearchModal({
  symbol,
  onClose,
}: {
  symbol: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({
    status: 'streaming',
    phase: 'fetching',
    thinkingChars: 0,
    writingChars: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/research/deep', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbol }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          // Non-streaming error path (rate-limit, auth, etc.) — the
          // route may have returned a JSON body before establishing
          // the stream.
          const body = await res.json().catch(() => ({}));
          if (cancelled) return;
          setState({
            status: 'error',
            message: body.error ?? `HTTP ${res.status}`,
            kind: body.kind,
          });
          return;
        }
        for await (const frame of parseSseStream(res)) {
          if (cancelled) return;
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(frame.data);
          } catch {
            continue;
          }
          if (frame.event === 'phase') {
            const phase = payload.phase as Phase;
            setState((s) =>
              s.status === 'streaming' ? { ...s, phase } : s
            );
          } else if (frame.event === 'thinking_progress') {
            const chars = Number(payload.chars) || 0;
            setState((s) =>
              s.status === 'streaming' ? { ...s, thinkingChars: chars } : s
            );
          } else if (frame.event === 'writing_progress') {
            const chars = Number(payload.chars) || 0;
            setState((s) =>
              s.status === 'streaming' ? { ...s, writingChars: chars } : s
            );
          } else if (frame.event === 'done') {
            setState({
              status: 'done',
              output: payload.output as DeepResearchOutput,
              costUsd: Number(payload.costUsd) || 0,
              createdAtISO: String(payload.createdAtISO ?? new Date().toISOString()),
            });
          } else if (frame.event === 'error') {
            setState({
              status: 'error',
              message: String(payload.error ?? 'unknown error'),
              kind: payload.kind ? String(payload.kind) : undefined,
            });
          }
        }
      } catch (err) {
        if (cancelled) return;
        // Don't surface AbortError as a user-facing error — that's
        // the close-modal path.
        const e = err as { name?: string; message?: string };
        if (e?.name === 'AbortError') return;
        setState({ status: 'error', message: e?.message ?? 'stream failed' });
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
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

        {state.status === 'streaming' && (
          <LoadingView
            symbol={symbol}
            phase={state.phase}
            thinkingChars={state.thinkingChars}
            writingChars={state.writingChars}
          />
        )}
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

function LoadingView({
  symbol,
  phase,
  thinkingChars,
  writingChars,
}: {
  symbol: string;
  phase: Phase;
  thinkingChars: number;
  writingChars: number;
}) {
  // Progressive checklist — earlier phases tick to "done" as the
  // agent moves through the pipeline. Each phase shows a tiny live
  // progress counter when there's something to count (chars in /
  // chars out). All driven by the SSE event stream from the route.
  type Step = { phase: Phase; label: (active: boolean) => string };
  const steps: Step[] = [
    {
      phase: 'fetching',
      label: () => `Pulling SEC fundamentals + 10-K / 10-Q text for ${symbol}`,
    },
    {
      phase: 'thinking',
      label: (active) =>
        active && thinkingChars > 0
          ? `Opus 4.7 thinking (${thinkingChars.toLocaleString()} chars of reasoning)`
          : 'Opus 4.7 thinking through the filings',
    },
    {
      phase: 'writing',
      label: (active) =>
        active && writingChars > 0
          ? `Writing the analysis (${writingChars.toLocaleString()} chars and counting)`
          : 'Writing the structured research note',
    },
    { phase: 'persisting', label: () => 'Saving to your research notes' },
  ];
  const phaseOrder: Phase[] = ['fetching', 'thinking', 'writing', 'persisting'];
  const currentIdx = phaseOrder.indexOf(phase);

  return (
    <div className="space-y-2 py-6 text-sm">
      {steps.map((step, i) => {
        const isDone = i < currentIdx;
        const isActive = i === currentIdx;
        const isPending = i > currentIdx;
        return (
          <p
            key={step.phase}
            className={`flex items-center gap-2 ${
              isDone
                ? 'text-ink-500'
                : isActive
                  ? 'text-ink-200'
                  : 'text-ink-600'
            }`}
          >
            <span
              className={`inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full ${
                isDone
                  ? 'bg-emerald-700/60'
                  : isActive
                    ? 'animate-pulse bg-emerald-400'
                    : 'bg-ink-700'
              }`}
            >
              {isDone && (
                <svg viewBox="0 0 12 12" className="h-2 w-2 text-ink-950">
                  <path
                    d="M2 6l3 3 5-6"
                    stroke="currentColor"
                    strokeWidth="2"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </span>
            <span className={isPending ? 'opacity-70' : ''}>
              {step.label(isActive)}
            </span>
          </p>
        );
      })}
      <p className="pt-3 text-xs text-ink-500">
        Streaming over SSE so the connection stays alive for the whole
        Opus run. Cost: ~$0.50-2.00 per click, capped server-side.
      </p>
      <p className="text-[11px] text-ink-600">
        Closing the modal cancels the run and stops further token spend.
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
