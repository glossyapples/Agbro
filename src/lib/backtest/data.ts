// Historical-bar loader for the backtester. Wraps the existing getBars
// helper with a tiny in-memory cache so a single backtest run doesn't
// refetch the same SPY / AAPL / etc. bars once per symbol per day.
// Cache is per-process lifetime — acceptable because backtest runs are
// rare and the per-request budget is well under the Alpaca rate limit.

import { getBars, type Bar } from '@/lib/alpaca';

const cache = new Map<string, Bar[]>();

function key(symbol: string, startMs: number, endMs: number): string {
  return `${symbol}|${startMs}|${endMs}`;
}

// Test hook — repro tests need to bust this cache between scenarios so
// a fresh getBars mock isn't shadowed by an earlier test's result.
export function _clearBarCacheForTests(): void {
  cache.clear();
}

export async function loadDailyBars(
  symbol: string,
  startMs: number,
  endMs: number
): Promise<Bar[]> {
  const k = key(symbol, startMs, endMs);
  const hit = cache.get(k);
  if (hit) return hit;
  const bars = await getBars(symbol, '1Day', startMs, endMs);
  cache.set(k, bars);
  return bars;
}

// Align a list of bars to a common calendar. Produces a map keyed by
// YYYY-MM-DD → close price, so the simulator can look up "what did AAPL
// close at on 2020-03-16" without scanning the array each day. Missing
// days (weekends, holidays, early IPO periods) just don't appear in the
// map — caller falls back to "skip this day for this symbol."
//
// Audit note: dates are formatted in America/New_York (NYSE local time)
// not UTC. NYSE daily bars are timestamped at session start (9:30 ET);
// during EDT that's 13:30 UTC and during EST that's 14:30 UTC — both
// safely within the same UTC date as ET. But a future move to intraday
// bars or a different exchange would have early-morning ET bars at
// 04:30+ UTC, where the UTC slice silently rolls back a day. Pinning
// the format to ET timezone makes the calendar agree with NYSE's
// trading day regardless of bar resolution or DST. Uses 'en-CA'
// locale specifically because it formats ISO YYYY-MM-DD natively.
const ET_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function isoDateET(timestampMs: number): string {
  return ET_DATE_FORMAT.format(new Date(timestampMs));
}

export function indexByDate(bars: Bar[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of bars) {
    out.set(isoDateET(b.timestampMs), b.close);
  }
  return out;
}

// Union of all trading days across a set of symbol bar-maps. We walk
// this union during simulation so each day is visited once regardless
// of how many symbols actually traded that day. Alpaca bars align to
// NYSE calendar so this naturally skips weekends + holidays.
export function unionDates(maps: Map<string, number>[]): string[] {
  const s = new Set<string>();
  for (const m of maps) for (const d of m.keys()) s.add(d);
  return Array.from(s).sort();
}
