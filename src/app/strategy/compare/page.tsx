import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { diffRules, formatRuleValue } from '@/lib/strategy-diff';

export const runtime = 'nodejs';

export default async function StrategyComparePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const user = await requirePageUser('/strategy/compare');
  const rawA = typeof searchParams.a === 'string' ? searchParams.a : undefined;
  const rawB = typeof searchParams.b === 'string' ? searchParams.b : undefined;

  const strategies = await prisma.strategy.findMany({
    where: { userId: user.id },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, name: true, version: true, isActive: true, summary: true, rules: true, buffettScore: true },
  });

  const a = rawA ? strategies.find((s) => s.id === rawA) : strategies[0];
  const b = rawB ? strategies.find((s) => s.id === rawB) : strategies[1];

  if (strategies.length < 2) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <header className="pt-2">
          <h1 className="text-2xl font-semibold">Compare strategies</h1>
        </header>
        <p className="card text-sm text-ink-300">
          You need at least two strategies to compare. Create another from the{' '}
          <Link href="/strategy" className="text-brand-400 underline">
            strategy page
          </Link>
          .
        </p>
      </div>
    );
  }

  const rows = diffRules(
    (a?.rules ?? {}) as Record<string, unknown>,
    (b?.rules ?? {}) as Record<string, unknown>
  );
  const changedCount = rows.filter((r) => r.changed).length;

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-baseline justify-between pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Compare strategies</h1>
          <p className="text-xs text-ink-400">
            {changedCount} field{changedCount === 1 ? '' : 's'} differ
          </p>
        </div>
        <Link href="/strategy" className="text-xs text-brand-400">
          ← Back
        </Link>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <StrategyPicker label="A" strategies={strategies} current={a?.id} otherParam="b" otherId={b?.id} paramName="a" />
        <StrategyPicker label="B" strategies={strategies} current={b?.id} otherParam="a" otherId={a?.id} paramName="b" />
      </section>

      <section className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-ink-700/60">
              <th className="py-2 pr-3 font-semibold text-ink-300">Rule</th>
              <th className="py-2 pr-3 font-semibold text-ink-300">{a?.name} v{a?.version}</th>
              <th className="py-2 font-semibold text-ink-300">{b?.name} v{b?.version}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className={`border-b border-ink-800/60 ${r.changed ? 'bg-brand-400/5' : ''}`}
              >
                <td className="py-2 pr-3 font-mono text-[11px] text-ink-400">{r.key}</td>
                <td className={`py-2 pr-3 ${r.changed ? 'text-brand-300' : 'text-ink-200'}`}>
                  {formatRuleValue(r.a)}
                </td>
                <td className={`py-2 ${r.changed ? 'text-brand-300' : 'text-ink-200'}`}>
                  {formatRuleValue(r.b)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function StrategyPicker({
  label,
  strategies,
  current,
  otherId,
  paramName,
  otherParam,
}: {
  label: string;
  strategies: Array<{ id: string; name: string; version: number; isActive: boolean; buffettScore: number }>;
  current: string | undefined;
  otherId: string | undefined;
  paramName: string;
  otherParam: string;
}) {
  const currentRow = strategies.find((s) => s.id === current);
  return (
    <div className="card">
      <p className="stat-label">Strategy {label}</p>
      <p className="mt-1 text-sm font-semibold text-ink-100">
        {currentRow?.name ?? '—'} v{currentRow?.version ?? '?'}
      </p>
      <p className="mt-1 text-xs text-ink-400">Buffett score {currentRow?.buffettScore ?? 0}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {strategies.map((s) => {
          const query = new URLSearchParams();
          query.set(paramName, s.id);
          if (otherId) query.set(otherParam, otherId);
          const active = s.id === current;
          return (
            <Link
              key={s.id}
              href={`/strategy/compare?${query.toString()}`}
              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                active ? 'border-brand-400 bg-brand-400/10 text-brand-300' : 'border-ink-700 text-ink-400'
              }`}
            >
              {s.name} v{s.version}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
