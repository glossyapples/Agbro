// Zod parsers for the JSON-serialised shapes we persist on
// BacktestRun and WalkForwardRun. These columns are stored as
// Postgres `jsonb` and the Prisma client returns them as `unknown` —
// without a runtime parse, every read site does
// `as unknown as ConcreteType` which TypeScript happily believes
// even after the producer has drifted.
//
// Audit C11: that drift is the next 2-week-bug class. A schema field
// rename on EquityPoint / WindowView / AggregateView would silently
// produce broken reads with no compile error and no test failure.
// `safeParse()` here means engineers get a loud log on any drift
// AND the UI still renders (with an empty array instead of garbage
// data shaped like the old type).

import { z } from 'zod';
import { log } from '@/lib/logger';

// ──────────────────────────────────────────────────────────────────
// EquityPoint — the equity series produced by simulator.ts and read
// back by /api/backtest/grid/series (chart overlay) and the run
// detail page.

export const EquityPointSchema = z.object({
  t: z.number(),
  equity: z.number(),
  benchmark: z.number(),
});
export const EquitySeriesSchema = z.array(EquityPointSchema);
export type EquityPointParsed = z.infer<typeof EquityPointSchema>;

// ──────────────────────────────────────────────────────────────────
// WindowView + AggregateView — walk-forward output shapes. Mirrors
// types declared at app/backtest/walk-forward/page.tsx + components/
// WalkForwardRunner.tsx; consolidating here lets both readers share
// one source of runtime truth.

export const WindowViewSchema = z.object({
  startISO: z.string(),
  endISO: z.string(),
  metrics: z.object({
    cagrPct: z.number().nullable(),
    maxDrawdownPct: z.number(),
    sharpeAnnual: z.number().nullable(),
    totalReturnPct: z.number(),
    benchmarkReturnPct: z.number(),
  }),
  alphaPct: z.number().nullable(),
  tradeCount: z.number(),
});
export const WindowViewArraySchema = z.array(WindowViewSchema);
export type WindowViewParsed = z.infer<typeof WindowViewSchema>;

export const AggregateViewSchema = z.object({
  medianCagrPct: z.number().nullable(),
  medianMaxDrawdownPct: z.number(),
  medianAlphaPct: z.number().nullable(),
  consistencyScore: z.number(),
  windowCount: z.number(),
  windowsWithData: z.number().optional(),
  tradesTotal: z.number().optional(),
  windowsStarved: z.number().optional(),
  agentCostUsd: z.number().optional(),
  costAbortedAtUsd: z.number().optional(),
});
export type AggregateViewParsed = z.infer<typeof AggregateViewSchema>;

// ──────────────────────────────────────────────────────────────────
// Helpers — `safeParse` wrappers that log on drift and return a
// sensible empty fallback so the read path never crashes the UI.

export function parseEquitySeries(value: unknown, ctx: string): EquityPointParsed[] {
  const r = EquitySeriesSchema.safeParse(value);
  if (r.success) return r.data;
  log.error(
    'persisted.shape_drift.equitySeries',
    new Error(`shape drift in ${ctx}: ${r.error.issues[0]?.message ?? 'unknown'}`),
    { ctx, issues: r.error.issues.slice(0, 3) }
  );
  return [];
}

export function parseWindowViews(value: unknown, ctx: string): WindowViewParsed[] {
  if (!Array.isArray(value)) return [];
  const r = WindowViewArraySchema.safeParse(value);
  if (r.success) return r.data;
  log.error(
    'persisted.shape_drift.windows',
    new Error(`shape drift in ${ctx}: ${r.error.issues[0]?.message ?? 'unknown'}`),
    { ctx, issues: r.error.issues.slice(0, 3) }
  );
  return [];
}

export function parseAggregateView(value: unknown, ctx: string): AggregateViewParsed | null {
  if (value == null || typeof value !== 'object') return null;
  const r = AggregateViewSchema.safeParse(value);
  if (r.success) return r.data;
  log.error(
    'persisted.shape_drift.aggregate',
    new Error(`shape drift in ${ctx}: ${r.error.issues[0]?.message ?? 'unknown'}`),
    { ctx, issues: r.error.issues.slice(0, 3) }
  );
  return null;
}
