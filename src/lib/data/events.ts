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
  // Omit to include all of the caller's watchlist symbols' events.
  symbol?: string;
  horizonDays?: number;
  // B2.2: per-user watchlist scoping. When omitted, falls back to
  // "any user's watchlist" — a legacy behaviour only the backtest
  // overlay-chart path needs.
  userId?: string;
};

export async function getUpcomingEvents(
  options: CalendarOptions = {}
): Promise<CalendarEvent[]> {
  const horizon = options.horizonDays ?? 14;
  const now = new Date();
  const horizonDate = new Date(now.getTime() + horizon * 86_400_000);

  // Resolve the symbol filter: explicit symbol > per-user watchlist > legacy global onWatchlist.
  let stockWhere:
    | { symbol: string }
    | { symbol: { in: string[] } }
    | { onWatchlist: true }
    | { noMatch: true };
  if (options.symbol) {
    stockWhere = { symbol: options.symbol };
  } else if (options.userId) {
    const rows = await prisma.userWatchlist.findMany({
      where: { userId: options.userId, onWatchlist: true },
      select: { symbol: true },
    });
    const symbols = rows.map((r) => r.symbol);
    stockWhere = symbols.length > 0 ? { symbol: { in: symbols } } : { noMatch: true };
  } else {
    // Legacy fallback for callers that haven't threaded userId yet.
    stockWhere = { onWatchlist: true };
  }
  // Fast-path: no matches possible → return market events only.
  if ('noMatch' in stockWhere) {
    const marketEventsOnly = await prisma.marketEvent.findMany({
      where: { occursAt: { gte: now, lte: horizonDate } },
      orderBy: { occursAt: 'asc' },
    });
    return marketEventsOnly.map((e) => ({
      kind: (e.kind as CalendarEvent['kind']) ?? 'other',
      occursAt: e.occursAt.toISOString(),
      description: e.description ?? e.kind,
    }));
  }

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
