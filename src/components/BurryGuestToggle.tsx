'use client';

// Per-strategy toggle for inviting Burrybot as a guest analyst. Lives
// on every strategy card in /strategy (including non-active ones, so
// the setting travels if the user later activates that strategy).
//
// UX: a checkbox + short explainer + "Save" button. We only persist on
// explicit save so the user can read the blurb before committing; the
// button stays disabled until the checkbox state differs from the
// saved value. Exception: if the active strategy IS Burry's own firm,
// the toggle is meaningless (he's already the principal), so we show
// a muted note instead of the control.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function BurryGuestToggle({
  strategyId,
  strategyName,
  initial,
}: {
  strategyId: string;
  strategyName: string;
  initial: boolean;
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [checked, setChecked] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // The Burry firm doesn't need a guest toggle — he's the principal.
  // Detect it by name match, mirroring the cast inference logic.
  const isBurryFirm = strategyName.toLowerCase().includes('burry');
  if (isBurryFirm) {
    return (
      <p className="mt-2 text-[11px] text-ink-500">
        Burrybot is the principal at this firm — no guest toggle needed.
      </p>
    );
  }

  const dirty = checked !== saved;

  async function save() {
    setError(null);
    setToast(null);
    startBusy(async () => {
      const res = await fetch(`/api/strategy/${strategyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowBurryGuest: checked }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'save failed');
        return;
      }
      setSaved(checked);
      setToast(
        checked
          ? 'Burrybot will attend future meetings here.'
          : 'Burrybot will stop attending this firm.'
      );
      router.refresh();
      setTimeout(() => setToast(null), 3500);
    });
  }

  return (
    <div className="mt-3 rounded-md border border-ink-700/50 bg-ink-900/40 p-2.5 text-[11px]">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-semibold text-ink-200">
            Invite Burrybot as guest analyst
          </span>
          <span className="text-ink-500">
            The new hire who reads 10-Ks nobody else reads. Speaks 1–3 times per
            meeting, flags names worth the firm&apos;s deep look. Does not drive
            final calls or propose policy changes.
          </span>
        </div>
      </label>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className={`btn-primary text-[10px] ${!dirty ? 'opacity-40' : ''}`}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {toast && <span className="text-[10px] text-brand-300">{toast}</span>}
        {error && <span className="text-[10px] text-red-300">{error}</span>}
      </div>
    </div>
  );
}
