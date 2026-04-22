import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { getCryptoPositions, getCryptoBars } from '@/lib/alpaca-crypto';
import { getBrokerAccount } from '@/lib/alpaca';
import { CryptoConfigForm } from '@/components/CryptoConfigForm';
import { CryptoPerformanceChart } from '@/components/CryptoPerformanceChart';
import { CryptoAllocationCard } from '@/components/CryptoAllocationCard';
import { formatUsd } from '@/lib/money';

export const runtime = 'nodejs';

async function loadInitialChart(userId: string) {
  // Server-side equivalent of /api/crypto/performance with range=1M, so the
  // chart paints on first byte. Mirrors the stocks-side PerformanceChart
  // loading pattern.
  const start = new Date();
  start.setMonth(start.getMonth() - 1);
  const snapshots = await prisma.cryptoBookSnapshot.findMany({
    where: { userId, takenAt: { gte: start } },
    orderBy: { takenAt: 'asc' },
    select: { takenAt: true, bookValueCents: true },
  });
  const basisValue = snapshots[0] ? Number(snapshots[0].bookValueCents) / 100 : null;
  const book = snapshots.map((s) => {
    const v = Number(s.bookValueCents) / 100;
    return {
      t: s.takenAt.getTime(),
      v,
      pct: basisValue && basisValue > 0 ? ((v - basisValue) / basisValue) * 100 : 0,
    };
  });
  let btc: Array<{ t: number; pct: number }> = [];
  if (book.length >= 2) {
    const bars = await getCryptoBars('BTC/USD', '1Day', book[0].t, book[book.length - 1].t).catch(
      () => []
    );
    const basis = bars[0]?.close ?? null;
    btc = bars.map((b) => ({
      t: b.timestampMs,
      pct: basis && basis > 0 ? ((b.close - basis) / basis) * 100 : 0,
    }));
  }
  const last = book[book.length - 1];
  const summary =
    last && basisValue != null
      ? {
          currentBookValue: last.v,
          rangePnl: last.v - basisValue,
          rangePnlPct: basisValue > 0 ? ((last.v - basisValue) / basisValue) * 100 : 0,
        }
      : null;
  return { range: '1M' as const, summary, book, btc };
}

async function loadDashboard(userId: string) {
  const [config, account, positionsRaw, chart, broker] = await Promise.all([
    prisma.cryptoConfig.findUnique({ where: { userId } }),
    prisma.account.findUnique({ where: { userId } }),
    getCryptoPositions().catch(() => []),
    loadInitialChart(userId),
    getBrokerAccount().catch(() => null),
  ]);
  const recentTrades = await prisma.trade.findMany({
    where: { userId, assetClass: 'crypto' },
    orderBy: { submittedAt: 'desc' },
    take: 10,
  });
  return { config, account, positionsRaw, recentTrades, chart, broker };
}

export default async function CryptoPage() {
  const user = await requirePageUser('/crypto');
  const { config, account, positionsRaw, recentTrades, chart, broker } = await loadDashboard(user.id);

  const cryptoEnabled = account?.cryptoEnabled === true;
  const totalValueCents = positionsRaw.reduce(
    (sum, p) => sum + Number(p.marketValueCents),
    0
  );

  const initial = {
    allowlist: config?.allowlist ?? [],
    targetAllocations:
      config?.targetAllocations && typeof config.targetAllocations === 'object'
        ? (config.targetAllocations as Record<string, number>)
        : {},
    dcaAmountUsd: config ? Number(config.dcaAmountCents) / 100 : 0,
    dcaCadenceDays: config?.dcaCadenceDays ?? 7,
    rebalanceBandPct: config?.rebalanceBandPct ?? 10,
    rebalanceCadenceDays: config?.rebalanceCadenceDays ?? 90,
    lastDcaAt: config?.lastDcaAt ? config.lastDcaAt.toISOString() : null,
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between pt-2">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-400">AgBro</p>
          <h1 className="text-2xl font-semibold text-ink-50">Crypto</h1>
          <p className="mt-1 text-xs text-ink-400">
            Rule-based DCA + allocation. No LLM reasoning — crypto is
            driven entirely by the schedule you set below.
          </p>
        </div>
        <Link href="/" className="text-xs text-brand-400">
          ← Stocks
        </Link>
      </header>

      {!cryptoEnabled && (
        <Link
          href="/settings"
          className="card border border-amber-500/40 bg-amber-500/10 text-sm text-amber-200"
        >
          <p className="font-semibold">Crypto module is off</p>
          <p className="mt-1 text-xs">
            Flip &quot;Enable crypto module&quot; in Settings to let the
            engine run. Your config below will save regardless — it just
            won&apos;t act until the master switch is on.
          </p>
        </Link>
      )}

      <CryptoPerformanceChart initial={chart} />

      <CryptoAllocationCard
        cryptoBookUsd={totalValueCents / 100}
        portfolioValueUsd={broker ? Number(broker.portfolioValueCents) / 100 : 0}
        capPct={account?.maxCryptoAllocationPct ?? 10}
      />

      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-100">Holdings</h2>
          <span className="text-xs text-ink-400">
            {formatUsd(BigInt(totalValueCents))}
          </span>
        </div>
        {positionsRaw.length === 0 ? (
          <p className="mt-2 text-sm text-ink-400">
            No crypto positions yet. The engine will open some on the next
            DCA tick once config is saved and module is enabled.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-ink-700/60">
            {positionsRaw.map((p) => {
              const pnlCents =
                Number(p.marketValueCents) -
                Number(p.avgEntryPriceCents) * p.qty;
              const pnlPct =
                Number(p.avgEntryPriceCents) > 0
                  ? (pnlCents /
                      (Number(p.avgEntryPriceCents) * p.qty)) *
                    100
                  : 0;
              return (
                <li key={p.symbol} className="flex items-center justify-between py-2 text-sm">
                  <div>
                    <p className="font-semibold text-ink-50">{p.symbol}</p>
                    <p className="text-[11px] text-ink-400">
                      {p.qty.toFixed(6)} @ avg ${(Number(p.avgEntryPriceCents) / 100).toFixed(2)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-ink-100">
                      {formatUsd(BigInt(Number(p.marketValueCents)))}
                    </p>
                    <p
                      className={`text-[11px] ${pnlCents >= 0 ? 'text-brand-400' : 'text-red-300'}`}
                    >
                      {pnlCents >= 0 ? '+' : ''}
                      {pnlPct.toFixed(1)}%
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <CryptoConfigForm initial={initial} />

      <section className="card">
        <h2 className="text-sm font-semibold text-ink-100">Recent crypto trades</h2>
        {recentTrades.length === 0 ? (
          <p className="mt-2 text-sm text-ink-400">None yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-ink-700/60">
            {recentTrades.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span className={t.side === 'buy' ? 'text-brand-400' : 'text-red-300'}>
                    {t.side.toUpperCase()}
                  </span>{' '}
                  <strong>{t.symbol}</strong>{' '}
                  <span className="text-ink-400">{t.qty.toFixed(6)}</span>
                </span>
                <span className="text-xs text-ink-400">
                  {new Date(t.submittedAt).toLocaleDateString()} · {t.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
