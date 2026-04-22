import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { formatPct, formatUsd } from '@/lib/money';
import { LocalTime } from '@/components/LocalTime';

export default async function TradesPage() {
  const user = await requirePageUser('/trades');
  const trades = await prisma.trade.findMany({
    where: { userId: user.id },
    orderBy: { submittedAt: 'desc' },
    take: 200,
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-semibold">Trade log</h1>
        <p className="text-xs text-ink-400">Every order AgBro has placed, with the thesis behind it.</p>
      </header>

      {trades.length === 0 ? (
        <div className="card text-sm text-ink-300">No trades yet.</div>
      ) : (
        <ul className="flex flex-col gap-3">
          {trades.map((t) => (
            <li key={t.id} className="card">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">
                  <span className={t.side === 'buy' ? 'text-brand-400' : 'text-red-300'}>
                    {t.side.toUpperCase()}
                  </span>{' '}
                  {t.qty} <span className="text-ink-50">{t.symbol}</span>
                </p>
                <span className="pill">{t.status}</span>
              </div>
              <p className="mt-1 text-[11px] text-ink-400">
                <LocalTime value={t.submittedAt} /> ·{' '}
                {t.fillPriceCents ? `Filled @ ${formatUsd(t.fillPriceCents)}` : 'Pending fill'}
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <p className="stat-label">Confidence</p>
                  <p className="font-semibold text-ink-100">
                    {t.confidence != null ? `${(t.confidence * 100).toFixed(0)}%` : '—'}
                  </p>
                </div>
                <div>
                  <p className="stat-label">Margin of safety</p>
                  <p className="font-semibold text-ink-100">{formatPct(t.marginOfSafetyPct)}</p>
                </div>
                <div>
                  <p className="stat-label">Intrinsic</p>
                  <p className="font-semibold text-ink-100">{formatUsd(t.intrinsicValuePerShareCents)}</p>
                </div>
              </div>
              <details className="mt-3 text-xs text-ink-200">
                <summary className="cursor-pointer text-brand-400">Thesis / Bull / Bear</summary>
                <p className="mt-2"><strong>Thesis:</strong> {t.thesis}</p>
                <p className="mt-2 text-brand-300"><strong>Bull:</strong> {t.bullCase}</p>
                <p className="mt-1 text-red-300"><strong>Bear:</strong> {t.bearCase}</p>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
