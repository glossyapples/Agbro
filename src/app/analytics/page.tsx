import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { formatPct, formatUsd } from '@/lib/money';

export default async function AnalyticsPage() {
  const user = await requirePageUser('/analytics');
  const [trades, runs, positions, watchlist] = await Promise.all([
    prisma.trade.findMany({
      where: { userId: user.id },
      orderBy: { submittedAt: 'desc' },
    }),
    prisma.agentRun.findMany({
      where: { userId: user.id },
      take: 30,
      orderBy: { startedAt: 'desc' },
    }),
    prisma.position.findMany({ where: { userId: user.id } }),
    prisma.stock.findMany({ where: { onWatchlist: true }, orderBy: { buffettScore: 'desc' } }),
  ]);

  const buys = trades.filter((t) => t.side === 'buy').length;
  const sells = trades.filter((t) => t.side === 'sell').length;
  const closed = trades.filter((t) => t.closedAt);
  const wins = closed.filter((t) => (t.realizedPnlCents ?? 0n) > 0n).length;
  const losses = closed.filter((t) => (t.realizedPnlCents ?? 0n) < 0n).length;
  const totalPnlCents = closed.reduce<bigint>(
    (acc, t) => acc + (t.realizedPnlCents ?? 0n),
    0n
  );

  const runsOk = runs.filter((r) => r.status === 'completed').length;
  const runsSkipped = runs.filter((r) => r.status === 'skipped').length;
  const runsErr = runs.filter((r) => r.status === 'errored').length;

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-semibold">Analytics</h1>
        <p className="text-xs text-ink-400">Scoreboard. The brain watches these closely.</p>
      </header>

      <section className="card">
        <h2 className="text-sm font-semibold">Trading</h2>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
          <Stat label="Total trades" value={trades.length.toString()} />
          <Stat label="Buys / Sells" value={`${buys} / ${sells}`} />
          <Stat label="Closed positions" value={closed.length.toString()} />
          <Stat label="Win / Loss" value={`${wins} / ${losses}`} />
          <Stat label="Realized P/L" value={formatUsd(totalPnlCents)} />
          <Stat
            label="Target / yr"
            value={formatPct(user.account?.expectedAnnualPct)}
          />
        </div>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">Agent</h2>
        <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
          <Stat label="Completed" value={runsOk.toString()} />
          <Stat label="Skipped" value={runsSkipped.toString()} />
          <Stat label="Errored" value={runsErr.toString()} />
        </div>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">Open positions ({positions.length})</h2>
        {positions.length === 0 ? (
          <p className="mt-1 text-xs text-ink-400">None yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-ink-700/60 text-sm">
            {positions.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2">
                <span>{p.symbol} · {p.qty}</span>
                <span className="text-xs text-ink-400">avg {formatUsd(p.avgCostCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">Watchlist (top {watchlist.length})</h2>
        <ul className="mt-2 divide-y divide-ink-700/60 text-sm">
          {watchlist.slice(0, 20).map((s) => (
            <li key={s.symbol} className="flex items-center justify-between py-2">
              <div>
                <span className="font-semibold">{s.symbol}</span>{' '}
                <span className="text-ink-400">· {s.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="pill">Buffett {s.buffettScore}</span>
                <span className="pill">Moat {s.moatScore}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="stat-label">{label}</p>
      <p className="text-lg font-semibold text-ink-50">{value}</p>
    </div>
  );
}
