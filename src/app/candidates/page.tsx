import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { getCooldownState } from '@/lib/data/screener';
import { CandidateManager } from '@/components/CandidateManager';

export const runtime = 'nodejs';

export default async function CandidatesPage() {
  await requirePageUser('/candidates');

  const [stocks, cooldown] = await Promise.all([
    prisma.stock.findMany({
      where: { candidateSource: 'screener' },
      orderBy: { discoveredAt: 'desc' },
    }),
    getCooldownState(),
  ]);

  const initial = stocks.map((s) => ({
    symbol: s.symbol,
    name: s.name,
    sector: s.sector,
    candidateNotes: s.candidateNotes,
    discoveredAt: s.discoveredAt ? s.discoveredAt.toISOString() : null,
    fundamentalsSource: s.fundamentalsSource,
    fundamentalsUpdatedAt: s.fundamentalsUpdatedAt
      ? s.fundamentalsUpdatedAt.toISOString()
      : null,
    peRatio: s.peRatio,
    dividendYield: s.dividendYield,
    debtToEquity: s.debtToEquity,
    returnOnEquity: s.returnOnEquity,
    grossMarginPct: s.grossMarginPct,
    epsTTM: s.epsTTM,
    bookValuePerShare: s.bookValuePerShare,
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
