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

export type PlaceTradeInput = z.infer<typeof PlaceTradeInput>;
export type SizePositionInput = z.infer<typeof SizePositionInput>;
