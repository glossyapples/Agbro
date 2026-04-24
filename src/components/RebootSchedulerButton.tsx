'use client';

// Escape hatch from /settings. Hits POST /api/scheduler/restart,
// reports whether the restart landed, and refreshes so the
// home-screen "last agent run" banner re-queries fresh state. Use
// when the in-process scheduler has died silently and the automatic
// watchdog hasn't caught up (usually because nothing probed
// /api/health between the crash and now).

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Result = {
  before: { tickCount: number; lastTickCompletedAt: string | null };
  after: { tickCount: number; startedAt: string | null };
};

export function RebootSchedulerButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function restart() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch('/api/scheduler/restart', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as Partial<Result> & {
        error?: string;
      };
      if (!res.ok) {
        setErr(body.error || `restart failed (${res.status})`);
        setBusy(false);
        return;
      }
      if (body.after) {
        setMsg(
          `Restarted. Next tick fires within 2 minutes. (Prior tick count: ${
            body.before?.tickCount ?? '?'
          })`
        );
      } else {
        setMsg('Restarted.');
      }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Scheduler</h2>
          <p className="mt-1 text-xs text-ink-400">
            If the "last agent run" banner on Home says <em>overdue</em>,
            the in-process scheduler has probably died silently (Railway
            pod resume / worker rotation). Tap below to force-restart it.
            Watchdogs on <code>/api/health</code> and{' '}
            <code>/api/scheduler/status</code> will also catch this on
            their own within one probe cycle.
          </p>
        </div>
        <button
          type="button"
          onClick={restart}
          disabled={busy}
          className="shrink-0 rounded-md bg-amber-600 px-3 py-2 text-xs font-semibold text-ink-900 disabled:opacity-50"
        >
          {busy ? 'Restarting…' : 'Restart'}
        </button>
      </div>
      {msg ? <p className="mt-3 text-xs text-emerald-300">{msg}</p> : null}
      {err ? (
        <p className="mt-3 rounded-sm bg-rose-950 p-2 text-xs text-rose-300">{err}</p>
      ) : null}
    </section>
  );
}
