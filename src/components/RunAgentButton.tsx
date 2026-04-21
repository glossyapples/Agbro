'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function RunAgentButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/agents/run', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason =
          typeof data.error === 'string'
            ? data.error
            : typeof data === 'object' && data
              ? JSON.stringify(data)
              : 'unknown error';
        setMessage(`HTTP ${res.status}: ${reason}`);
        return;
      }
      setMessage(
        data.status ? `Run ${data.status}${data.decision ? ` → ${data.decision}` : ''}` : 'Triggered'
      );
      router.refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {message && <span className="text-[11px] text-ink-400">{message}</span>}
      <button onClick={go} disabled={busy} className="btn-primary disabled:opacity-50">
        {busy ? 'Waking…' : 'Wake agent'}
      </button>
    </div>
  );
}
