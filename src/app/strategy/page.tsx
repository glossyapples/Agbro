import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { LocalTime } from '@/components/LocalTime';
import { MeetingControls } from '@/components/MeetingControls';
import { MeetingCard } from '@/components/MeetingCard';
import { ActionItemsList } from '@/components/ActionItemsList';
import { PolicyChangesList } from '@/components/PolicyChangesList';
import { BurryGuestToggle } from '@/components/BurryGuestToggle';
import { FormHypothesisButton } from '@/components/FormHypothesisButton';
import { AskBurrybotChat } from '@/components/AskBurrybotChat';
import { StrategySyncNudge } from '@/components/StrategySyncNudge';
import { missingStarterStrategySlugs } from '@/lib/brain/seed-brain';

export const dynamic = 'force-dynamic';

type Tab = 'strategy' | 'meetings' | 'backtesting';

export default async function StrategyIndex({
  searchParams,
}: {
  searchParams: { tab?: string };
}) {
  const user = await requirePageUser('/strategy');
  const tab: Tab = searchParams.tab === 'meetings'
    ? 'meetings'
    : searchParams.tab === 'backtesting'
      ? 'backtesting'
      : 'strategy';

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-semibold">Strategy</h1>
        <p className="text-xs text-ink-400">
          Current strategies, executive meetings, and historical backtests.
        </p>
      </header>

      <Tabs active={tab} />

      {tab === 'strategy' && <StrategyTab userId={user.id} />}
      {tab === 'meetings' && <MeetingsTab userId={user.id} />}
      {tab === 'backtesting' && <BacktestingTab />}
    </div>
  );
}

function Tabs({ active }: { active: Tab }) {
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'strategy', label: 'Strategy' },
    { key: 'meetings', label: 'Meetings' },
    { key: 'backtesting', label: 'Back-testing' },
  ];
  return (
    <nav className="flex gap-1 border-b border-ink-700/60">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={`/strategy${t.key === 'strategy' ? '' : `?tab=${t.key}`}`}
            className={`relative px-3 py-2 text-sm transition-colors ${
              isActive ? 'text-ink-50' : 'text-ink-400 hover:text-ink-200'
            }`}
          >
            {t.label}
            {isActive && (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-brand-400" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

async function StrategyTab({ userId }: { userId: string }) {
  const [strategies, missingSlugs] = await Promise.all([
    prisma.strategy.findMany({
      where: { userId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    }),
    missingStarterStrategySlugs(userId),
  ]);
  // One DB round-trip to learn which strategies have already had a
  // Burrybot first-research session run — used to hide the button on
  // completed cards. Groups by the `onboard-<strategyId>` tag that
  // formBurryHypotheses stamps on every entry it writes.
  const onboardedTags = await prisma.brainEntry.findMany({
    where: {
      userId,
      tags: { hasSome: strategies.map((s) => `onboard-${s.id}`) },
    },
    select: { tags: true },
  });
  const onboardedStrategyIds = new Set<string>();
  // Per-strategy hypothesis counts so the card can link to /brain
  // with a count badge when Burrybot has written something — both
  // self-tests the write (if the link appears, entries exist) and
  // solves the "where are my hypotheses?" discoverability gap.
  const hypothesisCountByStrategyId = new Map<string, number>();
  for (const row of onboardedTags) {
    for (const t of row.tags) {
      if (t.startsWith('onboard-')) {
        const sid = t.slice('onboard-'.length);
        onboardedStrategyIds.add(sid);
        hypothesisCountByStrategyId.set(
          sid,
          (hypothesisCountByStrategyId.get(sid) ?? 0) + 1
        );
      }
    }
  }
  return (
    <>
      <StrategySyncNudge missingSlugs={missingSlugs} />

      {/* Quick actions — moved up from the bottom of the page where they
          were below all 6 strategy cards and easy to miss. Two utility
          actions that operate ACROSS strategies, not on any one of
          them, so they belong at the top, above the per-strategy list.
          Compare is conditional on having ≥2 strategies (no point
          otherwise); watchlist is always shown. */}
      <div className="flex flex-wrap gap-2">
        {strategies.length >= 2 && (
          <Link
            href="/strategy/compare"
            className="flex flex-1 items-center justify-center gap-2 rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-xs font-medium text-ink-100 transition hover:bg-ink-700"
          >
            <span aria-hidden>↔</span> Compare strategies
          </Link>
        )}
        <Link
          href="/watchlist"
          className="flex flex-1 items-center justify-center gap-2 rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-xs font-medium text-ink-100 transition hover:bg-ink-700"
        >
          <span aria-hidden>☆</span> Manage watchlist
        </Link>
      </div>

      <ul className="flex flex-col gap-3">
        {strategies.map((s) => (
          <li key={s.id} className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-ink-50">
                  {s.name} <span className="text-ink-400">v{s.version}</span>
                </p>
                <p className="text-[11px] text-ink-400">
                  Buffett-fit: {s.buffettScore}/100 · Updated{' '}
                  <LocalTime value={s.updatedAt} format="date" />
                </p>
              </div>
              {s.isActive ? (
                <span className="pill-good">Active</span>
              ) : (
                <span className="pill">Archived</span>
              )}
            </div>
            <p className="mt-2 text-sm text-ink-200 line-clamp-3">{s.summary}</p>
            <div className="mt-3 flex gap-2">
              <Link href={`/strategy/${s.id}`} className="btn-secondary">
                Open wizard
              </Link>
              {!s.isActive && (
                <form action={`/api/strategy/${s.id}/activate`} method="POST">
                  <button type="submit" className="btn-ghost">
                    Activate
                  </button>
                </form>
              )}
            </div>
            <BurryGuestToggle
              strategyId={s.id}
              isBurryFirm={s.presetKey === 'burry_deep_research'}
              initial={s.allowBurryGuest}
            />
            {(s.allowBurryGuest ||
              s.presetKey === 'burry_deep_research') && (
              <>
                <FormHypothesisButton
                  strategyId={s.id}
                  strategyName={s.name}
                  alreadyFormed={onboardedStrategyIds.has(s.id)}
                />
                {(hypothesisCountByStrategyId.get(s.id) ?? 0) > 0 && (
                  <Link
                    href="/brain?category=hypothesis"
                    className="mt-1 self-start text-[11px] text-brand-400 hover:underline"
                  >
                    View {hypothesisCountByStrategyId.get(s.id)} Burrybot
                    {(hypothesisCountByStrategyId.get(s.id) ?? 0) === 1
                      ? ' hypothesis'
                      : ' hypotheses'}{' '}
                    →
                  </Link>
                )}
                <AskBurrybotChat
                  strategyId={s.id}
                  strategyName={s.name}
                />
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

async function MeetingsTab({ userId }: { userId: string }) {
  const [meetings, openItems, proposedChanges, account] = await Promise.all([
    prisma.meeting.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      take: 20,
      include: {
        actionItems: {
          orderBy: { createdAt: 'desc' },
        },
      },
    }),
    prisma.meetingActionItem.findMany({
      where: { userId, status: { in: ['started', 'on_hold', 'blocked'] } },
      orderBy: { createdAt: 'desc' },
      include: {
        meeting: {
          select: { id: true, startedAt: true, kind: true },
        },
      },
      take: 30,
    }),
    prisma.policyChange.findMany({
      where: { userId, status: 'proposed' },
      orderBy: { createdAt: 'desc' },
      include: {
        meeting: { select: { startedAt: true } },
      },
      take: 20,
    }),
    prisma.account.findUnique({
      where: { userId },
      select: { allowAgentPolicyProposals: true },
    }),
  ]);

  const serializedProposed = proposedChanges.map((p) => ({
    id: p.id,
    kind: p.kind,
    targetKey: p.targetKey,
    before: p.before,
    after: p.after,
    rationale: p.rationale,
    createdAt: p.createdAt.toISOString(),
    meetingAt: p.meeting.startedAt.toISOString(),
  }));

  // Serialize for client components (Date → string, Buffer → string).
  const serializedItems = openItems.map((i) => ({
    id: i.id,
    kind: i.kind,
    description: i.description,
    status: i.status,
    createdAt: i.createdAt.toISOString(),
    meetingId: i.meeting.id,
    meetingAt: i.meeting.startedAt.toISOString(),
  }));

  const serializedMeetings = meetings.map((m) => ({
    id: m.id,
    kind: m.kind,
    status: m.status,
    startedAt: m.startedAt.toISOString(),
    completedAt: m.completedAt?.toISOString() ?? null,
    summary: m.summary,
    comicUrl: m.comicUrl,
    comicError: m.comicError,
    costUsd: m.costUsd,
    errorMessage: m.errorMessage,
    transcriptJson: m.transcriptJson,
    actionItemCount: m.actionItems.length,
    sentiment:
      (m.transcriptJson as { sentiment?: string } | null)?.sentiment ?? null,
  }));

  return (
    <>
      <MeetingControls />

      {/* Comics + summaries first — it's the thing a user opens the
          tab to look at. Policy changes + action items live below so
          scanning the firm's narrative isn't interrupted by chores. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">History</h2>
        {serializedMeetings.length === 0 ? (
          <p className="card text-center text-sm text-ink-400">
            No meetings yet. Run an impromptu one above — or wait for the next
            scheduled weekly meeting.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {serializedMeetings.map((m) => (
              <li key={m.id}>
                <MeetingCard meeting={m} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <PolicyChangesList
        proposed={serializedProposed}
        allowProposals={account?.allowAgentPolicyProposals ?? true}
      />

      <section className="card flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">Action items</h2>
          <p className="mt-0.5 text-[11px] text-ink-400">
            Open items from recent meetings. Research items can be forced to
            execute on the agent&apos;s next wake.
          </p>
        </div>
        <ActionItemsList items={serializedItems} />
      </section>
    </>
  );
}

function BacktestingTab() {
  return (
    <section className="card flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">Back-testing</h2>
        <p className="mt-0.5 text-[11px] text-ink-400">
          Historical strategy simulations — see how each preset would have
          performed across real market windows.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Link
          href="/backtest"
          className="card border border-ink-700/60 p-3 text-sm text-ink-100 transition-colors hover:border-brand-500/50"
        >
          <p className="font-semibold">Single run</p>
          <p className="mt-1 text-[11px] text-ink-400">
            Pick a strategy + date range + universe. Classic or
            fundamentals-aware mode.
          </p>
          <p className="mt-2 text-[11px] text-brand-400">Open →</p>
        </Link>
        <Link
          href="/backtest/grid"
          className="card border border-ink-700/60 p-3 text-sm text-ink-100 transition-colors hover:border-brand-500/50"
        >
          <p className="font-semibold">Robustness grid</p>
          <p className="mt-1 text-[11px] text-ink-400">
            Every strategy × every historical window. Overlay chart
            included. Guards against curve-fitting with held-out windows.
          </p>
          <p className="mt-2 text-[11px] text-brand-400">Open →</p>
        </Link>
        <Link
          href="/backtest/walk-forward"
          className="card border border-brand-500/40 bg-brand-500/5 p-3 text-sm text-ink-100 transition-colors hover:border-brand-500/70 sm:col-span-2"
        >
          <p className="font-semibold">
            Walk-forward
            <span className="ml-2 rounded-sm bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-300">
              new
            </span>
          </p>
          <p className="mt-1 text-[11px] text-ink-400">
            Rolling out-of-sample validation. Slides a fixed-length
            window across long history, runs each slice fresh, returns
            a consistency score. The "compare all six presets" tab
            ranks every preset by edge — answers <em>does this strategy
            actually work, or does it only look good in one window?</em>
          </p>
          <p className="mt-2 text-[11px] text-brand-400">Open →</p>
        </Link>
      </div>
    </section>
  );
}
