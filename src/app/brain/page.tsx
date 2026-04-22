import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { isBrainSeeded, STARTER_BRAIN_SUMMARY } from '@/lib/brain/seed-brain';
import { BrainSeedButton } from '@/components/BrainSeedButton';
import { LocalTime } from '@/components/LocalTime';

const KIND_LABELS: Record<string, string> = {
  principle: 'Principle',
  checklist: 'Checklist',
  pitfall: 'Pitfall',
  sector_primer: 'Sector',
  case_study: 'Case study',
  weekly_update: 'Weekly',
  post_mortem: 'Post-mortem',
  lesson: 'Lesson',
  market_memo: 'Memo',
  agent_run_summary: 'Run',
};

const KIND_PILL_CLASS: Record<string, string> = {
  principle: 'pill-good',
  checklist: 'pill-good',
  pitfall: 'pill-warn',
  sector_primer: 'pill',
  case_study: 'pill',
};

export default async function BrainPage() {
  const user = await requirePageUser('/brain');
  const [entries, seeded] = await Promise.all([
    prisma.brainEntry.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    isBrainSeeded(user.id),
  ]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3 pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Brain</h1>
          <p className="text-xs text-ink-400">
            Principles · checklists · pitfalls · sector primers · case studies · weekly updates ·
            post-mortems. The company gets smarter every week.
          </p>
        </div>
        {seeded && <BrainSeedButton summary={STARTER_BRAIN_SUMMARY} variant="compact" />}
      </header>

      {!seeded && <BrainSeedButton summary={STARTER_BRAIN_SUMMARY} variant="empty" />}

      {entries.length === 0 ? (
        <div className="card text-sm text-ink-300">
          No entries yet. Load the starter brain above, or wait for the first agent run / weekly cron
          to start filling this.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((e) => (
            <li key={e.id} className="card">
              <div className="flex items-center justify-between">
                <span className={KIND_PILL_CLASS[e.kind] ?? 'pill'}>
                  {KIND_LABELS[e.kind] ?? e.kind}
                </span>
                <span className="text-[11px] text-ink-400">
                  <LocalTime value={e.createdAt} />
                </span>
              </div>
              <h2 className="mt-2 text-sm font-semibold">{e.title}</h2>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-200">{e.body}</pre>
              {e.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {e.tags.map((t) => (
                    <span key={t} className="pill">#{t}</span>
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
