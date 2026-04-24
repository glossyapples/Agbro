import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { getCooldownState } from '@/lib/data/screener';
import { CandidateManager } from '@/components/CandidateManager';

export const runtime = 'nodejs';

export default async function CandidatesPage() {
  const user = await requirePageUser('/candidates');

  // B2.2: per-user candidates from UserWatchlist joined to Stock.
  const [watchlistRows, cooldown] = await Promise.all([
    prisma.userWatchlist.findMany({
      where: { userId: user.id, candidateSource: 'screener' },
      orderBy: { discoveredAt: 'desc' },
      include: { stock: true },
    }),
    getCooldownState(user.id),
  ]);

  const initial = watchlistRows.map((r) => ({
    symbol: r.stock.symbol,
    name: r.stock.name,
    sector: r.stock.sector,
    // candidateNotes lives on UserWatchlist; businessDescription stays
    // on Stock (global — Apple does the same thing for every user).
    candidateNotes: r.candidateNotes,
    businessDescription: r.stock.businessDescription,
    discoveredAt: r.discoveredAt ? r.discoveredAt.toISOString() : null,
    fundamentalsSource: r.stock.fundamentalsSource,
    fundamentalsUpdatedAt: r.stock.fundamentalsUpdatedAt
      ? r.stock.fundamentalsUpdatedAt.toISOString()
      : null,
    peRatio: r.stock.peRatio,
    dividendYield: r.stock.dividendYield,
    debtToEquity: r.stock.debtToEquity,
    returnOnEquity: r.stock.returnOnEquity,
    grossMarginPct: r.stock.grossMarginPct,
    epsTTM: r.stock.epsTTM,
    bookValuePerShare: r.stock.bookValuePerShare,
  }));

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3 pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Candidates</h1>
          <p className="text-xs text-ink-400">
            Names the agent flagged by looking beyond your watchlist. Approve
            adds to the main watchlist. Reject keeps them off the screener
            forever.
          </p>
        </div>
        <Link href="/watchlist" className="text-xs text-brand-400">
          Watchlist →
        </Link>
      </header>

      <CandidateManager initial={initial} initialCooldown={cooldown} />
    </div>
  );
}
