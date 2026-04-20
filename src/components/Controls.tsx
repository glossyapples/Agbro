'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function Controls({ isPaused, isStopped }: { isPaused: boolean; isStopped: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function send(action: 'pause' | 'continue' | 'stop') {
    setBusy(action);
    try {
      await fetch('/api/account/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <h2 className="text-sm font-semibold text-ink-100">Live controls</h2>
      <p className="mt-1 text-xs text-ink-400">
        Interrupt the agent at any time. Stop halts all trading; pause lets open positions stand.
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <button
          disabled={busy !== null || (!isPaused && !isStopped)}
          onClick={() => send('continue')}
          className="btn-primary disabled:opacity-40"
        >
          ▶ Continue
        </button>
        <button
          disabled={busy !== null || isPaused || isStopped}
          onClick={() => send('pause')}
          className="btn-secondary disabled:opacity-40"
        >
          ⏸ Pause
        </button>
        <button
          disabled={busy !== null || isStopped}
          onClick={() => send('stop')}
          className="btn-danger disabled:opacity-40"
        >
          ■ Stop
        </button>
      </div>
    </section>
  );
}
