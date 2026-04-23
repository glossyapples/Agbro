'use client';

// Mood ring — two side-by-side cards showing at-a-glance state of
// the market and the user's agent. Click either card to expand into
// a plain-English explanation of why we picked that mood.
//
// Design goals:
//   - Experienced traders recognise "greedy / fearful / patient" instantly
//   - Brand-new users learn the vocabulary by hovering / tapping
//   - No external data — entirely derived from data we already compute
//     (MarketRegime table + last N AgentRun rows)
//   - Visual accent: a gradient-filled ring shifts color per mood, the
//     classic mood-ring effect, but rendered as a clean SVG disc that
//     reads well in dark mode

import { useState } from 'react';
import type { Mood } from '@/lib/mood';

export function MoodStrip({
  marketMood,
  agentMood,
}: {
  marketMood: Mood;
  agentMood: Mood;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <MoodCard title="Market" mood={marketMood} />
      <MoodCard title="Your agent" mood={agentMood} />
    </div>
  );
}

function MoodCard({ title, mood }: { title: string; mood: Mood }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className="card flex flex-col items-start gap-2 text-left transition-colors hover:border-ink-600"
      aria-expanded={expanded}
    >
      <div className="flex w-full items-start gap-3">
        <MoodRing mood={mood} />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-[0.15em] text-ink-400">
            {title}
          </p>
          <p className={`mt-0.5 text-base font-semibold ${mood.textClass}`}>
            {mood.label}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-ink-400">
            {mood.description}
          </p>
        </div>
      </div>
      {expanded && (
        <div className="mt-1 w-full rounded-md border border-ink-700/50 bg-ink-900/40 p-2.5 text-[11px] leading-relaxed text-ink-300">
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-ink-500">
            Why this mood
          </p>
          {mood.detail}
        </div>
      )}
      <p className="text-[9px] text-ink-500">
        Tap to {expanded ? 'hide' : 'see why'}
      </p>
    </button>
  );
}

function MoodRing({ mood }: { mood: Mood }) {
  // Gradient-filled circle with the emoji centered — the classic
  // mood-ring look. Using a Tailwind gradient on a div works because
  // mood.ringClass is a literal template like 'from-red-400 to-red-700'
  // defined in mood.ts, so Tailwind's JIT picks up the classes from
  // the source file at build time.
  return (
    <div className="relative shrink-0">
      <div
        className={`h-14 w-14 rounded-full bg-gradient-to-br shadow-[inset_0_1px_2px_rgba(255,255,255,0.2),0_2px_8px_rgba(0,0,0,0.35)] ring-1 ring-white/10 ${mood.ringClass}`}
      />
      <span
        className="pointer-events-none absolute inset-0 flex items-center justify-center text-2xl"
        aria-hidden="true"
      >
        {mood.emoji}
      </span>
    </div>
  );
}
