// Category callout pills under the BrainCanvas. Replaces the
// floating-around-the-brain treatment from the user's mockup with
// a tidy responsive grid that holds up on every screen size and
// taps cleanly into the existing /brain?category=X filter.
//
// Each pill: a small icon, the category label, the entry count.
// Tappable; renders as a Link. The "All" pill clears the filter.

import Link from 'next/link';
import {
  BRAIN_CATEGORIES,
  CATEGORY_LABEL,
} from '@/lib/brain/taxonomy';
import type { BrainCategory } from '@prisma/client';

export type CategoryCount = {
  // Null means "all categories combined."
  category: BrainCategory | null;
  count: number;
};

// Tiny inline SVG icons per category. Keeps the component
// self-contained — no external icon dep, no font, no FOUT.
function Icon({ category }: { category: BrainCategory | null }) {
  // All categories use a thin stroke-current style so they pick up
  // the surrounding text colour (active / inactive states differ
  // only in text colour).
  const base = 'h-4 w-4 shrink-0';
  switch (category) {
    case null:
      // 4 dots — "All"
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={base}>
          <circle cx="6" cy="6" r="2.2" />
          <circle cx="18" cy="6" r="2.2" />
          <circle cx="6" cy="18" r="2.2" />
          <circle cx="18" cy="18" r="2.2" />
        </svg>
      );
    case 'principle':
      // Sparkle / pin — "Principles"
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={base}>
          <path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2z" />
        </svg>
      );
    case 'playbook':
      // Open book — "Playbooks"
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={base}>
          <path d="M3 5h7v14H3z" />
          <path d="M14 5h7v14h-7z" />
          <path d="M3 5c2 1 5 1 7 0M14 5c2 1 5 1 7 0" />
        </svg>
      );
    case 'reference':
      // Document — "Reference"
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={base}>
          <path d="M6 2h9l5 5v15H6z" />
          <path d="M14 2v6h6" />
          <line x1="9" y1="13" x2="17" y2="13" />
          <line x1="9" y1="17" x2="14" y2="17" />
        </svg>
      );
    case 'memory':
      // Clock — "Memory"
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={base}>
          <circle cx="12" cy="12" r="9" />
          <polyline points="12 7 12 12 16 14" />
        </svg>
      );
    case 'hypothesis':
      // Pulse — "Hypotheses"
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={base}>
          <polyline points="3 12 8 12 10 6 14 18 16 12 21 12" />
        </svg>
      );
    case 'note':
      // Speech bubble — "Notes"
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={base}>
          <path d="M21 15a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z" />
        </svg>
      );
  }
}

export function BrainCallouts({
  counts,
  selected,
}: {
  counts: CategoryCount[];
  selected: BrainCategory | null;
}) {
  // Render order: All first, then the canonical category list. Hide
  // categories with count=0 — empty pills (e.g. "Note 0" before any
  // user-written notes exist) are visual noise on a small mobile
  // surface. "All" always shows, even on a fresh account, because
  // it's the navigation back-out.
  const allCount = counts.find((c) => c.category === null)?.count ?? 0;
  const ordered: Array<{ category: BrainCategory | null; count: number }> = [
    { category: null, count: allCount },
    ...BRAIN_CATEGORIES.flatMap((cat) => {
      const count = counts.find((c) => c.category === cat)?.count ?? 0;
      if (count === 0) return [];
      return [{ category: cat, count }];
    }),
  ];

  // Vertical stack — sized to sit beside the BrainCanvas in a
  // side-by-side row on /brain. The previous grid layout was
  // attractive on its own but doubled the page's vertical footprint
  // when paired with the brain hero above it.
  return (
    <ul className="flex flex-col gap-1.5">
      {ordered.map(({ category, count }) => {
        const isActive = category === selected;
        const label = category === null ? 'All' : CATEGORY_LABEL[category];
        const href = category === null ? '/brain' : `/brain?category=${category}`;
        return (
          <li key={category ?? 'all'}>
            <Link
              href={href}
              aria-current={isActive ? 'page' : undefined}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition ${
                isActive
                  ? 'border-brand-500/70 bg-brand-500/10 text-brand-200 shadow-[0_0_18px_rgba(74,222,128,0.18)]'
                  : 'border-ink-700/60 bg-ink-800/50 text-ink-200 hover:border-ink-600 hover:bg-ink-800'
              }`}
            >
              <span className={isActive ? 'text-brand-300' : 'text-ink-400'}>
                <Icon category={category} />
              </span>
              <span className="flex flex-1 items-baseline justify-between gap-2 truncate">
                <span className="truncate">{label}</span>
                <span
                  className={`tabular-nums ${
                    isActive ? 'text-brand-300' : 'text-ink-400'
                  }`}
                >
                  {count}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
