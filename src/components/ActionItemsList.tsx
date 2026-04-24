'use client';

// Action items from meetings. Each row has a status pill + a status
// switcher (started ↔ on_hold ↔ completed ↔ blocked). No "Execute now"
// button — the orchestrator's priorities loop already picks up every
// research + review_position item with status='started' on the next
// wake, so keeping an execute action would either duplicate work or
// mislead the user about what the button does. Status transitions are
// the user's lever.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type ActionItem = {
  id: string;
  kind: string;
  description: string;
  status: string;
  createdAt: string;
  meetingId: string;
  meetingAt: string;
};

const KIND_META: Record<string, { label: string; autoExec: boolean; detail: string }> = {
  research: {
    label: 'Research',
    autoExec: true,
    detail: 'Auto-queued for the agent while status is "started". Mark on_hold to pause it.',
  },
  adjust_strategy: {
    label: 'Adjust strategy',
    autoExec: false,
    detail: 'Pending user decision via the linked PolicyChange',
  },
  review_position: {
    label: 'Review position',
    autoExec: true,
    detail: 'Auto-queued for the exit evaluator while status is "started". Mark on_hold to pause it.',
  },
  wait_for_data: {
    label: 'Wait for data',
    autoExec: false,
    detail: 'Passive — resolves when the data arrives',
  },
  note: {
    label: 'Note',
    autoExec: false,
    detail: 'Informational only',
  },
};

const STATUS_COLORS: Record<string, string> = {
  started: 'bg-ink-700 text-ink-200',
  on_hold: 'bg-amber-900/50 text-amber-300',
  completed: 'bg-brand-900/60 text-brand-300',
  blocked: 'bg-red-900/50 text-red-300',
};

export function ActionItemsList({ items }: { items: ActionItem[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <p className="text-xs text-ink-400">
        Nothing open. Action items from upcoming meetings will land here.
      </p>
    );
  }

  async function setStatus(id: string, status: string) {
    setBusyId(id);
    try {
      await fetch(`/api/meetings/action-items/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ul className="flex flex-col divide-y divide-ink-700/60">
      {items.map((item) => {
        const meta = KIND_META[item.kind] ?? {
          label: item.kind,
          autoExec: false,
          detail: '',
        };
        const statusClass = STATUS_COLORS[item.status] ?? 'pill';
        const busy = busyId === item.id;
        return (
          <li key={item.id} className="flex flex-col gap-1.5 py-2 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClass}`}>
                    {item.status.replace('_', ' ')}
                  </span>
                  <span className="pill">{meta.label}</span>
                  {meta.autoExec && item.status === 'started' && (
                    <span className="pill-good text-[9px] uppercase tracking-wider">
                      queued
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[12px] text-ink-100">{item.description}</p>
                <p className="mt-0.5 text-[10px] text-ink-500">{meta.detail}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {(['started', 'on_hold', 'completed', 'blocked'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(item.id, s)}
                  disabled={busy || item.status === s}
                  className={`text-[10px] uppercase tracking-wider ${
                    item.status === s
                      ? 'cursor-default text-ink-500'
                      : 'text-brand-400 hover:underline'
                  }`}
                >
                  {s.replace('_', ' ')}
                </button>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
