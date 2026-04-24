'use client';

// Impromptu meeting trigger. Clicking 'Run meeting' kicks off a Claude
// call server-side (see /api/meetings/run) and router.refreshes so the
// new meeting row + comic show up in the list below.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function MeetingControls() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [agenda, setAgenda] = useState('');
  const [showAgenda, setShowAgenda] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    setElapsed(0);
    const start = Date.now();
    const interval = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      500
    );
    try {
      const res = await fetch('/api/meetings/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'impromptu',
          agendaOverride: agenda.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'meeting failed');
        return;
      }
      setAgenda('');
      setShowAgenda(false);
      const payload = (await res.json().catch(() => ({}))) as { meetingId?: string };
      router.refresh();
      // Comic generation is awaited server-side inside the meeting run
      // now, so the refresh above already picks up the comic on the
      // card. Poll as a safety net in case the server bailed early
      // (process restart, OpenAI timeout beyond the route budget) —
      // usually this sees the image already present and stops on the
      // first tick.
      if (payload.meetingId) {
        pollForComic(payload.meetingId, router);
      }
    } catch (e) {
      setError(`Network error: ${(e as Error).message.slice(0, 120)}`);
    } finally {
      clearInterval(interval);
      setBusy(false);
    }
  }

  return (
    <section className="card flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Executive meeting</h2>
          <p className="mt-0.5 text-[11px] text-ink-400">
            Weekly meetings run on Friday afternoons automatically. Run one
            now to test or to get an extra read on current conditions.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className={`btn-primary whitespace-nowrap ${busy ? 'cursor-not-allowed opacity-60' : ''}`}
        >
          {busy ? (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-ink-900/40 border-t-ink-900" />
              {elapsed}s
            </span>
          ) : (
            'Run impromptu meeting'
          )}
        </button>
      </div>

      {!showAgenda && !busy && (
        <button
          type="button"
          onClick={() => setShowAgenda(true)}
          className="self-start text-[11px] text-brand-400"
        >
          + custom agenda
        </button>
      )}
      {showAgenda && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-[0.1em] text-ink-400">
            Agenda override (optional)
          </label>
          <input
            type="text"
            value={agenda}
            onChange={(e) => setAgenda(e.target.value)}
            placeholder="e.g. Review semiconductor exposure given this week's news"
            className="text-sm"
          />
          <p className="text-[10px] text-ink-500">
            Leave blank for the standard weekly agenda (review past week, flag
            risks, decide priorities).
          </p>
        </div>
      )}

      {busy && (
        <div className="rounded-md border border-brand-500/40 bg-brand-500/5 p-2 text-[11px] text-brand-200">
          Meeting in session · {elapsed}s elapsed · briefing the model + four
          executives arguing in one call, plus comic if you&apos;ve set an
          OpenAI key. Usually 40–80s end-to-end.
        </div>
      )}
      {error && <p className="text-[11px] text-red-300">{error}</p>}

      <ResetHistoryButton />
    </section>
  );
}

// Polls the comic status endpoint after a meeting run. Stops when the
// comic lands, errors, or we hit the 2-minute timeout. On resolution
// fires router.refresh() so the meeting card picks up the new image /
// error inline — the user doesn't have to reload.
function pollForComic(meetingId: string, router: ReturnType<typeof useRouter>) {
  const start = Date.now();
  const MAX_MS = 120_000;
  const INTERVAL_MS = 4_000;
  const FIRST_POLL_MS = 2_000;
  const expired = () => Date.now() - start > MAX_MS;
  const poll = async () => {
    if (expired()) return;
    try {
      const res = await fetch(`/api/meetings/${meetingId}/comic-status`, {
        cache: 'no-store',
      });
      // Transient non-200 (5xx, auth hiccup) — retry on the normal
      // interval until expiry, don't bail the whole poll.
      if (!res.ok) {
        setTimeout(poll, INTERVAL_MS);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        comicUrl?: string | null;
        comicError?: string | null;
      };
      if (body.comicUrl || body.comicError) {
        router.refresh();
        return; // done
      }
      // Empty body (comic still pending) → keep polling until expiry.
      setTimeout(poll, INTERVAL_MS);
    } catch {
      // Network blip — try again next interval unless expired.
      setTimeout(poll, INTERVAL_MS);
    }
  };
  // Comic now runs in-band inside the meeting POST, so the first poll
  // fires sooner — the common case is "already done, stop on first
  // tick". Keep the interval for the edge case where the server bailed
  // early (process restart, OpenAI timeout beyond the route budget).
  setTimeout(poll, FIRST_POLL_MS);
}

// Subtle "danger zone" action — wipes all meetings + action items +
// policy changes for the user so they can start fresh after major
// prompt / cast changes. Two-step: first click asks for confirmation,
// second click within 6 seconds actually deletes.
function ResetHistoryButton() {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function fire() {
    setBusy(true);
    try {
      const res = await fetch('/api/meetings/history', { method: 'DELETE' });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          meetings?: number;
          actionItems?: number;
          policyChanges?: number;
        };
        setToast(
          `Cleared ${body.meetings ?? 0} meetings, ${body.actionItems ?? 0} action items, ${body.policyChanges ?? 0} policy changes.`
        );
        setArmed(false);
        router.refresh();
        setTimeout(() => setToast(null), 4000);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 border-t border-ink-700/40 pt-2">
      {!armed ? (
        <button
          type="button"
          onClick={() => {
            setArmed(true);
            setTimeout(() => setArmed(false), 6000);
          }}
          className="text-[10px] text-ink-500 hover:text-red-300"
        >
          Reset meeting history…
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={fire}
            disabled={busy}
            className="text-[10px] font-semibold text-red-300 hover:underline"
          >
            {busy ? 'Clearing…' : 'Confirm: delete all meetings, items, and proposed changes'}
          </button>
          <button
            type="button"
            onClick={() => setArmed(false)}
            className="text-[10px] text-ink-400"
          >
            cancel
          </button>
        </>
      )}
      {toast && <span className="text-[10px] text-brand-300">{toast}</span>}
    </div>
  );
}
