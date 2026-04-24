// Strategy rulesets for the backtester. Maps our live strategy keys to
// the deterministic subset of rules the simulator can actually execute.
// Rules that depend on LLM judgement, fundamentals at point-in-time, or
// options data are absent here by design — see simulator.ts for the
// Tier-1 scope comment.

export type StrategyKey =
  | 'buffett_core'
  | 'deep_value_graham'
  | 'quality_compounders'
  | 'dividend_growth'
  | 'boglehead_index'
  | 'burry_deep_research';

export type BacktestRuleset = {
  // Day-zero + rebalance targets. For value strategies that receive an
  // undefined here, the simulator falls back to equal-weighting the
  // caller-supplied universe.
  targetWeights?: Record<string, number>;
  // Rebalance band in percentage points of portfolio weight; simulator
  // skips rebalance unless current drift exceeds this.
  rebalanceBandPct?: number;
  rebalanceCadenceDays?: number;
  // DCA configuration — if present, simulator adds `dcaAmountPerPeriod`
  // dollars to target weights every `dcaCadenceDays`. Boglehead-style.
  dcaAmountPerPeriod?: number;
  dcaCadenceDays?: number;
  // Graham-style mean-reversion exit: sell a position when unrealized
  // gain crosses this percentage vs. cost basis.
  targetSellPct?: number;
  // Graham's 2-year rule: sell any position held longer than this
  // regardless of outcome.
  timeStopDays?: number;
  // Tier 2 filters — applied at initial buy and each rebalance. Only
  // symbols that clear ALL non-null filters as of the decision date
  // are eligible. Requires StockFundamentalsSnapshot rows to be
  // populated for the symbol. Matches the live-strategy rule shape
  // so backtest + paper behaviour stay aligned.
  minROE?: number;
  maxPE?: number;
  maxDE?: number;
  minGrossMarginPct?: number;
  minDividendYieldPct?: number;
};

// Boglehead reference portfolio — used when strategy is Boglehead AND
// caller didn't supply explicit target weights. Matches the live
// strategy's seeded coreHoldings.
const BOGLEHEAD_WEIGHTS: Record<string, number> = {
  VTI: 0.6,
  VXUS: 0.3,
  BND: 0.1,
};

export function resolveRuleset(key: StrategyKey): BacktestRuleset {
  switch (key) {
    case 'buffett_core':
      // Fundamentals-aware buy-and-hold. Filter the universe to names
      // that meet Buffett Core's live rules at the decision date.
      return {
        minROE: 15,
        maxPE: 22,
        maxDE: 1.5,
      };
    case 'quality_compounders':
      // Stricter bar per the live strategy — wide moat, 20%+ ROE,
      // accept higher P/E.
      return {
        minROE: 20,
        maxPE: 30,
        maxDE: 1.5,
      };
    case 'dividend_growth':
      // Aristocrats-style bar — moderate ROE, modest leverage, meaningful
      // yield. The live strategy's 25-year-streak requirement can't be
      // evaluated from EDGAR alone (requires dividend history data);
      // we approximate via minDividendYieldPct.
      return {
        minROE: 12,
        maxPE: 25,
        maxDE: 2,
        minDividendYieldPct: 2,
      };
    case 'deep_value_graham':
      // Target sell at +30% from cost, hard time stop at 730 days.
      // Graham-style cheapness filters: low P/E, low leverage.
      return {
        targetSellPct: 30,
        timeStopDays: 730,
        maxPE: 15,
        maxDE: 1,
        minROE: 5,
      };
    case 'boglehead_index':
      // Quarterly rebalance within 5pt band. No fundamentals filter —
      // Boglehead doesn't filter; it holds the market.
      return {
        targetWeights: BOGLEHEAD_WEIGHTS,
        rebalanceBandPct: 5,
        rebalanceCadenceDays: 90,
      };
    case 'burry_deep_research':
      // Contrarian deep-value backtest approximation. P/E filter is
      // explicitly omitted — Burry de-emphasises it. Low P/B + low D/E
      // is as close as the backtester can get to "ick + balance-sheet
      // strength" without the fundamentals-read the agent does live.
      // ROE bar stays low because Burry buys turnarounds.
      return {
        maxPE: 999,
        maxDE: 1.5,
        minROE: 0,
      };
  }
}

export const STRATEGY_KEYS: StrategyKey[] = [
  'buffett_core',
  'deep_value_graham',
  'quality_compounders',
  'dividend_growth',
  'boglehead_index',
  'burry_deep_research',
];

export const STRATEGY_LABELS: Record<StrategyKey, string> = {
  buffett_core: 'Buffett Core',
  deep_value_graham: 'Deep Value (Graham)',
  quality_compounders: 'Quality Compounders',
  dividend_growth: 'Dividend Growth',
  boglehead_index: 'Boglehead Index',
  burry_deep_research: 'Burry Deep Research',
};

// Default universes per strategy. Users can override when starting a
// backtest. The Boglehead universe is the canonical three-fund
// portfolio; the others default to a handful of watchlist names with
// long price histories so the tests work back to the 2008 era.
export const DEFAULT_UNIVERSES: Record<StrategyKey, string[]> = {
  // SPY excluded: ETFs don't file 10-Ks, so they always reject the
  // fundamentals filter. Use /backtest/grid for SPY-benchmarked overlay.
  buffett_core: ['KO', 'AAPL', 'MSFT', 'JNJ', 'PG', 'V', 'MA', 'WMT'],
  deep_value_graham: ['XOM', 'CVX', 'JNJ', 'PG', 'KO', 'WMT'],
  quality_compounders: ['AAPL', 'MSFT', 'V', 'MA', 'GOOGL', 'COST'],
  dividend_growth: ['JNJ', 'PG', 'KO', 'PEP', 'MCD', 'ADP'],
  boglehead_index: ['VTI', 'VXUS', 'BND'],
  // Burry's actual book over the years has included defence (GEO),
  // energy (XOM, CVX), pharma on "ick" momentum (BMY, GILD), and
  // retail he thought was misunderstood (M, GPS). Deliberate mix of
  // unloved names with long histories.
  burry_deep_research: ['GEO', 'BMY', 'GILD', 'M', 'GPS', 'CVX'],
};
