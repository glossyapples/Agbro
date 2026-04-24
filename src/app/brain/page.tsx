import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { isBrainSeeded, lastSeedTimestamp, STARTER_BRAIN_SUMMARY } from '@/lib/brain/seed-brain';
import { BrainSeedButton } from '@/components/BrainSeedButton';
import { LocalTime } from '@/components/LocalTime';
import {
  BRAIN_CATEGORIES,
  CATEGORY_LABEL,
  CATEGORY_DESCRIPTION,
  CONFIDENCE_LABEL,
} from '@/lib/brain/taxonomy';
import type { BrainCategory } from '@prisma/client';

const KIND_LABELS: Record<string, string> = {
  principle: 'Principle',
  checklist: 'Checklist',
  pitfall: 'Pitfall',
  crisis_playbook: 'Crisis',
  sector_primer: 'Sector',
  case_study: 'Case',
  weekly_update: 'Weekly',
  post_mortem: 'Post-mortem',
  lesson: 'Lesson',
  market_memo: 'Memo',
  agent_run_summary: 'Run',
  research_note: 'Research',
  hypothesis: 'Hypothesis',
  note: 'Note',
};

const CATEGORY_PILL_CLASS: Record<BrainCategory, string> = {
  principle: 'pill-good',
  playbook: 'pill-good',
  reference: 'pill',
  memory: 'pill',
  hypothesis: 'pill-warn',
  note: 'pill',
};

const CONFIDENCE_PILL_CLASS: Record<string, string> = {
  canonical: 'pill-good',
  high: 'pill-good',
  medium: 'pill',
  low: 'pill-warn',
};

function isValidCategory(v: string | undefined): v is BrainCategory {
  return v !== undefined && (BRAIN_CATEGORIES as string[]).includes(v);
}

export default async function BrainPage({
  searchParams,
}: {
  searchParams: { category?: string };
}) {
  const user = await requirePageUser('/brain');
  const selectedCategory = isValidCategory(searchParams.category)
    ? searchParams.category
    : null;

  const [entries, seeded, lastSyncedAt, categoryCounts] = await Promise.all([
    prisma.brainEntry.findMany({
      where: {
        userId: user.id,
        supersededById: null,
        ...(selectedCategory ? { category: selectedCategory } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    isBrainSeeded(user.id),
    lastSeedTimestamp(user.id),
    prisma.brainEntry.groupBy({
      by: ['category'],
      where: { userId: user.id, supersededById: null },
      _count: { _all: true },
    }),
  ]);

  const counts = new Map<BrainCategory, number>();
  for (const row of categoryCounts) {
    counts.set(row.category, row._count._all);
  }
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3 pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Brain</h1>
          <p className="text-xs text-ink-400">
            Principles · playbooks · reference material · lived memory · active hypotheses.
            The company gets smarter every week.
          </p>
          {seeded && lastSyncedAt && (
            <p className="mt-1 text-[11px] text-ink-500">
              Starter brain v{STARTER_BRAIN_SUMMARY.version} · last synced{' '}
              <LocalTime value={lastSyncedAt} format="relative" />
            </p>
          )}
        </div>
        {seeded && (
          <BrainSeedButton
            summary={STARTER_BRAIN_SUMMARY}
            variant="compact"
            lastSyncedAt={lastSyncedAt?.toISOString() ?? null}
          />
        )}
      </header>

      {!seeded && <BrainSeedButton summary={STARTER_BRAIN_SUMMARY} variant="empty" />}

      {seeded && (
        <nav className="-mb-2 flex flex-wrap items-center gap-1 text-[11px]">
          <Link
            href="/brain"
            className={`rounded-full border px-2.5 py-0.5 transition-colors ${
              !selectedCategory
                ? 'border-brand-500/60 bg-brand-500/10 text-brand-200'
                : 'border-ink-700/60 text-ink-300 hover:border-ink-500'
            }`}
          >
            All ({total})
          </Link>
          {BRAIN_CATEGORIES.map((c) => {
            const n = counts.get(c) ?? 0;
            if (n === 0) return null;
            const isActive = selectedCategory === c;
            return (
              <Link
                key={c}
                href={`/brain?category=${c}`}
                title={CATEGORY_DESCRIPTION[c]}
                className={`rounded-full border px-2.5 py-0.5 transition-colors ${
                  isActive
                    ? 'border-brand-500/60 bg-brand-500/10 text-brand-200'
                    : 'border-ink-700/60 text-ink-300 hover:border-ink-500'
                }`}
              >
                {CATEGORY_LABEL[c]} ({n})
              </Link>
            );
          })}
        </nav>
      )}

      {entries.length === 0 ? (
        <div className="card text-sm text-ink-300">
          {selectedCategory
            ? `No ${CATEGORY_LABEL[selectedCategory].toLowerCase()} entries yet.`
            : 'No entries yet. Load the starter brain above, or wait for the first agent run / weekly cron to start filling this.'}
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((e) => (
            <li key={e.id} className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={CATEGORY_PILL_CLASS[e.category] ?? 'pill'}
                    title={CATEGORY_DESCRIPTION[e.category]}
                  >
                    {CATEGORY_LABEL[e.category]}
                  </span>
                  <span className="pill text-[10px] uppercase tracking-wide text-ink-400">
                    {KIND_LABELS[e.kind] ?? e.kind}
                  </span>
                  <span className={CONFIDENCE_PILL_CLASS[e.confidence] ?? 'pill'}>
                    {CONFIDENCE_LABEL[e.confidence]}
                  </span>
                </div>
                <span className="text-[11px] text-ink-400">
                  <LocalTime value={e.createdAt} />
                </span>
              </div>
              <h2 className="mt-2 text-sm font-semibold">{e.title}</h2>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-200">
                {e.body}
              </pre>
              {(e.tags.length > 0 || e.relatedSymbols.length > 0) && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {e.relatedSymbols.map((s) => (
                    <span key={`sym-${s}`} className="pill font-mono text-brand-300">
                      ${s}
                    </span>
                  ))}
                  {e.tags.map((t) => (
                    <span key={`tag-${t}`} className="pill">
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
