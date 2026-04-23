'use client';

// Visual card for a single meeting in the /strategy?tab=meetings
// history list. Shows the comic (if generated), one-line summary,
// sentiment + action-item count pills, and an expandable panel for
// the full transcript.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LocalTime } from '@/components/LocalTime';

type TranscriptTurn = { role: string; text: string };

type MeetingSummary = {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  summary: string | null;
  comicUrl: string | null;
  comicError: string | null;
  costUsd: number | null;
  errorMessage: string | null;
  transcriptJson: unknown;
  actionItemCount: number;
  sentiment: string | null;
};

const SENTIMENT_COLORS: Record<string, string> = {
  bullish: 'bg-brand-900/60 text-brand-300',
  cautious: 'bg-amber-900/50 text-amber-300',
  defensive: 'bg-red-900/50 text-red-300',
  opportunistic: 'bg-sky-900/50 text-sky-300',
};

export function MeetingCard({ meeting }: { meeting: MeetingSummary }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [comicBusy, setComicBusy] = useState(false);
  const [comicError, setComicError] = useState<string | null>(null);
  // Local override — populated synchronously from the API response
  // when the user clicks "Generate comic" so the image renders
  // immediately without waiting for router.refresh() to re-fetch the
  // server component tree. Falls back to the persisted prop otherwise.
  const [localComicUrl, setLocalComicUrl] = useState<string | null>(null);
  const effectiveComicUrl = localComicUrl ?? meeting.comicUrl;

  async function generateComic() {
    setComicBusy(true);
    setComicError(null);
    try {
      const res = await fetch(`/api/meetings/${meeting.id}/generate-comic`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        imageUrl?: string;
      };
      if (!res.ok) {
        setComicError(
          typeof body.error === 'string' ? body.error : `failed (HTTP ${res.status})`
        );
        return;
      }
      if (body.imageUrl) {
        // Render the comic in place immediately. router.refresh() in
        // parallel updates the rest of the page (costs, etc.) but we
        // don't block on it.
        setLocalComicUrl(body.imageUrl);
      }
      router.refresh();
    } catch (err) {
      setComicError(`Network error: ${(err as Error).message.slice(0, 120)}`);
    } finally {
      setComicBusy(false);
    }
  }

  const transcript =
    (meeting.transcriptJson as { transcript?: TranscriptTurn[]; decisions?: string[] } | null)
      ?.transcript ?? [];
  const decisions =
    (meeting.transcriptJson as { decisions?: string[] } | null)?.decisions ?? [];
  // Cast snapshot (new meetings). Lets us show the character's actual
  // name (e.g. "Buff-bot") instead of the structural role key
  // (e.g. "warren_buffbot") in the transcript.
  const castSnapshot =
    (meeting.transcriptJson as {
      cast?: { characters?: Record<string, { name: string }> };
    } | null)?.cast?.characters ?? null;
  function roleLabel(role: string): string {
    return castSnapshot?.[role]?.name ?? role.replace(/_/g, ' ');
  }

  if (meeting.status === 'running') {
    return (
      <article className="card">
        <p className="text-xs text-ink-300">
          Meeting in session · started <LocalTime value={meeting.startedAt} format="relative" />
        </p>
      </article>
    );
  }
  if (meeting.status === 'errored') {
    return (
      <article className="card border border-red-500/40 bg-red-500/5">
        <p className="text-xs font-semibold text-red-300">Meeting errored</p>
        <p className="mt-1 text-[11px] text-red-300/80">
          {meeting.errorMessage ?? 'Unknown error'}
        </p>
      </article>
    );
  }

  const sentimentClass = meeting.sentiment
    ? SENTIMENT_COLORS[meeting.sentiment] ?? 'pill'
    : null;

  return (
    <article className="card flex flex-col gap-3">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.1em] text-ink-400">
            {meeting.kind} meeting
          </p>
          <p className="text-sm font-semibold text-ink-50">
            <LocalTime value={meeting.startedAt} format="date" />
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          {sentimentClass && (
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${sentimentClass}`}>
              {meeting.sentiment}
            </span>
          )}
          {meeting.actionItemCount > 0 && (
            <span className="pill">
              {meeting.actionItemCount} action{meeting.actionItemCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </header>

      {effectiveComicUrl ? (
        <div className="flex flex-col gap-2">
          <ComicImage
            src={effectiveComicUrl}
            filename={`agbro-meeting-${meeting.startedAt.slice(0, 10)}.png`}
          />
          <SaveComicButton
            imageUrl={effectiveComicUrl}
            filename={`agbro-meeting-${meeting.startedAt.slice(0, 10)}.png`}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-ink-700/60 p-3 text-[11px] text-ink-400">
          {meeting.comicError ? (
            <div className="rounded border border-red-500/40 bg-red-500/5 p-2 text-red-300">
              <p className="font-semibold">Previous comic attempt failed:</p>
              <p className="mt-0.5 break-words">{meeting.comicError}</p>
            </div>
          ) : (
            <p>
              No comic yet for this meeting. Generate one on demand — costs
              ~$0.05, billed to your OpenAI account. Add a key in{' '}
              <a href="/settings" className="text-brand-400">
                Settings
              </a>{' '}
              first if you haven&apos;t.
            </p>
          )}
          <button
            type="button"
            onClick={generateComic}
            disabled={comicBusy}
            className={`btn-primary self-start text-[11px] ${
              comicBusy ? 'cursor-not-allowed opacity-60' : ''
            }`}
          >
            {comicBusy ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-ink-900/40 border-t-ink-900" />
                Drawing the comic…
              </span>
            ) : (
              'Generate comic'
            )}
          </button>
          {comicError && <p className="text-[11px] text-red-300">{comicError}</p>}
        </div>
      )}

      {meeting.summary && (
        <p className="text-[13px] leading-relaxed text-ink-200">
          {meeting.summary}
        </p>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="self-start text-[11px] text-brand-400"
      >
        {expanded ? '↑ Hide transcript' : '↓ Show transcript & decisions'}
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 rounded-md border border-ink-700/60 bg-ink-900/40 p-3">
          {decisions.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                Decisions
              </p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-[12px] text-ink-200">
                {decisions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
              Transcript
            </p>
            <ol className="mt-1 flex flex-col gap-2">
              {transcript.map((t, i) => (
                <li key={i} className="text-[12px] leading-snug">
                  <span className="mr-1.5 font-semibold text-brand-300">
                    {roleLabel(t.role)}:
                  </span>
                  <span className="text-ink-200">{t.text}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </article>
  );
}

// Image renderer with two reliability fixes for large data: URLs
// (which our comics currently are, ~2-3MB):
//
//   1. onError retry — iOS Safari occasionally fails to decode a
//      freshly-arrived data URL on first paint (RSC stream timing,
//      React hydration weirdness, big-payload races). A single
//      retry by remounting the <img> usually fixes it without the
//      user having to refresh the page.
//
//   2. The image lives inside an <a href download> so native
//      long-press / right-click "Save Image" works on every browser.
//      The explicit Save button below is a supplementary path for
//      iOS's Photos save (via Web Share).
function ComicImage({ src, filename }: { src: string; filename: string }) {
  const [errored, setErrored] = useState(false);
  const [attempt, setAttempt] = useState(0);

  if (errored) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-[11px]">
        <div className="min-w-0">
          <p className="font-semibold text-amber-200">Comic failed to load</p>
          <p className="mt-0.5 text-amber-100/80">
            Mobile browsers sometimes choke on large inline images. Retry
            usually fixes it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setErrored(false);
            setAttempt((n) => n + 1);
          }}
          className="btn-primary shrink-0 text-[11px]"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <a
      href={src}
      download={filename}
      className="block overflow-hidden rounded-lg border border-ink-700/60 bg-ink-900/40"
      aria-label="Comic image. Long-press or right-click to save."
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={attempt}
        src={src}
        alt="Meeting comic"
        className="h-auto w-full"
        loading="lazy"
        onError={() => setErrored(true)}
      />
    </a>
  );
}

// Save / share the comic image. iOS Safari long-press-to-save is flaky
// on data: URLs (which is what we store — inline base64). This button:
//   • On mobile with Web Share API — opens the native share sheet (iOS
//     surfaces "Save Image" → Photos). Also lets Android hand off to
//     Messages / Gmail / Files / etc.
//   • Fallback: trigger a direct file download via an <a download>. Works
//     everywhere, including desktop.
function SaveComicButton({
  imageUrl,
  filename,
}: {
  imageUrl: string;
  filename: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setToast(null);
    let stage = 'fetch';
    try {
      // Step 1: pull bytes into a Blob regardless of whether the src
      // is a data: URL or a hosted URL. Unified downstream path.
      stage = 'fetch';
      const res = await fetch(imageUrl);
      if (!res.ok && imageUrl.startsWith('http')) {
        throw new Error(`fetch returned ${res.status}`);
      }
      stage = 'blob';
      const blob = await res.blob();
      // Blob.type can come back empty on data: URLs after fetch — force
      // png so the File + canShare check don't reject a typeless blob.
      stage = 'file';
      const type = blob.type || 'image/png';
      const typed = blob.type ? blob : blob.slice(0, blob.size, type);
      const file = new File([typed], filename, { type });

      // Step 2: prefer Web Share on mobile if the browser advertises
      // file-share support. iOS share sheet puts "Save Image" first.
      // canShare can return false on large payloads (~8MB+) or on
      // iOS when the call isn't in a direct user gesture — we just
      // skip to download on those paths.
      stage = 'share';
      const canShare =
        typeof navigator !== 'undefined' &&
        typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [file] });
      if (canShare) {
        try {
          await navigator.share({
            files: [file],
            title: 'AgBro meeting comic',
          });
          setToast('Opened share sheet');
          return;
        } catch (shareErr) {
          // AbortError = user cancelled. Any other share error falls
          // through to download fallback instead of surfacing to user.
          if ((shareErr as Error).name === 'AbortError') return;
        }
      }

      // Step 3: fallback download via synthetic anchor. Uses an object
      // URL so the browser honours the `download` attribute reliably
      // (some browsers ignore it on data: URLs).
      stage = 'download';
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      a.rel = 'noopener';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000);
      setToast('Downloaded');
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const msg = (err as Error).message.slice(0, 160);
      setError(`${stage} step failed: ${msg}. Long-press the image instead to save.`);
    } finally {
      setBusy(false);
      if (toast) setTimeout(() => setToast(null), 2500);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={save}
        disabled={busy}
        className={`btn-ghost text-[11px] ${busy ? 'cursor-not-allowed opacity-60' : ''}`}
      >
        {busy ? 'Saving…' : 'Save comic'}
      </button>
      {toast && <span className="text-[10px] text-brand-300">{toast}</span>}
      {error && <span className="text-[10px] text-red-300">{error}</span>}
    </div>
  );
}
