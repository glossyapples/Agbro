// Compact card listing the next few calendar events so the user can see at
// a glance when earnings, FOMC, or market closures are coming up. Shares the
// same getUpcomingEvents helper the agent uses — one source of truth.

import type { CalendarEvent } from '@/lib/data/events';

const KIND_LABEL: Record<CalendarEvent['kind'], string> = {
  earnings: 'Earnings',
  fomc: 'FOMC',
  cpi: 'CPI',
  market_closed: 'Market closed',
  market_early_close: 'Early close',
  other: 'Event',
};

const KIND_PILL: Record<CalendarEvent['kind'], string> = {
  earnings: 'pill-warn',
  fomc: 'pill',
  cpi: 'pill',
  market_closed: 'pill-bad',
  market_early_close: 'pill-warn',
  other: 'pill',
};

function daysAway(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const days = Math.round(diff / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days}d`;
}

export function UpcomingEventsCard({ events }: { events: CalendarEvent[] }) {
  if (events.length === 0) {
    // Empty state is informational — don't hide the card, it's part of the
    // user's mental model that the agent is calendar-aware.
    return (
      <section className="card">
        <h2 className="text-sm font-semibold text-ink-100">Upcoming events</h2>
        <p className="mt-1 text-xs text-ink-400">
          No scheduled earnings or FOMC meetings in the next two weeks. The
          agent refreshes earnings dates weekly.
        </p>
      </section>
    );
  }
  return (
    <section className="card">
      <h2 className="text-sm font-semibold text-ink-100">Upcoming events</h2>
      <p className="mt-1 text-[11px] text-ink-400">
        Agent blocks buys within 3 days of earnings. Sells/trims are always allowed.
      </p>
      <ul className="mt-2 divide-y divide-ink-700/60">
        {events.slice(0, 6).map((e, i) => (
          <li key={`${e.occursAt}-${i}`} className="flex items-center justify-between py-2 text-sm">
            <div className="flex items-center gap-2">
              <span className={`${KIND_PILL[e.kind]} text-[10px]`}>{KIND_LABEL[e.kind]}</span>
              <span className="text-ink-200">{e.description}</span>
            </div>
            <span className="text-xs text-ink-400">{daysAway(e.occursAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
