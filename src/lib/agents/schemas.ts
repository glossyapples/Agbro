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
