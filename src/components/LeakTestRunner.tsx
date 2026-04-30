'use client';

import { useCallback, useState } from 'react';

type ProgressEvent = {
  i: number;
  total: number;
  symbol: string;
  decisionDateISO: string;
  strictTarget: number | null;
  unrestrictedTarget: number | null;
  actualReturnPct: number | null;
  unrestrictedCloserToActual: boolean | null;
  pairCostUsd: number;
  totalCostUsd: number;
};

type SummaryEvent = {
  model: string;
  pairCount: number;
  completed: number;
  parsedBoth: number;
  withActualReturn: number;
  unrestrictedWinRate: number | null;
  meanTargetDivergencePct: number | null;
  meanConvictionDivergence: number | null;
  totalCostUsd: number;
  aborted: boolean;
  abortReason: string | null;
};

export function LeakTestRunner() {
  const [model, setModel] = useState<'haiku' | 'opus'>('haiku');
  const [costCapUsd, setCostCapUsd] = useState<string>('1.00');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState<{
    pairCount: number;
    costCapUsd: number;
    pairsName: string;
  } | null>(null);
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [summary, setSummary] = useState<SummaryEvent | null>(null);

  const run = useCallback(async () => {
    setError(null);
    setStart(null);
    setProgress([]);
    setSummary(null);
    setRunning(true);
    try {
      const res = await fetch('/api/research/leak-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          costCapUsd: Number(costCapUsd),
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      if (!res.body) throw new Error('no response body');
      // Manual SSE parser — same shape as the deep-research stream
      // we already do elsewhere. SSE is `event: X\ndata: Y\n\n`
      // separated; we accumulate in a buffer and emit whole frames.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          if (!frame.trim()) continue;
          const eventLine = frame.match(/^event:\s*(.+)$/m);
          const dataLine = frame.match(/^data:\s*(.+)$/m);
          if (!eventLine || !dataLine) continue;
          const evt = eventLine[1].trim();
          let data: unknown;
          try {
            data = JSON.parse(dataLine[1]);
          } catch {
            continue;
          }
          if (evt === 'start') {
            setStart(
              data as { pairCount: number; costCapUsd: number; pairsName: string }
            );
          } else if (evt === 'progress') {
            setProgress((prev) => [...prev, data as ProgressEvent]);
          } else if (evt === 'summary') {
            setSummary(data as SummaryEvent);
          } else if (evt === 'pair_error') {
            // Surface but don't fail the whole run.
            console.warn('leak-test pair error', data);
          }
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [model, costCapUsd]);

  // Estimate up-front cost so the user sees what they're agreeing to.
  // 61 pairs × 2 arms. Haiku ~$0.005/call; Opus ~$0.05/call.
  const estimateUsd = model === 'haiku' ? 61 * 2 * 0.005 : 61 * 2 * 0.05;

  return (
    <>
      <section className="card">
        <h2 className="text-sm font-semibold text-ink-100">Configure</h2>
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <label className="text-xs text-ink-300">Model</label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setModel('haiku');
                  setCostCapUsd('1.00');
                }}
                disabled={running}
                className={`rounded-md px-3 py-2 text-xs ${
                  model === 'haiku'
                    ? 'bg-brand-500/30 border border-brand-500 text-ink-50'
                    : 'border border-ink-700 text-ink-300'
                }`}
              >
                Haiku 4.5
                <br />
                <span className="text-[10px] text-ink-400">
                  Directional, ~$0.30
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setModel('opus');
                  setCostCapUsd('15.00');
                }}
                disabled={running}
                className={`rounded-md px-3 py-2 text-xs ${
                  model === 'opus'
                    ? 'bg-brand-500/30 border border-brand-500 text-ink-50'
                    : 'border border-ink-700 text-ink-300'
                }`}
              >
                Opus 4.7
                <br />
                <span className="text-[10px] text-ink-400">
                  Rigorous, ~$5-7
                </span>
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs text-ink-300">
              Cost cap (USD) — runner stops at this dollar amount
            </label>
            <input
              type="number"
              step="0.5"
              min="0.5"
              max="50"
              value={costCapUsd}
              disabled={running}
              onChange={(e) => setCostCapUsd(e.target.value)}
              className="mt-1 w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-50"
            />
            <p className="mt-1 text-[10px] text-ink-400">
              Estimated full-run cost: ${estimateUsd.toFixed(2)}. Cap
              should be ~50% above this to absorb token-count variance.
            </p>
          </div>
          <button
            type="button"
            disabled={running}
            onClick={run}
            className="rounded-md bg-emerald-500/30 border border-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-100 disabled:opacity-50"
          >
            {running ? 'Running…' : 'Start leak test'}
          </button>
          {model === 'opus' && (
            <p className="text-[11px] text-amber-300">
              Opus run takes 20-40 minutes. Keep this page open
              and your phone screen on. If the connection drops the
              run continues server-side; refresh to see results stop
              streaming, but you&apos;ll need the JSON report endpoint to
              recover them.
            </p>
          )}
          {error && (
            <p className="text-xs text-rose-300">Error: {error}</p>
          )}
        </div>
      </section>

      {start && (
        <section className="card">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink-100">Live</h2>
            <span className="text-[11px] text-ink-400">
              {progress.length}/{start.pairCount} pairs
            </span>
          </div>
          {summary == null && progress.length > 0 && (
            <div className="mt-2 h-1.5 rounded-full bg-ink-800">
              <div
                className="h-full rounded-full bg-brand-500 transition-all"
                style={{
                  width: `${(progress.length / start.pairCount) * 100}%`,
                }}
              />
            </div>
          )}
          <ul className="mt-3 max-h-[40vh] space-y-1 overflow-auto font-mono text-[10px] leading-tight text-ink-300">
            {progress.slice().reverse().map((p) => (
              <li key={`${p.i}-${p.symbol}`} className="flex gap-2">
                <span className="text-ink-500">[{p.i}]</span>
                <span className="text-ink-100">{p.symbol}</span>
                <span>
                  {p.decisionDateISO} · S=
                  {p.strictTarget != null
                    ? `$${p.strictTarget.toFixed(0)}`
                    : 'fail'}{' '}
                  U=
                  {p.unrestrictedTarget != null
                    ? `$${p.unrestrictedTarget.toFixed(0)}`
                    : 'fail'}{' '}
                  actual=
                  {p.actualReturnPct != null
                    ? `${p.actualReturnPct >= 0 ? '+' : ''}${p.actualReturnPct.toFixed(0)}%`
                    : '—'}{' '}
                  {p.unrestrictedCloserToActual === true
                    ? '✗ leak'
                    : p.unrestrictedCloserToActual === false
                      ? '✓ strict'
                      : '·'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary && (
        <section className="card border border-emerald-500/30 bg-emerald-500/5">
          <h2 className="text-sm font-semibold text-emerald-200">
            Headline result
          </h2>
          <p className="mt-2 text-3xl font-semibold tabular-nums">
            {summary.unrestrictedWinRate != null
              ? `${(summary.unrestrictedWinRate * 100).toFixed(0)}%`
              : '—'}
            <span className="ml-2 text-xs font-normal text-ink-300">
              unrestricted win rate
            </span>
          </p>
          <p className="mt-2 text-xs text-ink-300">
            {summary.unrestrictedWinRate == null
              ? 'No valid pairs to compare.'
              : summary.unrestrictedWinRate >= 0.7
                ? '🚨 Strong leak. Model is using post-decision-date knowledge. agent_deep_research backtests would be contaminated. Do NOT proceed to W5.'
                : summary.unrestrictedWinRate >= 0.6
                  ? '⚠️ Moderate leak. Iterate on the strict scaffold prompt and re-run W0 before W5.'
                  : '✓ Within noise. Strict scaffold is constraining the model. W5 is worth running.'}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-ink-400">Pairs completed</p>
              <p className="text-sm tabular-nums">
                {summary.completed}/{summary.pairCount}
              </p>
            </div>
            <div>
              <p className="text-ink-400">Both arms parsed</p>
              <p className="text-sm tabular-nums">{summary.parsedBoth}</p>
            </div>
            <div>
              <p className="text-ink-400">Mean target divergence</p>
              <p className="text-sm tabular-nums">
                {summary.meanTargetDivergencePct != null
                  ? `${(summary.meanTargetDivergencePct * 100).toFixed(1)}%`
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-ink-400">Mean conviction divergence</p>
              <p className="text-sm tabular-nums">
                {summary.meanConvictionDivergence != null
                  ? `${summary.meanConvictionDivergence.toFixed(1)} pts`
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-ink-400">Total cost</p>
              <p className="text-sm tabular-nums">
                ${summary.totalCostUsd.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-ink-400">Status</p>
              <p className="text-sm">
                {summary.aborted ? 'Aborted (cap)' : 'Complete'}
              </p>
            </div>
          </div>
          {summary.aborted && summary.abortReason && (
            <p className="mt-2 text-[11px] text-amber-300">
              {summary.abortReason}
            </p>
          )}
        </section>
      )}
    </>
  );
}
