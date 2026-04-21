// Event calendar aggregator. Combines per-symbol events (earnings) and
// market-wide events (FOMC, market closures) into a single time-ordered
// list. Used by the agent's get_event_calendar tool and the home-page
// upcoming-events card.

import { prisma } from '@/lib/db';

export type CalendarEvent = {
  kind: 'earnings' | 'fomc' | 'cpi' | 'market_closed' | 'market_early_close' | 'other';
  occursAt: string; // ISO
  symbol?: string; // only for per-symbol events
  description: string;
};

export type CalendarOptions = {
  // Only include events for this specific symbol + market-wide events.
  // Omit to include all watchlist symbols' events.
  symbol?: string;
  horizonDays?: number;
};

export async function getUpcomingEvents(
  options: CalendarOptions = {}
): Promise<CalendarEvent[]> {
  const horizon = options.horizonDays ?? 14;
  const now = new Date();
  const horizonDate = new Date(now.getTime() + horizon * 86_400_000);

  const stockWhere = options.symbol
    ? { symbol: options.symbol }
    : { onWatchlist: true };

  const [stocks, marketEvents] = await Promise.all([
    prisma.stock.findMany({
      where: {
        ...stockWhere,
        nextEarningsAt: { gte: now, lte: horizonDate },
      },
      select: { symbol: true, nextEarningsAt: true, name: true },
      orderBy: { nextEarningsAt: 'asc' },
    }),
    prisma.marketEvent.findMany({
      where: { occursAt: { gte: now, lte: horizonDate } },
      orderBy: { occursAt: 'asc' },
    }),
  ]);

  const events: CalendarEvent[] = [];
  for (const s of stocks) {
    if (!s.nextEarningsAt) continue;
    events.push({
      kind: 'earnings',
      occursAt: s.nextEarningsAt.toISOString(),
      symbol: s.symbol,
      description: `${s.symbol} earnings${s.name && s.name !== s.symbol ? ` (${s.name})` : ''}`,
    });
  }
  for (const m of marketEvents) {
    events.push({
      kind: m.kind as CalendarEvent['kind'],
      occursAt: m.occursAt.toISOString(),
      description: m.description,
    });
  }

  events.sort((a, b) => a.occursAt.localeCompare(b.occursAt));
  return events;
}
