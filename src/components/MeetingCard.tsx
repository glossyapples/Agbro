'use client';

// Visual card for a single meeting in the /strategy?tab=meetings
// history list. Shows the comic (if generated), one-line summary,
// sentiment + action-item count pills, and an expandable panel for
// the full transcript.

import { useState } from 'react';
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
  const [expanded, setExpanded] = useState(false);

  const transcript =
    (meeting.transcriptJson as { transcript?: TranscriptTurn[]; decisions?: string[] } | null)
      ?.transcript ?? [];
  const decisions =
    (meeting.transcriptJson as { decisions?: string[] } | null)?.decisions ?? [];

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

      {meeting.comicUrl ? (
        <div className="overflow-hidden rounded-lg border border-ink-700/60 bg-ink-900/40">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={meeting.comicUrl}
            alt="Meeting comic"
            className="h-auto w-full"
            loading="lazy"
          />
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-ink-700/60 p-3 text-[11px] text-ink-500">
          No comic for this meeting. Save an OpenAI key in{' '}
          <a href="/settings" className="text-brand-400">
            Settings
          </a>{' '}
          to generate one on future meetings (~$0.05 each, billed to your
          OpenAI account).
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
                  <span className="mr-1.5 font-semibold capitalize text-brand-300">
                    {t.role}:
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
