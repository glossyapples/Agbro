import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { WatchlistManager } from '@/components/WatchlistManager';

export const runtime = 'nodejs';

export default async function WatchlistPage() {
  await requirePageUser('/watchlist');

  const stocks = await prisma.stock.findMany({
    where: { onWatchlist: true },
    orderBy: [{ buffettScore: 'desc' }, { symbol: 'asc' }],
  });

  // Strip Prisma BigInt + Date types for the client boundary.
  const initial = stocks.map((s) => ({
    symbol: s.symbol,
    name: s.name,
    sector: s.sector,
    industry: s.industry,
    buffettScore: s.buffettScore,
    moatScore: s.moatScore,
    peRatio: s.peRatio,
    dividendYield: s.dividendYield,
    notes: s.notes,
    lastAnalyzedAt: s.lastAnalyzedAt ? s.lastAnalyzedAt.toISOString() : null,
    fundamentalsSource: s.fundamentalsSource,
    fundamentalsUpdatedAt: s.fundamentalsUpdatedAt ? s.fundamentalsUpdatedAt.toISOString() : null,
  }));

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Watchlist</h1>
          <p className="text-xs text-ink-400">The research universe the agent pulls from on every wake-up.</p>
        </div>
        <Link href="/strategy" className="text-xs text-brand-400">
          ← Strategy
        </Link>
      </header>

      <WatchlistManager initial={initial} />
    </div>
  );
}
