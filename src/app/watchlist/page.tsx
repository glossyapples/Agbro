import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { WatchlistManager } from '@/components/WatchlistManager';

export const runtime = 'nodejs';

export default async function WatchlistPage() {
  const user = await requirePageUser('/watchlist');

  // B2.2: per-user reads from UserWatchlist joined to Stock.
  const [watchlistRows, candidateCount] = await Promise.all([
    prisma.userWatchlist.findMany({
      where: { userId: user.id, onWatchlist: true },
      include: { stock: true },
    }),
    prisma.userWatchlist.count({
      where: { userId: user.id, candidateSource: 'screener' },
    }),
  ]);
  const stocks = watchlistRows
    .map((r) => r.stock)
    .sort((a, b) => {
      const bs = (b.buffettScore ?? -1) - (a.buffettScore ?? -1);
      return bs !== 0 ? bs : a.symbol.localeCompare(b.symbol);
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

      <Link
        href="/candidates"
        className={`card text-center text-sm ${
          candidateCount > 0
            ? 'border border-brand-500/40 bg-brand-500/5 text-brand-300'
            : 'text-brand-400'
        }`}
      >
        {candidateCount > 0
          ? `${candidateCount} candidate${candidateCount === 1 ? '' : 's'} pending review →`
          : 'Candidates (screener finds new names) →'}
      </Link>

      <WatchlistManager initial={initial} />
    </div>
  );
}
