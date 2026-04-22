// Performance metrics for a completed backtest run. All inputs are the
// equity-series array from the simulator — no raw price dependencies,
// so these are pure functions that are trivially testable.

export type EquityPoint = { t: number; equity: number; benchmark: number };

export type BacktestMetrics = {
  totalReturnPct: number;
  benchmarkReturnPct: number;
  cagrPct: number | null;
  sharpeAnnual: number | null;
  maxDrawdownPct: number;
  worstMonthPct: number;
};

const TRADING_DAYS_PER_YEAR = 252;

export function computeMetrics(series: EquityPoint[]): BacktestMetrics {
  if (series.length < 2) {
    return {
      totalReturnPct: 0,
      benchmarkReturnPct: 0,
      cagrPct: null,
      sharpeAnnual: null,
      maxDrawdownPct: 0,
      worstMonthPct: 0,
    };
  }

  const start = series[0];
  const end = series[series.length - 1];
  const totalReturnPct = ((end.equity - start.equity) / start.equity) * 100;
  const benchmarkReturnPct =
    ((end.benchmark - start.benchmark) / start.benchmark) * 100;

  // CAGR: compound annual growth rate. Requires ≥ a few months of data
  // to be meaningful; we still compute it below that, caller decides
  // whether to display.
  const years = (end.t - start.t) / (365.25 * 86_400_000);
  const cagrPct =
    years > 0.05 && start.equity > 0
      ? (Math.pow(end.equity / start.equity, 1 / years) - 1) * 100
      : null;

  // Sharpe: annualized, assuming risk-free rate ≈ 0 (paper backtest, we're
  // not doing capital-allocation math). Uses daily log returns of equity.
  let sharpeAnnual: number | null = null;
  if (series.length >= 30) {
    const dailyReturns: number[] = [];
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1].equity;
      if (prev > 0 && series[i].equity > 0) {
        dailyReturns.push(Math.log(series[i].equity / prev));
      }
    }
    if (dailyReturns.length > 0) {
      const mean = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
      const variance =
        dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) /
        dailyReturns.length;
      const stdev = Math.sqrt(variance);
      if (stdev > 0) {
        sharpeAnnual =
          (mean / stdev) * Math.sqrt(TRADING_DAYS_PER_YEAR);
      }
    }
  }

  // Max drawdown: worst peak-to-trough decline in equity, percent.
  let maxDrawdownPct = 0;
  let peak = series[0].equity;
  for (const p of series) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = ((p.equity - peak) / peak) * 100;
      if (dd < maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  // Worst month return — groups series by calendar month and finds the
  // single worst month's total return. Gives users a feel for tail
  // risk beyond max DD (a crash that recovered quickly and a grinding
  // down-year look very different on this metric).
  let worstMonthPct = 0;
  const monthBuckets = new Map<string, { first: number; last: number }>();
  for (const p of series) {
    const ym = new Date(p.t).toISOString().slice(0, 7); // YYYY-MM
    const existing = monthBuckets.get(ym);
    if (!existing) monthBuckets.set(ym, { first: p.equity, last: p.equity });
    else existing.last = p.equity;
  }
  for (const b of monthBuckets.values()) {
    if (b.first > 0) {
      const r = ((b.last - b.first) / b.first) * 100;
      if (r < worstMonthPct) worstMonthPct = r;
    }
  }

  return {
    totalReturnPct,
    benchmarkReturnPct,
    cagrPct,
    sharpeAnnual,
    maxDrawdownPct,
    worstMonthPct,
  };
}
