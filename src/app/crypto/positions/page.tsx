import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { fetchCryptoHoldings } from '@/lib/holdings';
import { HoldingsList, type HoldingView } from '@/components/HoldingsList';
import { formatUsd } from '@/lib/money';

export const runtime = 'nodejs';

export default async function CryptoPositionsPage() {
  const user = await requirePageUser('/crypto/positions');
  const holdings = await fetchCryptoHoldings();

  const totalMv = holdings.reduce((s, h) => s + h.marketValueCents, 0n);
  const totalPl = holdings.reduce((s, h) => s + h.unrealizedPlCents, 0n);
  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasisCents, 0n);
  const totalPlPct =
    totalCostBasis > 0n ? (Number(totalPl) / Number(totalCostBasis)) * 100 : 0;

  const view: HoldingView[] = holdings.map((h) => ({
    symbol: h.symbol,
    qty: h.qty,
    currentPrice: h.currentPrice,
    avgEntryPrice: h.avgEntryPrice,
    marketValueCents: h.marketValueCents.toString(),
    costBasisCents: h.costBasisCents.toString(),
    unrealizedPlCents: h.unrealizedPlCents.toString(),
    unrealizedPlPct: h.unrealizedPlPct,
    changeTodayCents: h.changeTodayCents.toString(),
    changeTodayPct: h.changeTodayPct,
    sparkline: h.sparkline,
  }));

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Crypto</h1>
          <p className="mt-1 text-xs text-ink-400">
            {holdings.length} {holdings.length === 1 ? 'coin' : 'coins'} · owned by {user.email}
          </p>
        </div>
        <Link href="/crypto" className="text-xs text-brand-400">
          ← Crypto
        </Link>
      </header>

      <section className="card">
        <div className="flex items-baseline justify-between">
          <div>
            <p className="stat-label">Total market value</p>
            <p className="mt-0.5 text-2xl font-semibold tabular-nums">
              {formatUsd(totalMv)}
            </p>
          </div>
          <div className="text-right">
            <p className="stat-label">Total return</p>
            <p
              className={`mt-0.5 text-sm font-semibold tabular-nums ${
                totalPl >= 0n ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {totalPl >= 0n ? '+' : ''}
              {formatUsd(totalPl)} ({totalPlPct >= 0 ? '+' : ''}
              {totalPlPct.toFixed(2)}%)
            </p>
          </div>
        </div>
      </section>

      <section className="card">
        <HoldingsList
          holdings={view}
          emptyMessage="No crypto positions yet. The DCA engine will open some on the next tick if the schedule is set."
        />
      </section>
    </div>
  );
}
