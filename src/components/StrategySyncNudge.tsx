'use client';

// One-click "pull in new library strategies" banner for /strategy. Only
// rendered when the server-side check finds library strategies the user
// hasn't seeded yet (e.g. Burry after we add him later). Same endpoint
// as the /brain sync button — just surfaced where the user will run
// into the gap.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function StrategySyncNudge({ missingSlugs }: { missingSlugs: string[] }) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (missingSlugs.length === 0) return null;

  async function sync() {
    setError(null);
    startBusy(async () => {
      const res = await fetch('/api/brain/load-defaults', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'sync failed');
        return;
      }
      router.refresh();
    });
  }

  const label = missingSlugs.length === 1 ? 'strategy' : 'strategies';
  // Turn slugs into readable labels (deep-value-graham → Deep Value Graham).
  const preview = missingSlugs
    .slice(0, 3)
    .map((s) =>
      s
        .split('-')
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' ')
    )
    .join(', ');
  const more = missingSlugs.length > 3 ? ` + ${missingSlugs.length - 3} more` : '';

  return (
    <div className="flex flex-col gap-2 rounded-md border border-brand-500/40 bg-brand-500/10 p-3 text-[12px] sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-semibold text-brand-200">
          {missingSlugs.length} new {label} available
        </p>
        <p className="mt-0.5 text-[11px] text-ink-300">
          {preview}
          {more} · not yet in your archive. Pull them in below.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={sync}
          disabled={busy}
          className="btn-primary text-[11px] whitespace-nowrap"
        >
          {busy ? 'Syncing…' : 'Pull in'}
        </button>
        {error && <span className="text-[11px] text-red-300">{error}</span>}
      </div>
    </div>
  );
}
