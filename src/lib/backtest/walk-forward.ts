// Walk-forward backtest harness. The single biggest credibility gap in
// AgBro today: every metric we report on /backtest comes from a SINGLE
// in-sample run. A strategy that looks great on a curated 2015-2024
// stretch tells us nothing about whether it would have held up on a
// different decade — and the value-investing presets here haven't been
// stress-tested against that question.
//
// Walk-forward = slide a fixed-length test window across a long
// history, run the strategy fresh on each slice, report per-window
// metrics + a "consistency" score that's hard to game.
//
// Note on "training": our strategies are deterministic rule-based, not
// parameter-fit, so there's no train phase and the strategies cannot
// be curve-fit in the ML sense. Walk-forward in our case is pure
// out-of-sample validation across rolling windows: it tells us
// whether the strategy's edge over the benchmark (alpha) is stable
// across market regimes, or whether the single-window alpha shown on
// /backtest is a regime-specific artifact. A passive strategy
// (Boglehead) shows wildly different raw CAGRs across windows
// because the market itself does — but its alpha is a tight cluster.
// That's why consistency below is measured on alpha, not on CAGR.

import {
  runSimulation,
  type BacktestMode,
  type SimulatorResult,
} from './simulator';
import { computeMetrics, type BacktestMetrics } from './metrics';
import type { StrategyKey } from './rules';
import { log } from '@/lib/logger';

export type WalkForwardConfig = {
  strategyKey: StrategyKey;
  totalStart: Date;
  totalEnd: Date;
  // Length of each test window in calendar months (e.g. 24 = 2 years).
  windowMonths: number;
  // How far to slide the window forward between iterations. < windowMonths
  // means windows overlap (a single bad year affects multiple windows);
  // == windowMonths means non-overlapping. We default callers to overlap
  // because it gives more samples for the consistency metric.
  stepMonths: number;
  universe: string[];
  benchmarkSymbol?: string; // default 'SPY'
  startingCashCents?: bigint; // default 100k
  mode?: BacktestMode; // default 'tier1' — tier2 needs per-symbol EDGAR coverage
};

export type WalkForwardWindow = {
  startISO: string; // YYYY-MM-DD
  endISO: string;
  metrics: BacktestMetrics;
  // Strategy CAGR minus benchmark CAGR over the window. Positive = the
  // strategy beat the benchmark in this slice; negative = it lost.
  alphaPct: number | null;
  tradeCount: number;
  // True when the strategy effectively didn't run in this window —
  // most often because Alpaca's IEX free-tier coverage doesn't span
  // the universe in the given era (VXUS/BND pre-2019 are the canonical
  // case). Heuristic: in a multi-symbol universe, a window with fewer
  // than 2 trades couldn't have meaningfully deployed the book. The
  // metrics for these windows are technically valid but reflect "cash
  // sat idle" rather than strategy performance, so the harness
  // excludes them from aggregate medians + consistency math to keep
  // the headline number honest.
  dataStarved: boolean;
};

export type WalkForwardResult = {
  windows: WalkForwardWindow[];
  // Aggregate signals across windows. Consistency is the headline:
  // a robust strategy has windows that cluster around a similar CAGR;
  // a curve-fit one has wild swings between windows that don't match
  // the era it was tuned for.
  aggregate: {
    medianCagrPct: number | null;
    medianMaxDrawdownPct: number;
    medianAlphaPct: number | null;
    // 0..1 — measures consistency of ALPHA (strategy CAGR minus
    // benchmark CAGR) across windows, NOT raw CAGR. See
    // computeConsistency below for the math. Why alpha and not CAGR:
    // our strategies are deterministic rule-based (no parameters to
    // overfit) so the original "detect curve-fitting" use case
    // doesn't apply. What we actually want to know is whether the
    // strategy's edge over the benchmark is stable across market
    // regimes. Boglehead's raw CAGR varies wildly across windows
    // (because the market does), but its alpha is a tight cluster of
    // ~-5% — that's a stable signal, not curve-fit.
    consistencyScore: number;
    windowCount: number;
    // Diagnostics. windowsWithData is the count of windows where the
    // simulator actually produced an equity series (cagrPct != null);
    // a low ratio vs windowCount means most windows hit the
    // "no_data" short-circuit (Alpaca IEX coverage gap, missing
    // bars on a watchlist symbol, etc.) — and any aggregate metric
    // with sparse-data input is suspect, not a strategy verdict.
    // tradesTotal sums tradeCount across windows; zero across the
    // whole sweep is the loudest signal that nothing actually ran.
    windowsWithData: number;
    tradesTotal: number;
    // Count of windows excluded from aggregate math due to data
    // starvation (see WalkForwardWindow.dataStarved). UI can show
    // "5 of 7 windows" when this is non-zero so the user knows the
    // headline median is computed on a subset.
    windowsStarved: number;
  };
};

// Pure function exported for tests. Splits a date range into rolling
// [start, end] windows of fixed length, advancing by stepMonths.
//
// Edge cases:
//   - If windowMonths > total span: returns one window covering the
//     full span (better than zero windows).
//   - If stepMonths <= 0: throws (would loop forever).
//   - The last window's end is clamped to totalEnd; if the window
//     would be < windowMonths/2 long it's dropped (too short to
//     produce meaningful metrics).
//
// Returns ISO YYYY-MM-DD strings so the result is JSON-stable.
export function splitWindows(
  totalStart: Date,
  totalEnd: Date,
  windowMonths: number,
  stepMonths: number
): Array<{ startISO: string; endISO: string }> {
  if (stepMonths <= 0) {
    throw new Error('splitWindows: stepMonths must be > 0');
  }
  if (windowMonths <= 0) {
    throw new Error('splitWindows: windowMonths must be > 0');
  }
  if (totalEnd.getTime() <= totalStart.getTime()) {
    return [];
  }

  // Coerce to UTC midnight so the math doesn't drift through DST.
  const startUtcMs = Date.UTC(
    totalStart.getUTCFullYear(),
    totalStart.getUTCMonth(),
    totalStart.getUTCDate()
  );
  const endUtcMs = Date.UTC(
    totalEnd.getUTCFullYear(),
    totalEnd.getUTCMonth(),
    totalEnd.getUTCDate()
  );

  const out: Array<{ startISO: string; endISO: string }> = [];
  let cursor = startUtcMs;
  // Threshold for keeping a clamped (partial) window. 75% of the
  // requested window length: the final partial window must be a
  // substantial fraction of a full window, otherwise it adds noise to
  // the consistency metric without adding much signal. Two-thirds
  // would also be defensible; settled on 0.75 to err toward stricter
  // — better to undercount windows than emit a half-window that
  // skews the median CAGR comparison.
  const minWindowMs = windowMonths * 0.75 * 30 * 86_400_000;

  while (cursor < endUtcMs) {
    const winStart = new Date(cursor);
    const winEnd = addMonths(winStart, windowMonths);
    const clampedEnd = winEnd.getTime() > endUtcMs ? new Date(endUtcMs) : winEnd;
    const lengthMs = clampedEnd.getTime() - winStart.getTime();

    // Always emit at least one window — better than zero. Subsequent
    // windows must clear the 75% threshold.
    if (out.length === 0 || lengthMs >= minWindowMs) {
      out.push({
        startISO: toISODate(winStart),
        endISO: toISODate(clampedEnd),
      });
      cursor = addMonths(winStart, stepMonths).getTime();
    } else {
      break;
    }
  }
  return out;
}

function addMonths(d: Date, months: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate())
  );
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Pure helper exported for tests. Consistency is the median absolute
// distance of each window's CAGR from the median CAGR, normalised so
// 0 = wildly inconsistent, 1 = identical across all windows.
//
// Math: 1 - clamp(MAD / max(|median|, scaleFloor), 0, 1)
//
// `scaleFloor` (default 5%) keeps the metric meaningful when the
// median CAGR is near zero — without it, a strategy that returns
// 0.1% one window and 0.2% the next would score wildly inconsistent
// because the relative spread is ~50%.
//
// Returns 1 when fewer than 2 windows have a CAGR (can't measure
// consistency on a single point). Windows with null CAGR (too short
// to compute) are excluded.
export function computeConsistency(
  windowCagrs: Array<number | null>,
  scaleFloor = 5
): number {
  const xs = windowCagrs.filter((v): v is number => v != null);
  if (xs.length < 2) return 1;
  const median = quickMedian(xs);
  const deviations = xs.map((v) => Math.abs(v - median));
  const mad = quickMedian(deviations);
  const scale = Math.max(Math.abs(median), scaleFloor);
  const ratio = mad / scale;
  return Math.max(0, Math.min(1, 1 - ratio));
}

function quickMedian(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function median(xs: Array<number | null>): number | null {
  const ys = xs.filter((v): v is number => v != null);
  if (ys.length === 0) return null;
  return quickMedian(ys);
}

// Main entry point. Sequential — each window's runSimulation is async
// and the simulator is CPU-light but I/O-heavy (price + fundamentals
// reads). Running them serially keeps the DB connection-pool friendly
// and gives the UI a natural progress signal.
export async function runWalkForward(
  config: WalkForwardConfig
): Promise<WalkForwardResult> {
  const slices = splitWindows(
    config.totalStart,
    config.totalEnd,
    config.windowMonths,
    config.stepMonths
  );

  const benchmarkSymbol = config.benchmarkSymbol ?? 'SPY';
  const startingCashCents = config.startingCashCents ?? 100_000_00n;
  const mode: BacktestMode = config.mode ?? 'tier1';

  const windows: WalkForwardWindow[] = [];

  for (const slice of slices) {
    try {
      const sim: SimulatorResult = await runSimulation({
        strategyKey: config.strategyKey,
        universe: config.universe,
        benchmarkSymbol,
        startDate: new Date(slice.startISO + 'T00:00:00Z'),
        endDate: new Date(slice.endISO + 'T00:00:00Z'),
        startingCashCents,
        mode,
      });
      const metrics = computeMetrics(sim.equitySeries);
      // Window-scoped alpha: simple difference between annualised
      // returns. Falls through to null when the slice is too short
      // for CAGR (computeMetrics returns null in that case).
      const benchmarkCagr =
        sim.equitySeries.length >= 2 && sim.equitySeries[0].benchmark > 0
          ? (Math.pow(
              sim.equitySeries[sim.equitySeries.length - 1].benchmark /
                sim.equitySeries[0].benchmark,
              1 /
                ((sim.equitySeries[sim.equitySeries.length - 1].t -
                  sim.equitySeries[0].t) /
                  (365.25 * 86_400_000))
            ) -
              1) *
            100
          : null;
      const alphaPct =
        metrics.cagrPct != null && benchmarkCagr != null
          ? metrics.cagrPct - benchmarkCagr
          : null;

      windows.push({
        startISO: slice.startISO,
        endISO: slice.endISO,
        metrics,
        alphaPct,
        tradeCount: sim.tradeCount,
        dataStarved: isDataStarved(config.universe.length, sim.tradeCount),
      });
    } catch (err) {
      log.error('walk_forward.window_failed', err, {
        strategy: config.strategyKey,
        startISO: slice.startISO,
        endISO: slice.endISO,
      });
      // One bad window doesn't kill the harness. Push a zero-metrics
      // entry so the UI shows the gap explicitly rather than silently
      // omitting it.
      windows.push({
        startISO: slice.startISO,
        endISO: slice.endISO,
        metrics: {
          totalReturnPct: 0,
          benchmarkReturnPct: 0,
          cagrPct: null,
          sharpeAnnual: null,
          maxDrawdownPct: 0,
          worstMonthPct: 0,
        },
        alphaPct: null,
        tradeCount: 0,
        dataStarved: true,
      });
    }
  }

  // Aggregate math runs on the non-starved subset only. A "1 trade,
  // 0% CAGR" window from a data-coverage gap shouldn't drag the
  // median down or inflate the MAD in computeConsistency — those are
  // cash-sat-idle artifacts, not strategy performance.
  const live = windows.filter((w) => !w.dataStarved);
  const cagrs = live.map((w) => w.metrics.cagrPct);
  const drawdowns = live.map((w) => w.metrics.maxDrawdownPct);
  const alphas = live.map((w) => w.alphaPct);

  return {
    windows,
    aggregate: {
      medianCagrPct: median(cagrs),
      medianMaxDrawdownPct: median(drawdowns) ?? 0,
      medianAlphaPct: median(alphas),
      // Alpha-based, not CAGR-based — see WalkForwardResult docstring.
      // Falls back to CAGR consistency if every window's alpha is null
      // (rare; would mean the benchmark series was empty).
      consistencyScore: alphas.some((a) => a != null)
        ? computeConsistency(alphas)
        : computeConsistency(cagrs),
      windowCount: windows.length,
      windowsWithData: windows.filter((w) => w.metrics.cagrPct != null).length,
      tradesTotal: windows.reduce((s, w) => s + w.tradeCount, 0),
      windowsStarved: windows.filter((w) => w.dataStarved).length,
    },
  };
}

// Heuristic: in a multi-symbol universe, a window that produced fewer
// than 2 trades couldn't have meaningfully deployed the strategy book.
// The most common cause is Alpaca IEX free-tier coverage gaps for
// less-liquid ETFs in older windows (VXUS / BND pre-2019). For
// single-symbol universes any tradeCount is fine — there's only one
// symbol to deploy.
export function isDataStarved(universeSize: number, tradeCount: number): boolean {
  return universeSize > 1 && tradeCount < 2;
}
