'use client';

// One-shot "Burrybot's first research session" button. Appears on the
// strategy card when Burrybot is enabled (or on the Burry firm itself)
// and hasn't already run his onboarding. After a successful run the
// button disappears and the N hypotheses show up on /brain under the
// Hypothesis category, tagged with the strategy id.
//
// Two-step click: first click arms with a cost warning, second click
// fires. Keeps the confirm dialog off the main render path.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function FormHypothesisButton({
  strategyId,
  strategyName,
  alreadyFormed,
}: {
  strategyId: string;
  strategyName: string;
  alreadyFormed: boolean;
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [armed, setArmed] = useState(false);
  const [result, setResult] = useState<{ count: number; costUsd: number } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  if (alreadyFormed || result) {
    // Hide entirely once the hypotheses exist. The freshly-written
    // hypotheses are visible on /brain; no need for a stub here.
    if (result) {
      return (
        <p className="mt-2 text-[11px] text-brand-300">
          ✓ Burrybot wrote {result.count} starting hypotheses · $
          {result.costUsd.toFixed(3)}. See them on /brain under Hypothesis.
        </p>
      );
    }
    return null;
  }

  async function fire() {
    setError(null);
    startBusy(async () => {
      const res = await fetch(`/api/strategy/${strategyId}/form-hypothesis`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        hypothesesWritten?: number;
        costUsd?: number;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setError(
          typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
        );
        setArmed(false);
        return;
      }
      setResult({
        count: body.hypothesesWritten ?? 0,
        costUsd: body.costUsd ?? 0,
      });
      router.refresh();
    });
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      {!armed ? (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="btn-ghost self-start text-[11px]"
          title={`Burrybot's first-research session for ${strategyName}`}
        >
          → Form hypothesis
        </button>
      ) : (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px]">
          <p className="text-ink-200">
            Burrybot will spend ~20-40s reading {strategyName}&apos;s context +
            his own doctrine, then write 5-10 starting hypotheses to the
            firm&apos;s brain. ~$0.20-$0.40 on your Anthropic key.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={fire}
              disabled={busy}
              className="btn-primary text-[10px]"
            >
              {busy ? 'Reading…' : 'Confirm & run'}
            </button>
            <button
              type="button"
              onClick={() => setArmed(false)}
              disabled={busy}
              className="btn-ghost text-[10px] text-ink-400"
            >
              cancel
            </button>
          </div>
          {error && (
            <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-1.5 text-[10px] text-red-300">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
