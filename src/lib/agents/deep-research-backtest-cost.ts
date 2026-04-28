// Pure cost-estimate helper for the agent_deep_research walk-forward.
// Lives in its own file so the client-side WalkForwardRunner can
// import it without dragging the Alpaca/dotenv graph from
// deep-research-backtest.ts into the browser bundle.

export type AgentBacktestCostEstimate = {
  callCount: number;
  perCallEstimateUsd: number;
  midpointUsd: number;
  lowUsd: number;
  highUsd: number;
};

// Opus 4.7 high-effort numbers: ~30k input tokens (system + filings +
// fundamentals recap) and ~4k output tokens of structured note plus
// several thousand thinking tokens. Approximate per-call cost lands
// around $0.65; we use $1.00 as a conservative central estimate so
// the UI shows a slight cushion above the true number.
//
// Returns midpoint, low (per-call=$0.50), high (per-call=$2.00) so
// the cost-confirm UI can show a range.
export function estimateAgentBacktestCost(args: {
  universeSize: number;
  windowCount: number;
}): AgentBacktestCostEstimate {
  const callCount = Math.max(0, args.universeSize) * Math.max(0, args.windowCount);
  return {
    callCount,
    perCallEstimateUsd: 1.0,
    midpointUsd: callCount * 1.0,
    lowUsd: callCount * 0.5,
    highUsd: callCount * 2.0,
  };
}
