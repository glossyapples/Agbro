import Link from 'next/link';
import { prisma } from '@/lib/db';
import { maybeCurrentUser } from '@/lib/auth';
import { formatUsd, formatPct } from '@/lib/money';
import { Controls } from '@/components/Controls';
import { RunAgentButton } from '@/components/RunAgentButton';

async function getOverview() {
  const user = await maybeCurrentUser();
  if (!user || !user.account) return null;

  const [recentTrades, lastRun, activeStrategy, notifications, brainLatest, watchlistCount] =
    await Promise.all([
      prisma.trade.findMany({
        where: { userId: user.id },
        orderBy: { submittedAt: 'desc' },
        take: 5,
      }),
      prisma.agentRun.findFirst({
        where: { userId: user.id },
        orderBy: { startedAt: 'desc' },
      }),
      prisma.strategy.findFirst({ where: { userId: user.id, isActive: true } }),
      prisma.notification.count({ where: { userId: user.id, readAt: null } }),
      prisma.brainEntry.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.stock.count({ where: { onWatchlist: true } }),
    ]);

  const invested = Number(user.account.depositedCents) / 100;
  const target = invested * (1 + user.account.expectedAnnualPct / 100);

  return {
    user,
    account: user.account,
    recentTrades,
    lastRun,
    activeStrategy,
    unreadNotifications: notifications,
    brainLatest,
    watchlistCount,
    invested,
    target,
  };
}

export default async function OverviewPage() {
  const data = await getOverview();
  if (!data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Welcome to AgBro</h1>
        <p className="mt-2 text-ink-300">
          Database not seeded yet. Run <code className="text-brand-400">npm run db:seed</code>.
        </p>
      </div>
    );
  }
  const {
    account,
    recentTrades,
    lastRun,
    activeStrategy,
    unreadNotifications,
    brainLatest,
    invested,
    target,
    watchlistCount,
  } = data;

  const status = account.isStopped ? 'Stopped' : account.isPaused ? 'Paused' : 'Live';
  const statusPill =
    status === 'Live' ? 'pill-good' : status === 'Paused' ? 'pill-warn' : 'pill-bad';

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between pt-2">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-400">AgBro</p>
          <h1 className="text-2xl font-semibold text-ink-50">Warren Buffbot</h1>
        </div>
        <span className={statusPill}>{status}</span>
      </header>

      <section className="card">
        <p className="stat-label">Invested principal</p>
        <p className="stat-value">{formatUsd(account.depositedCents)}</p>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="stat-label">Target ({formatPct(account.expectedAnnualPct)} / yr)</p>
            <p className="text-lg font-semibold text-brand-400">{formatUsd(BigInt(Math.round(target * 100)))}</p>
          </div>
          <div>
            <p className="stat-label">Risk</p>
            <p className="text-lg font-semibold text-ink-100 capitalize">{account.riskTolerance}</p>
          </div>
        </div>
        <p className="mt-3 text-xs text-ink-400">
          Live portfolio value syncs from Alpaca on each agent run. Preserve-principal is goal #1.
        </p>
      </section>

      {watchlistCount === 0 && (
        <Link
          href="/watchlist"
          className="card border border-amber-500/40 bg-amber-500/10 text-sm text-amber-200"
        >
          <p className="font-semibold">Watchlist is empty</p>
          <p className="mt-1 text-xs">
            The agent has no research universe. Tap here to add tickers or load the 29
            Buffett-style starter stocks in one click.
          </p>
        </Link>
      )}

      <Controls
        isPaused={account.isPaused}
        isStopped={account.isStopped}
      />

      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-100">Active strategy</h2>
          <Link href="/strategy" className="text-xs text-brand-400">Edit →</Link>
        </div>
        <p className="mt-1 text-sm text-ink-200">{activeStrategy?.name ?? '—'}</p>
        <p className="mt-1 text-xs text-ink-400 line-clamp-3">{activeStrategy?.summary}</p>
      </section>

      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-100">Last agent run</h2>
          <RunAgentButton />
        </div>
        {lastRun ? (
          <div className="mt-2 space-y-1 text-sm">
            <p className="text-ink-200">
              {new Date(lastRun.startedAt).toLocaleString()} ·{' '}
              <span className="pill">{lastRun.status}</span>{' '}
              {lastRun.decision && <span className="pill-good">{lastRun.decision}</span>}
            </p>
            {lastRun.summary && <p className="text-xs text-ink-400 line-clamp-4">{lastRun.summary}</p>}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ink-400">No agent runs yet. Tap "Wake agent" to start.</p>
        )}
      </section>

      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-100">Recent trades</h2>
          <Link href="/trades" className="text-xs text-brand-400">All →</Link>
        </div>
        {recentTrades.length === 0 ? (
          <p className="mt-2 text-sm text-ink-400">No trades yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-ink-700/60">
            {recentTrades.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span className={t.side === 'buy' ? 'text-brand-400' : 'text-red-300'}>
                    {t.side.toUpperCase()}
                  </span>{' '}
                  {t.qty} <strong>{t.symbol}</strong>
                </span>
                <span className="text-xs text-ink-400">{t.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-100">Brain · latest</h2>
          <Link href="/brain" className="text-xs text-brand-400">Open →</Link>
        </div>
        {brainLatest ? (
          <>
            <p className="mt-1 text-sm font-medium text-ink-100">{brainLatest.title}</p>
            <p className="mt-1 text-xs text-ink-400 line-clamp-3">{brainLatest.body}</p>
          </>
        ) : (
          <p className="mt-1 text-sm text-ink-400">No entries yet.</p>
        )}
      </section>

      {unreadNotifications > 0 && (
        <p className="text-center text-xs text-brand-400">
          {unreadNotifications} unread notification{unreadNotifications === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
}
