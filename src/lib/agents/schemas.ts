// Zod schemas for agent tool inputs. Extracted from tools.ts so they can
// be validated without pulling in Prisma/Alpaca at import time (useful for
// unit tests and for any future tool-dispatch layer).

import { z } from 'zod';

export const PlaceTradeInput = z.object({
  symbol: z.string().min(1).max(12),
  side: z.enum(['buy', 'sell']),
  qty: z.number().positive().finite().max(1_000_000),
  orderType: z.enum(['market', 'limit']).optional(),
  limitPrice: z.number().positive().finite().optional(),
  bullCase: z.string().min(1).max(4_000),
  bearCase: z.string().min(1).max(4_000),
  thesis: z.string().min(1).max(4_000),
  confidence: z.number().min(0).max(1),
  intrinsicValuePerShare: z.number().nonnegative().finite().optional(),
  marginOfSafetyPct: z.number().min(-100).max(100).optional(),
});

export const SizePositionInput = z.object({
  buffettScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
});

// Refresh fundamentals for a watched stock after research. Every numeric
// field is optional — the agent supplies only what it has fresh data for.
// Bounds are wide on purpose (real-world outliers exist: ROE > 100%,
// negative book value, etc.) but finite to keep junk out of the DB.
export const UpdateStockFundamentalsInput = z.object({
  symbol: z.string().min(1).max(12),
  peRatio: z.number().finite().min(-1_000).max(10_000).optional(),
  pbRatio: z.number().finite().min(-1_000).max(10_000).optional(),
  dividendYield: z.number().finite().min(0).max(100).optional(),
  payoutRatio: z.number().finite().min(-1_000).max(1_000).optional(),
  debtToEquity: z.number().finite().min(-100).max(1_000).optional(),
  returnOnEquity: z.number().finite().min(-1_000).max(1_000).optional(),
  grossMarginPct: z.number().finite().min(-100).max(100).optional(),
  fcfYieldPct: z.number().finite().min(-100).max(100).optional(),
  moatScore: z.number().int().min(0).max(100).optional(),
  buffettScore: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(2_000).optional(),
});

export type PlaceTradeInput = z.infer<typeof PlaceTradeInput>;
export type SizePositionInput = z.infer<typeof SizePositionInput>;
export type UpdateStockFundamentalsInput = z.infer<typeof UpdateStockFundamentalsInput>;

// Universe screener. The agent passes in criteria; the tool checks a 7-day
// cooldown, queries Perplexity for matches excluding anything already in the
// DB, enriches hits with EDGAR fundamentals, and stores them as Tier 2
// candidates for the user to approve or reject. See src/lib/data/screener.ts
// for the full contract + cadence rationale.
export const ScreenUniverseInput = z.object({
  minRoePct: z.number().finite().min(0).max(200).optional(),
  maxPeRatio: z.number().finite().positive().max(200).optional(),
  minDividendYieldPct: z.number().finite().min(0).max(50).optional(),
  preferredSectors: z.array(z.string().max(64)).max(12).optional(),
  thesisHint: z.string().max(500).optional(),
});
export type ScreenUniverseInput = z.infer<typeof ScreenUniverseInput>;

// Event calendar tool. horizonDays defaults to 14 (two weeks of lookahead).
// symbol is optional — omit for watchlist-wide + market events.
export const GetEventCalendarInput = z.object({
  symbol: z.string().min(1).max(12).optional(),
  horizonDays: z.number().int().min(1).max(90).optional(),
});
export type GetEventCalendarInput = z.infer<typeof GetEventCalendarInput>;

// Option chain lookup. Returns contracts for the underlying filtered to the
// strategy's DTE window + the side the agent wants. Result is trimmed to
// the fields the agent actually needs to pick a strike.
export const GetOptionChainInput = z.object({
  underlying: z.string().min(1).max(12),
  type: z.enum(['call', 'put']),
  minDTE: z.number().int().min(1).max(365).optional(),
  maxDTE: z.number().int().min(1).max(365).optional(),
});
export type GetOptionChainInput = z.infer<typeof GetOptionChainInput>;

// Sell-to-open an option. v1 only supports covered_call and cash_secured_put
// — the server rejects anything else. qty is contracts (1 = 100 shares).
// limitPrice is per-share (Alpaca convention); total credit = limitPrice × 100 × qty.
export const PlaceOptionTradeInput = z.object({
  optionSymbol: z.string().min(10).max(32),
  setup: z.enum(['covered_call', 'cash_secured_put']),
  qty: z.number().int().positive().max(100),
  limitPrice: z.number().finite().positive().optional(),
  thesis: z.string().min(1).max(2_000),
});
export type PlaceOptionTradeInput = z.infer<typeof PlaceOptionTradeInput>;
