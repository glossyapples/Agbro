import Link from 'next/link';
import { prisma } from '@/lib/db';
import { maybeCurrentUser } from '@/lib/auth';
import { formatUsd, formatPct } from '@/lib/money';
import { Controls } from '@/components/Controls';
import { RunAgentButton } from '@/components/RunAgentButton';
import { PerformanceChart } from '@/components/PerformanceChart';
import { UpcomingEventsCard } from '@/components/UpcomingEventsCard';
import { getPortfolioHistory, getBars } from '@/lib/alpaca';
import { getUpcomingEvents } from '@/lib/data/events';

// Server-side fetch of the initial chart payload so the hero card paints
// on first byte — no loading spinner on page load. Default range is 1M,
// which gives a natural first-day view (mostly empty → fills as the agent
// trades). Alpaca failures degrade to an empty payload; the component
// handles that with a "waiting for data" state.
async function getInitialChartPayload() {
  try {
    const portfolio = await getPortfolioHistory('1M').catch(() => []);
    if (portfolio.length === 0) {
      return { range: '1M' as const, summary: null, portfolio: [], spy: [] };
    }
    const basis = portfolio[0].equity;
    const portfolioSeries = portfolio.map((p) => ({
      t: p.timestampMs,
      v: p.equity,
      pct: basis > 0 ? ((p.equity - basis) / basis) * 100 : 0,
    }));
    const startMs = portfolio[0].timestampMs;
    const endMs = portfolio[portfolio.length - 1].timestampMs;
    const bars = await getBars('SPY', '1Hour', startMs, endMs).catch(() => []);
    const spyBasis = bars[0]?.close ?? null;
    const spySeries = bars.map((b) => ({
      t: b.timestampMs,
      pct: spyBasis && spyBasis > 0 ? ((b.close - spyBasis) / spyBasis) * 100 : 0,
    }));
    const last = portfolio[portfolio.length - 1];
    return {
      range: '1M' as const,
      summary: {
        currentEquity: last.equity,
        rangePnl: last.equity - basis,
        rangePnlPct: basis > 0 ? ((last.equity - basis) / basis) * 100 : 0,
        spyPnlPct: spySeries[spySeries.length - 1]?.pct ?? null,
      },
      portfolio: portfolioSeries,
      spy: spySeries,
    };
  } catch {
    return { range: '1M' as const, summary: null, portfolio: [], spy: [] };
  }
}

async function getOverview() {
  const user = await maybeCurrentUser();
  if (!user || !user.account) return null;

  const [recentTrades, lastRun, activeStrategy, notifications, brainLatest, watchlistCount, candidateCount, chart, upcomingEvents] =
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
      prisma.stock.count({ where: { candidateSource: 'screener' } }),
      getInitialChartPayload(),
      getUpcomingEvents({ horizonDays: 14 }),
    ]);

  // Numeric target (invested principal × (1 + expectedAnnualPct / 100)) for
  // the scalar row next to the chart.
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
    candidateCount,
    target,
    chart,
    upcomingEvents,
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
    target,
    watchlistCount,
    candidateCount,
    chart,
    upcomingEvents,
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

      <PerformanceChart initial={chart} />

      <section className="card">
        <div className="flex items-center justify-between">
          <div className="grid flex-1 grid-cols-3 gap-3 text-sm">
          <div>
            <p className="stat-label">Principal</p>
            <p className="text-lg font-semibold text-ink-50">{formatUsd(account.depositedCents)}</p>
          </div>
          <div>
            <p className="stat-label">Target ({formatPct(account.expectedAnnualPct)}/yr)</p>
            <p className="text-lg font-semibold text-brand-400">{formatUsd(BigInt(Math.round(target * 100)))}</p>
          </div>
          <div>
            <p className="stat-label">Risk</p>
            <p className="text-lg font-semibold capitalize text-ink-100">{account.riskTolerance}</p>
          </div>
          </div>
          <Link href="/wallet" className="ml-3 text-xs text-brand-400">
            Wallet →
          </Link>
        </div>
      </section>

      <UpcomingEventsCard events={upcomingEvents} />

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

      {candidateCount > 0 && (
        <Link
          href="/candidates"
          className="card border border-brand-500/40 bg-brand-500/5 text-sm text-brand-300"
        >
          <p className="font-semibold">
            {candidateCount} candidate{candidateCount === 1 ? '' : 's'} pending review
          </p>
          <p className="mt-1 text-xs text-ink-300">
            The screener found new names outside your watchlist. Tap to approve or reject.
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
        <p className="mt-1 text-[11px] text-ink-400">
          Auto-wakes every {account.agentCadenceMinutes} min between{' '}
          {account.tradingHoursStart} and {account.tradingHoursEnd} ET on weekdays.
        </p>
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
