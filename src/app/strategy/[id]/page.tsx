import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { WizardChat } from '@/components/WizardChat';

export default async function StrategyDetail({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  const strategy = await prisma.strategy.findFirst({
    where: { id: params.id, userId: user.id },
    include: { turns: { orderBy: { createdAt: 'asc' } } },
  });
  if (!strategy) notFound();

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-xl font-semibold">{strategy.name}</h1>
        <p className="text-xs text-ink-400">
          v{strategy.version} · Buffett-fit {strategy.buffettScore}/100 ·{' '}
          {strategy.isActive ? <span className="pill-good">Active</span> : <span className="pill">Archived</span>}
        </p>
      </header>

      <section className="card">
        <h2 className="text-sm font-semibold">Summary</h2>
        <p className="mt-1 text-sm text-ink-200">{strategy.summary}</p>
        <details className="mt-3 text-xs text-ink-300">
          <summary className="cursor-pointer text-brand-400">Rules JSON</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-ink-900 p-3">
            {JSON.stringify(strategy.rules, null, 2)}
          </pre>
        </details>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-200">Strategy wizard</h2>
        <WizardChat
          strategyId={strategy.id}
          initialTurns={strategy.turns.map((t) => ({
            role: t.role as 'user' | 'agent',
            content: t.content,
            id: t.id,
          }))}
        />
      </section>
    </div>
  );
}
