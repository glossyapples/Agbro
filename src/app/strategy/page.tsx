import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';

export default async function StrategyIndex() {
  const user = await requirePageUser('/strategy');
  const strategies = await prisma.strategy.findMany({
    where: { userId: user.id },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Strategy</h1>
          <p className="text-xs text-ink-400">Current + historical strategies. Compare, edit, collaborate.</p>
        </div>
      </header>

      <ul className="flex flex-col gap-3">
        {strategies.map((s) => (
          <li key={s.id} className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-ink-50">
                  {s.name} <span className="text-ink-400">v{s.version}</span>
                </p>
                <p className="text-[11px] text-ink-400">
                  Buffett-fit: {s.buffettScore}/100 · Updated {new Date(s.updatedAt).toLocaleDateString()}
                </p>
              </div>
              {s.isActive ? <span className="pill-good">Active</span> : <span className="pill">Archived</span>}
            </div>
            <p className="mt-2 text-sm text-ink-200 line-clamp-3">{s.summary}</p>
            <div className="mt-3 flex gap-2">
              <Link href={`/strategy/${s.id}`} className="btn-secondary">Open wizard</Link>
              {!s.isActive && (
                <form action={`/api/strategy/${s.id}/activate`} method="POST">
                  <button type="submit" className="btn-ghost">Activate</button>
                </form>
              )}
            </div>
          </li>
        ))}
      </ul>

      {strategies.length >= 2 && (
        <Link href="/strategy/compare" className="card text-center text-sm text-brand-400">
          Compare strategies →
        </Link>
      )}
    </div>
  );
}
