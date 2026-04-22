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
  | 'boglehead_index';

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
    case 'quality_compounders':
    case 'dividend_growth':
      // Deterministic buy-and-hold of the caller's universe. No
      // price-based exits (these schools don't sell on price). No
      // rebalance (live strategies don't rebalance either — they
      // hold). Simulator walks the window, exit-framework-lite is
      // effectively a no-op, metrics reflect market exposure only.
      return {};
    case 'deep_value_graham':
      // Target sell at +30% from cost, hard time stop at 730 days.
      // These are the ONLY exit triggers; no rebalance.
      return {
        targetSellPct: 30,
        timeStopDays: 730,
      };
    case 'boglehead_index':
      // Quarterly rebalance within 5pt band. No DCA by default in the
      // backtest (lump-sum on day zero); users can override universe
      // to point at different symbols if VTI/VXUS/BND history is thin.
      return {
        targetWeights: BOGLEHEAD_WEIGHTS,
        rebalanceBandPct: 5,
        rebalanceCadenceDays: 90,
      };
  }
}

export const STRATEGY_KEYS: StrategyKey[] = [
  'buffett_core',
  'deep_value_graham',
  'quality_compounders',
  'dividend_growth',
  'boglehead_index',
];

export const STRATEGY_LABELS: Record<StrategyKey, string> = {
  buffett_core: 'Buffett Core',
  deep_value_graham: 'Deep Value (Graham)',
  quality_compounders: 'Quality Compounders',
  dividend_growth: 'Dividend Growth',
  boglehead_index: 'Boglehead Index',
};

// Default universes per strategy. Users can override when starting a
// backtest. The Boglehead universe is the canonical three-fund
// portfolio; the others default to a handful of watchlist names with
// long price histories so the tests work back to the 2008 era.
export const DEFAULT_UNIVERSES: Record<StrategyKey, string[]> = {
  buffett_core: ['KO', 'AAPL', 'MSFT', 'JNJ', 'PG', 'V', 'MA', 'SPY'],
  deep_value_graham: ['XOM', 'CVX', 'JNJ', 'PG', 'KO', 'WMT'],
  quality_compounders: ['AAPL', 'MSFT', 'V', 'MA', 'GOOGL', 'COST'],
  dividend_growth: ['JNJ', 'PG', 'KO', 'PEP', 'MCD', 'ADP'],
  boglehead_index: ['VTI', 'VXUS', 'BND'],
};
