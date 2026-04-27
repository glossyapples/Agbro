// Pins the fix for the -99.6% CAGR / 1-trade Boglehead bug surfaced
// by the walk-forward sweep. Pre-fix, on any day where a held
// position had no bar in indexByDate for that exact date, the
// simulator's mark-to-market silently contributed $0 for that
// position. When the LAST day of the calendar came from the benchmark
// or a sibling symbol — Alpaca IEX holiday-calendar mismatch, ETF
// off-day, end-of-window data gap — every held position marked to
// $0; equity collapsed to whatever cash was. Boglehead deploys 100%
// on day 0, so cash = $0 → equity = $0 → CAGR ≈ -100%.
//
// The fix builds a forward-filled lastKnownBars map alongside the
// strict per-day symbolBars and uses it for VALUATION (mark-to-market,
// drift, rebalance value math) while keeping symbolBars for TRADE
// EXECUTION (you can't actually trade on a stale price).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/alpaca', () => ({
  getBars: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    stockFundamentalsSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getBars } from '@/lib/alpaca';
import { _clearBarCacheForTests } from './data';
import { runSimulation } from './simulator';

// Build trading-day timestamps between two ISO dates inclusive.
function tradingDays(startISO: string, endISO: string): number[] {
  const out: number[] = [];
  const start = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.getTime());
  }
  return out;
}

function flatBars(startISO: string, endISO: string, price: number) {
  return tradingDays(startISO, endISO).map((t) => ({ timestampMs: t, close: price }));
}

beforeEach(() => {
  _clearBarCacheForTests();
  (getBars as unknown as ReturnType<typeof vi.fn>).mockReset();
});

describe('simulator — last-day mark-to-market bug', () => {
  it('REPRO: positions missing the last calendar day collapse equity to cash-only', async () => {
    // Setup: VTI/VXUS/BND all have bars covering 2017-01-02 .. 2018-12-28
    // (Friday). Benchmark SPY has those PLUS one extra bar on 2018-12-31
    // (Monday). The benchmark's extra bar makes 2018-12-31 the LAST day
    // of the simulator's calendar (calendar = union of all maps in window).
    // On 2018-12-31 the held VTI/VXUS/BND positions have NO bar so they
    // mark-to-market at $0 — equity collapses to whatever cash is.
    // Boglehead deploys 100% on day 0, so cash = $0 → equity = $0.
    const portfolioEnd = '2018-12-28';
    const vtiBars = flatBars('2017-01-02', portfolioEnd, 100);
    const vxusBars = flatBars('2017-01-02', portfolioEnd, 50);
    const bndBars = flatBars('2017-01-02', portfolioEnd, 80);
    // SPY has the extra Monday — this becomes the calendar's last day.
    const spyBars = [
      ...flatBars('2017-01-02', portfolioEnd, 200),
      { timestampMs: new Date('2018-12-31T00:00:00Z').getTime(), close: 200 },
    ];

    (getBars as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (symbol: string) => {
        if (symbol === 'VTI') return vtiBars;
        if (symbol === 'VXUS') return vxusBars;
        if (symbol === 'BND') return bndBars;
        if (symbol === 'SPY') return spyBars;
        return [];
      }
    );

    const result = await runSimulation({
      strategyKey: 'boglehead_index',
      universe: ['VTI', 'VXUS', 'BND'],
      benchmarkSymbol: 'SPY',
      startDate: new Date('2017-01-01T00:00:00Z'),
      endDate: new Date('2019-01-01T00:00:00Z'),
      startingCashCents: 100_000_00n,
      mode: 'tier1',
    });

    const series = result.equitySeries;
    expect(series.length).toBeGreaterThan(0);
    const startEquity = series[0].equity;
    const endEquity = series[series.length - 1].equity;
    // BUG: pre-fix this collapses to ~$0 because portfolio symbols have
    // no bar on the calendar's last day. After fix, mark-to-market
    // should fall back to last-known price → equity ≈ $100k (flat).
    expect(endEquity).toBeGreaterThan(startEquity * 0.95);
    expect(endEquity).toBeLessThan(startEquity * 1.05);
  });

  it('positions missing intermittent days should still mark-to-market on subsequent days', async () => {
    // A held symbol's bar is missing on a single mid-window day. That
    // day's equity should fall back to last-known price, not show a
    // synthetic dip to "cash + zero for this position".
    const allDays = tradingDays('2017-01-02', '2018-12-28');
    const gapDay = new Date('2018-06-15T00:00:00Z').getTime();
    const vtiBars = allDays
      .filter((t) => t !== gapDay)
      .map((t) => ({ timestampMs: t, close: 100 }));
    const vxusBars = allDays.map((t) => ({ timestampMs: t, close: 50 }));
    const bndBars = allDays.map((t) => ({ timestampMs: t, close: 80 }));
    const spyBars = allDays.map((t) => ({ timestampMs: t, close: 200 }));

    (getBars as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (symbol: string) => {
        if (symbol === 'VTI') return vtiBars;
        if (symbol === 'VXUS') return vxusBars;
        if (symbol === 'BND') return bndBars;
        if (symbol === 'SPY') return spyBars;
        return [];
      }
    );

    const result = await runSimulation({
      strategyKey: 'boglehead_index',
      universe: ['VTI', 'VXUS', 'BND'],
      benchmarkSymbol: 'SPY',
      startDate: new Date('2017-01-01T00:00:00Z'),
      endDate: new Date('2019-01-01T00:00:00Z'),
      startingCashCents: 100_000_00n,
      mode: 'tier1',
    });

    const series = result.equitySeries;
    // Find the gap-day point. Equity should still be ~$100k there, not
    // dipped by VTI's missing bar contribution.
    const gapPoint = series.find((p) => p.t === gapDay);
    expect(gapPoint).toBeDefined();
    // VTI is 60% of equity — if the bug were active, equity would drop
    // by ~60% on that day. After fix, last-known price keeps it flat.
    expect(gapPoint!.equity).toBeGreaterThan(95_000);
  });
});
