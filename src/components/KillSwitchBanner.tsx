'use client';

// Red banner that renders on /home when a kill switch has tripped.
// Distinct from a manual pause — this says "the safety rails halted
// the agent; please review then clear to resume". One click clears
// the halt and unpauses.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LocalTime } from '@/components/LocalTime';

export function KillSwitchBanner({
  triggeredAt,
  reason,
}: {
  triggeredAt: string;
  reason: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/safety/clear-kill-switch', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(
          typeof body.error === 'string' ? body.error : `failed (HTTP ${res.status})`
        );
        return;
      }
      router.refresh();
    } catch (e) {
      setError(`Network error: ${(e as Error).message.slice(0, 120)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-red-500/50 bg-red-500/10 p-4 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]">
      <div className="flex items-start gap-3">
        <span className="text-2xl" aria-hidden="true">
          🛑
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-red-200">
            Safety rails halted your agent
          </p>
          <p className="mt-1 break-words text-[12px] leading-snug text-red-100/90">
            {reason}
          </p>
          <p className="mt-1 text-[10px] text-red-100/60">
            Triggered <LocalTime value={triggeredAt} format="relative" /> · new
            trades are blocked until you clear.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={clear}
              disabled={busy}
              className={`btn-primary text-[12px] ${busy ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              {busy ? 'Clearing…' : 'Clear & resume'}
            </button>
            <a
              href="/settings"
              className="text-[11px] text-red-200 underline-offset-2 hover:underline"
            >
              Adjust thresholds →
            </a>
          </div>
          {error && <p className="mt-2 text-[11px] text-red-300">{error}</p>}
        </div>
      </div>
    </section>
  );
}
