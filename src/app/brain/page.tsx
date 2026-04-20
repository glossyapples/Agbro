import { prisma } from '@/lib/db';

const KIND_LABELS: Record<string, string> = {
  principle: 'Principle',
  weekly_update: 'Weekly',
  post_mortem: 'Post-mortem',
  lesson: 'Lesson',
  market_memo: 'Memo',
  agent_run_summary: 'Run',
};

export default async function BrainPage() {
  const entries = await prisma.brainEntry.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-semibold">Brain</h1>
        <p className="text-xs text-ink-400">
          Principles · weekly updates · post-mortems. The company gets smarter every week.
        </p>
      </header>

      {entries.length === 0 ? (
        <div className="card text-sm text-ink-300">No entries yet. After the first agent run or the weekly cron, this fills up.</div>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((e) => (
            <li key={e.id} className="card">
              <div className="flex items-center justify-between">
                <span className="pill">{KIND_LABELS[e.kind] ?? e.kind}</span>
                <span className="text-[11px] text-ink-400">{new Date(e.createdAt).toLocaleString()}</span>
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
