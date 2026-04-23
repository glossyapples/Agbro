import Link from 'next/link';
import { prisma } from '@/lib/db';
import { maybeCurrentUser } from '@/lib/auth';
import { formatUsd, formatPct } from '@/lib/money';
import { Controls } from '@/components/Controls';
import { RunAgentButton } from '@/components/RunAgentButton';
import { PerformanceChart } from '@/components/PerformanceChart';
import { UpcomingEventsCard } from '@/components/UpcomingEventsCard';
import { LocalTime } from '@/components/LocalTime';
import { MoodStrip } from '@/components/MoodStrip';
import { getPortfolioHistory, getBars } from '@/lib/alpaca';
import { getUpcomingEvents } from '@/lib/data/events';
import {
  classifyMarketMood,
  classifyAgentMood,
  type MarketMoodInput,
  type AgentMoodInput,
} from '@/lib/mood';
import type { Regime } from '@/lib/data/regime';

// Server-side fetch of the initial chart payload so the hero card paints
// on first byte — no loading spinner on page load. Default range is 1M,
// which gives a natural first-day view (mostly empty → fills as the agent
// trades). Alpaca failures degrade to an empty payload; the component
// handles that with a "waiting for data" state.
async function getInitialChartPayload(userId: string) {
  try {
    const portfolio = await getPortfolioHistory('1D').catch(() => []);
    if (portfolio.length === 0) {
      return { range: '1D' as const, summary: null, portfolio: [], spy: [] };
    }
    // Subtract crypto from each point so the stocks-tab chart excludes
    // crypto book value. See /api/performance for the full rationale.
    const snapshots = await prisma.cryptoBookSnapshot.findMany({
      where: {
        userId,
        takenAt: { lte: new Date(portfolio[portfolio.length - 1].timestampMs) },
      },
      orderBy: { takenAt: 'asc' },
      select: { takenAt: true, bookValueCents: true },
    });
    const cryptoAt = (ts: number): number => {
      let latest: (typeof snapshots)[number] | null = null;
      for (const s of snapshots) {
        if (s.takenAt.getTime() <= ts) latest = s;
        else break;
      }
      return latest ? Number(latest.bookValueCents) / 100 : 0;
    };
    const stocksPortfolio = portfolio.map((p) => ({
      t: p.timestampMs,
      v: p.equity - cryptoAt(p.timestampMs),
    }));
    const basis = stocksPortfolio[0].v;
    const portfolioSeries = stocksPortfolio.map((p) => ({
      t: p.t,
      v: p.v,
      pct: basis > 0 ? ((p.v - basis) / basis) * 100 : 0,
    }));
    const startMs = portfolio[0].timestampMs;
    const endMs = portfolio[portfolio.length - 1].timestampMs;
    const bars = await getBars('SPY', '1Hour', startMs, endMs).catch(() => []);
    const spyBasis = bars[0]?.close ?? null;
    const spySeries = bars.map((b) => ({
      t: b.timestampMs,
      pct: spyBasis && spyBasis > 0 ? ((b.close - spyBasis) / spyBasis) * 100 : 0,
    }));
    const last = stocksPortfolio[stocksPortfolio.length - 1];
    return {
      range: '1D' as const,
      summary: {
        currentEquity: last.v,
        rangePnl: last.v - basis,
        rangePnlPct: basis > 0 ? ((last.v - basis) / basis) * 100 : 0,
        spyPnlPct: spySeries[spySeries.length - 1]?.pct ?? null,
      },
      portfolio: portfolioSeries,
      spy: spySeries,
    };
  } catch {
    return { range: '1D' as const, summary: null, portfolio: [], spy: [] };
  }
}

// Inputs for the home-page MoodStrip. Fetched in parallel with the
// rest of the overview so it doesn't delay first paint. All failures
// degrade gracefully — if we can't compute, classifyMarketMood and
// classifyAgentMood fall back to 'Quiet' / 'Watching' defaults.
async function getMoodInputs(userId: string): Promise<{
  market: MarketMoodInput;
  agent: AgentMoodInput;
}> {
  // Latest regime row; gives us the regime state + the daily move pct
  // recorded at the last transition.
  const latestRegime = await prisma.marketRegime
    .findFirst({ orderBy: { enteredAt: 'desc' } })
    .catch(() => null);

  // 5-day SPY change for the "greedy vs. quiet" calm-regime split.
  // Cheap — 7 daily bars from Alpaca's cached IEX feed.
  const spy5Ms = 8 * 86_400_000;
  let spy5dPct: number | null = null;
  try {
    const bars = await getBars('SPY', '1Day', Date.now() - spy5Ms, Date.now() - 20 * 60_000);
    if (bars.length >= 2) {
      const basis = bars[0].close;
      const last = bars[bars.length - 1].close;
      if (basis > 0) spy5dPct = ((last - basis) / basis) * 100;
    }
  } catch {
    // ignore — null is handled by the classifier
  }

  // Daily move from the regime row's triggers if present — otherwise
  // compute from the SPY bars we just loaded (caller bears the null).
  const spyDailyMovePct = (() => {
    const raw = latestRegime?.triggers;
    const triggers = Array.isArray(raw) ? (raw as unknown[]).map((x) => String(x)) : [];
    for (const t of triggers) {
      const m = /SPY ([+-]?\d+\.?\d*)%/.exec(t);
      if (m && m[1]) return Number(m[1]);
    }
    return null;
  })();

  // Recent agent runs for the agent mood. Grab 5 to catch short
  // patterns without over-counting ancient history.
  const recentRuns = await prisma.agentRun
    .findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: { decision: true, startedAt: true, status: true, trigger: true },
    })
    .catch(() => []);

  // Is US stock market open right now? Cheap check — we're inside
  // trading hours on a weekday. Doesn't need to be perfectly accurate;
  // the mood only differentiates "agent off duty (weekend/closed)"
  // vs. "agent should be running".
  const nowEt = new Date();
  const etDay = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(nowEt);
  const etHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    }).format(nowEt)
  );
  const isMarketOpen =
    etDay !== 'Sat' && etDay !== 'Sun' && etHour >= 9 && etHour < 16;

  return {
    market: {
      regime: (latestRegime?.regime as Regime | undefined) ?? 'calm',
      spyDailyMovePct,
      spy5dPct,
    },
    agent: {
      recentDecisions: recentRuns.map((r) => ({
        decision: r.decision,
        startedAt: r.startedAt,
        status: r.status,
      })),
      isMarketOpen,
      currentRegime: (latestRegime?.regime as Regime | undefined) ?? 'calm',
    },
  };
}

async function getOverview() {
  const user = await maybeCurrentUser();
  if (!user || !user.account) return null;

  const [recentTrades, lastRun, activeStrategy, notifications, brainLatest, watchlistCount, candidateCount, chart, upcomingEvents, moodInputs] =
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
      getInitialChartPayload(user.id),
      getUpcomingEvents({ horizonDays: 14 }),
      getMoodInputs(user.id),
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
    moodInputs,
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
    moodInputs,
  } = data;

  const status = account.isStopped ? 'Stopped' : account.isPaused ? 'Paused' : 'Live';
  const statusPill =
    status === 'Live' ? 'pill-good' : status === 'Paused' ? 'pill-warn' : 'pill-bad';

  const marketMood = classifyMarketMood(moodInputs.market);
  const agentMood = classifyAgentMood(moodInputs.agent);

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between pt-2">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-400">AgBro</p>
          <h1 className="text-2xl font-semibold text-ink-50">Warren Buffbot</h1>
        </div>
        <span className={statusPill}>{status}</span>
      </header>

      <MoodStrip marketMood={marketMood} agentMood={agentMood} />

      <PerformanceChart initial={chart} />

      <section className="card">
        <div className="mb-3 flex items-center justify-between">
          <p className="stat-label">Account</p>
          <Link href="/wallet" className="text-xs text-brand-400">
            Wallet →
          </Link>
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="min-w-0">
            <p className="stat-label">Principal</p>
            <p className="mt-0.5 truncate text-base font-semibold tabular-nums text-ink-50">
              {formatUsd(account.depositedCents)}
            </p>
          </div>
          <div className="min-w-0">
            <p className="stat-label">Target</p>
            <p className="mt-0.5 truncate text-base font-semibold tabular-nums text-brand-400">
              {formatUsd(BigInt(Math.round(target * 100)))}
            </p>
            <p className="text-[10px] text-ink-400">
              {formatPct(account.expectedAnnualPct)}/yr
            </p>
          </div>
          <div className="min-w-0">
            <p className="stat-label">Risk</p>
            <p className="mt-0.5 truncate text-base font-semibold capitalize text-ink-100">
              {account.riskTolerance}
            </p>
          </div>
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
              <LocalTime value={lastRun.startedAt} /> ·{' '}
              <span className="pill">{lastRun.status}</span>{' '}
              {lastRun.decision && <span className="pill-good">{lastRun.decision}</span>}
            </p>
            {(() => {
              // Diagnostic: compute when the next wake is due so the user
              // can verify cadence is honoured at a glance. Never show
              // a past time as "Next wake" — once the ETA passes, reframe
              // as "due now" (within one cadence cycle) or "overdue by X"
              // (past that). Saying "Next wake: 25m ago" is confusing
              // because the literal next wake, by definition, can't be
              // in the past.
              const cadenceMs = account.agentCadenceMinutes * 60_000;
              const nextWakeMs = new Date(lastRun.startedAt).getTime() + cadenceMs;
              const now = Date.now();
              const remainingMs = nextWakeMs - now;
              const overageMs = -remainingMs;
              const overdue = overageMs > cadenceMs; // more than one full cycle late
              const pastDue = remainingMs <= 0;

              function formatMs(ms: number): string {
                const mins = Math.round(ms / 60_000);
                if (mins < 1) return '<1m';
                if (mins < 60) return `${mins}m`;
                const hours = Math.floor(mins / 60);
                const rem = mins % 60;
                return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
              }

              let label: React.ReactNode;
              if (!pastDue) {
                label = (
                  <>
                    Next wake in {formatMs(remainingMs)} ·{' '}
                    <LocalTime value={nextWakeMs} />
                  </>
                );
              } else if (!overdue) {
                label = <>Due now (scheduler runs every ~2 min)</>;
              } else {
                label = <>Overdue by {formatMs(overageMs)}</>;
              }

              return (
                <p className={`text-[11px] ${overdue ? 'text-amber-300' : 'text-ink-400'}`}>
                  {label}
                  {overdue && (
                    <>
                      {' '}
                      · check <code>/api/scheduler/status</code> — if
                      tickCount isn&apos;t incrementing, the in-process
                      scheduler isn&apos;t firing.
                    </>
                  )}
                </p>
              );
            })()}
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
