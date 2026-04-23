'use client';

// Accept/reject card for meeting-proposed policy changes. Shown on
// /strategy?tab=meetings above the action-items list. Each proposed
// change has before/after values + the meeting's rationale; user
// accepts (applies to Account/Strategy) or rejects.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LocalTime } from '@/components/LocalTime';

type Proposed = {
  id: string;
  kind: string;
  targetKey: string;
  before: unknown;
  after: unknown;
  rationale: string;
  createdAt: string;
  meetingAt: string;
};

export function PolicyChangesList({ proposed }: { proposed: Proposed[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorFor, setErrorFor] = useState<{ id: string; msg: string } | null>(null);

  async function decide(id: string, action: 'accept' | 'reject') {
    setBusyId(id);
    setErrorFor(null);
    try {
      const res = await fetch(`/api/meetings/policy-changes/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorFor({
          id,
          msg: typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
        });
        return;
      }
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  if (proposed.length === 0) return null;

  return (
    <section className="card flex flex-col gap-3 border border-brand-500/30 bg-brand-500/5">
      <div>
        <h2 className="text-sm font-semibold text-brand-200">
          Proposed policy changes
        </h2>
        <p className="mt-0.5 text-[11px] text-ink-400">
          The partners have suggested these tweaks to your settings or strategy.
          Nothing is applied until you accept.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {proposed.map((p) => {
          const busy = busyId === p.id;
          const err = errorFor?.id === p.id ? errorFor.msg : null;
          return (
            <li
              key={p.id}
              className="rounded-md border border-ink-700/60 bg-ink-900/40 p-3 text-[12px]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[11px] text-brand-300">
                    {p.kind} · {p.targetKey}
                  </p>
                  <p className="mt-1 text-ink-200">{p.rationale}</p>
                  <p className="mt-1.5 text-[11px] text-ink-400">
                    <span className="line-through text-ink-500">
                      {formatValue(p.before)}
                    </span>
                    <span className="mx-1.5">→</span>
                    <span className="font-semibold text-brand-300">
                      {formatValue(p.after)}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[10px] text-ink-500">
                    Proposed <LocalTime value={p.meetingAt} format="relative" />
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => decide(p.id, 'accept')}
                    disabled={busy}
                    className="btn-primary text-[10px]"
                  >
                    {busy ? '…' : 'Accept'}
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(p.id, 'reject')}
                    disabled={busy}
                    className="btn-ghost text-[10px] text-red-300"
                  >
                    Reject
                  </button>
                </div>
              </div>
              {err && (
                <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-300">
                  {err}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
