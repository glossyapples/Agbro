'use client';

import { useEffect, useState } from 'react';

type Turn = { id: string; role: 'user' | 'agent'; content: string };

export function WizardChat({
  strategyId,
  initialTurns,
}: {
  strategyId: string;
  initialTurns: Turn[];
}) {
  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // Reconcile local state with server-rendered turns whenever the parent
  // re-renders with a new list. useState(initialTurns) only captures the
  // first render, so without this, turns added by the server during a
  // concurrent session (or a lost client-side response) would never appear.
  useEffect(() => {
    setTurns(initialTurns);
  }, [initialTurns]);

  async function send() {
    if (!draft.trim() || busy) return;
    const message = draft.trim();
    setDraft('');
    setBusy(true);
    const userTurn: Turn = { id: crypto.randomUUID(), role: 'user', content: message };
    setTurns((t) => [...t, userTurn]);
    try {
      const res = await fetch('/api/strategy/wizard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategyId, message }),
      });
      const data = await res.json();
      setTurns((t) => [
        ...t,
        { id: data.turnId ?? crypto.randomUUID(), role: 'agent', content: data.reply ?? data.error ?? '...' },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
        {turns.length === 0 && (
          <p className="text-xs text-ink-400">
            Ask the wizard anything: "help me tighten margin-of-safety", "propose a version for a
            conservative retiree", "explain why we prefer dividend growers".
          </p>
        )}
        {turns.map((t) => (
          <div
            key={t.id}
            className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
              t.role === 'user'
                ? 'self-end bg-brand-500 text-ink-900'
                : 'self-start bg-ink-700 text-ink-100'
            }`}
          >
            {t.content}
          </div>
        ))}
        {busy && <div className="self-start rounded-2xl bg-ink-700 px-3 py-2 text-xs text-ink-300">Thinking…</div>}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message the strategy wizard…"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          className="flex-1 resize-none"
        />
        <button onClick={send} disabled={busy || !draft.trim()} className="btn-primary disabled:opacity-50">
          Send
        </button>
      </div>
    </div>
  );
}
