import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { isBrainSeeded, lastSeedTimestamp, STARTER_BRAIN_SUMMARY } from '@/lib/brain/seed-brain';
import { BrainSeedButton } from '@/components/BrainSeedButton';
import { BrainCanvas } from '@/components/BrainCanvas';
import { BrainCallouts, type CategoryCount } from '@/components/BrainCallouts';
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

  const [entries, seeded, lastSyncedAt, categoryCounts, lastRun] = await Promise.all([
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
    // Drives the BrainCanvas activity-burst envelope: brain "lights
    // up" for ~5min after the agent ran.
    prisma.agentRun.findFirst({
      where: { userId: user.id },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
  ]);

  const counts = new Map<BrainCategory, number>();
  for (const row of categoryCounts) {
    counts.set(row.category, row._count._all);
  }
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);

  const calloutCounts: CategoryCount[] = [
    { category: null, count: total },
    ...BRAIN_CATEGORIES.map((c) => ({ category: c, count: counts.get(c) ?? 0 })),
  ];

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3 pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Brain</h1>
          <p className="text-xs text-ink-400">What the agent has learned.</p>
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
        <>
          {/* Side-by-side layout. The brain hero on the left stays
              just large enough (~150 px) to read as the alive
              centerpiece without dominating the page. The category
              callouts stack vertically on the right and naturally
              expand to whatever the column allows. Empty buckets
              are filtered server-side by BrainCallouts so the list
              isn't padded with "Note 0" / "Hypothesis 0" noise.

              Visual treatment per design pass: a cyan-tinted border
              + a stronger radial-emerald gradient frame the brain
              hero as its own distinct UI element. The earlier 8%
              alpha gradient barely registered; this version
              reads as "the brain sits in a pocket of the palette"
              instead of "a black blob floating on the page." */}
          <section
            className="flex items-center gap-3 rounded-2xl border border-emerald-700/40 p-3 shadow-[0_0_24px_rgba(74,222,128,0.05)]"
            style={{
              backgroundImage:
                'radial-gradient(ellipse at 30% 50%, rgba(74,222,128,0.16), rgba(20,80,60,0.05) 55%, transparent 80%)',
              backgroundColor: 'rgb(16 19 28 / 0.6)',
            }}
          >
            <div className="w-[150px] shrink-0">
              <BrainCanvas
                entryCount={total}
                lastRunAtISO={lastRun?.startedAt.toISOString() ?? null}
                heightPx={150}
              />
            </div>
            <div className="min-w-0 flex-1">
              <BrainCallouts counts={calloutCounts} selected={selectedCategory} />
            </div>
          </section>
        </>
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
