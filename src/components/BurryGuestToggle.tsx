'use client';

// Per-strategy toggle for inviting Burrybot as a guest analyst. Lives
// on every strategy card in /strategy (including non-active ones, so
// the setting travels if the user later activates that strategy).
//
// UX: a single button that flips between "Enable Burrybot" and
// "Disable Burrybot" depending on current state. Tapping the button
// opens a confirm dialog explaining what will happen; on confirm the
// PATCH fires immediately (no separate save step). Exception: if the
// active strategy IS Burry's own firm, the toggle is meaningless
// (he's already the principal), so we show a muted note instead.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function BurryGuestToggle({
  strategyId,
  isBurryFirm,
  initial,
}: {
  strategyId: string;
  // Computed server-side from Strategy.presetKey so user renames don't
  // break the toggle's visibility. True when presetKey ===
  // 'burry_deep_research' — the firm where Burrybot is the principal
  // and a guest toggle would be meaningless.
  isBurryFirm: boolean;
  initial: boolean;
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [enabled, setEnabled] = useState(initial);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isBurryFirm) {
    return (
      <p className="mt-2 text-[11px] text-ink-500">
        Burrybot is the principal at this firm — no guest toggle needed.
      </p>
    );
  }

  function commit() {
    const next = !enabled;
    setError(null);
    startBusy(async () => {
      const res = await fetch(`/api/strategy/${strategyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowBurryGuest: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'save failed');
        return;
      }
      setEnabled(next);
      setConfirmOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={busy}
        className={
          enabled
            ? 'rounded-md border border-rose-800/60 bg-rose-950/40 px-3 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-900/40 disabled:opacity-50'
            : 'rounded-md border border-brand-700/60 bg-brand-900/30 px-3 py-1.5 text-xs font-medium text-brand-200 transition hover:bg-brand-800/40 disabled:opacity-50'
        }
      >
        {enabled ? 'Disable Burrybot' : 'Enable Burrybot'}
      </button>
      {error && <p className="mt-1 text-[11px] text-rose-300">{error}</p>}

      {confirmOpen && (
        <BurryConfirm
          mode={enabled ? 'disable' : 'enable'}
          busy={busy}
          onConfirm={commit}
          onCancel={() => {
            setConfirmOpen(false);
            setError(null);
          }}
        />
      )}
    </div>
  );
}

function BurryConfirm({
  mode,
  busy,
  onConfirm,
  onCancel,
}: {
  mode: 'enable' | 'disable';
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const enabling = mode === 'enable';
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={enabling ? 'Enable Burrybot' : 'Disable Burrybot'}
    >
      <div
        className="w-full max-w-md rounded-t-xl border border-ink-700 bg-ink-950 p-5 sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-ink-100">
          {enabling ? 'Enable Burrybot?' : 'Disable Burrybot?'}
        </h2>
        <p className="mt-2 text-sm text-ink-300">
          {enabling
            ? 'Burrybot will join future meetings as a guest analyst — reads 10-Ks the firm misses, flags 1-3 names per meeting. Does not drive final calls.'
            : 'Burrybot will stop attending this strategy’s meetings. Existing hypotheses stay in the brain.'}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:bg-ink-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={
              enabling
                ? 'rounded-md bg-brand-500 px-3 py-2 text-sm font-semibold text-ink-900 hover:bg-brand-400 disabled:opacity-50'
                : 'rounded-md bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50'
            }
          >
            {busy
              ? enabling
                ? 'Enabling…'
                : 'Disabling…'
              : enabling
                ? 'Enable Burrybot'
                : 'Disable Burrybot'}
          </button>
        </div>
      </div>
    </div>
  );
}
