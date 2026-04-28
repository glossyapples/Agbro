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
  | 'burry_deep_research'
  // Real LLM-driven research per name at each window's decision date,
  // ranked by conviction, top-N deployed equal-weight. Distinct from
  // burry_deep_research, which is a hand-curated 6-stock buy-and-hold.
  // This one calls the deep-research agent (point-in-time-correct,
  // strict-PIT prompt scaffold to fight training-data lookahead bias)
  // and lets it pick. Validation cost is real: ~$0.50-2.00 per
  // (symbol, window) pair, so the walk-forward UI gates the run on a
  // cost-estimate confirmation.
  | 'agent_deep_research';

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
      // Aristocrats-style bar — moderate ROE, modest leverage. The live
      // strategy's 25-year-streak + yield requirement CAN'T be evaluated
      // from cached fundamentals: historical-fundamentals.ts deliberately
      // stores dividendYield=null because deriving it requires point-in-
      // time dividend events we don't cache (would need Alpaca corp-
      // actions). Leaving minDividendYieldPct=2 in here meant every
      // symbol failed the filter ("passedWithoutData" was the only path
      // in) — silent garbage backtests. Live trading enforces yield
      // against real-time Alpaca data; backtest falls back to ROE +
      // leverage as the closest proxy for durable-payer quality.
      return {
        minROE: 12,
        maxPE: 25,
        maxDE: 2,
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
      // Honest buy-and-hold approximation. A previous version added
      // targetSellPct + timeStopDays to "rotate", but the simulator
      // has no redeploy path for Burry (no filtersActive, no
      // rebalance cadence, no DCA) — so exits fired and proceeds
      // sat in cash indefinitely. Silent cash drag compounded, making
      // the curve worse than pure buy-and-hold.
      //
      // Empty ruleset = equal-weight buy-and-hold of the day-0 "ick"
      // universe with no exits. Overstates how long Burry actually
      // holds (his losers get cut fast in reality), but it's
      // predictable and doesn't lie about cash drag. A proper
      // rotation-aware version would need a redeploy leg in the
      // simulator that equal-weights the surviving names after each
      // exit; out of scope for a backtest approximation of a style
      // whose real edge is the 10-K read, not the trade mechanics.
      return {};
    case 'agent_deep_research':
      // The simulator's standard rule fields don't drive this strategy
      // — the deep-research agent picks the names per window from the
      // caller-supplied universe. Empty ruleset signals "use the
      // agent code path" to runSimulation.
      return {};
  }
}

export const STRATEGY_KEYS: StrategyKey[] = [
  'buffett_core',
  'deep_value_graham',
  'quality_compounders',
  'dividend_growth',
  'boglehead_index',
  'burry_deep_research',
  'agent_deep_research',
];

export const STRATEGY_LABELS: Record<StrategyKey, string> = {
  buffett_core: 'Buffett Core',
  deep_value_graham: 'Deep Value (Graham)',
  quality_compounders: 'Quality Compounders',
  dividend_growth: 'Dividend Growth',
  boglehead_index: 'Boglehead Index',
  burry_deep_research: 'Burry Deep Research',
  agent_deep_research: 'Agent Deep Research',
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
  // Default agent universe — broad enough to give the LLM something
  // to choose from, narrow enough to keep validation cost
  // reasonable. ~30 large-cap names with long EDGAR + price
  // histories. The user can override per run via the walk-forward
  // form. Cost scales linearly with universe size × window count;
  // this default at 5 windows = 150 agent calls = ~$150 with Opus
  // high effort.
  agent_deep_research: [
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'V', 'MA',
    'JNJ', 'PG', 'KO', 'PEP', 'COST', 'WMT', 'HD', 'MCD',
    'BRK.B', 'JPM', 'BAC', 'XOM', 'CVX', 'UNH', 'ABBV', 'LLY',
    'TMO', 'ADBE', 'CRM', 'NFLX', 'NKE', 'DIS',
  ],
};
