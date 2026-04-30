// Post-mortem learning loop. The unique upside of having a versioned
// brain (category, confidence, supersededById) is that the agent can
// re-read its own reasoning months later and notice what it got
// wrong. Today nothing closes that loop — closed Trade rows pile up,
// but no brain entry ever records the lesson, and the agent makes
// the same kinds of mistakes weekly.
//
// This module is the close. For each closed trade in a window:
//   1. Gather the trade row + the brain entries written when the
//      agent originally formed the thesis (sourceRunId match)
//   2. Ask Opus: "was this thesis correct? if not, why? is the lesson
//      generalizable?"
//   3. Write a new BrainEntry with kind='post_mortem',
//      category='memory', confidence depending on the magnitude of
//      win or loss
//   4. If the post-mortem concludes the thesis was *wrong* (not just
//      unlucky), set the original thesis entry's supersededById to
//      point at the new entry. read_brain filters superseded entries
//      out by default so the agent stops pulling contradictory
//      memories on future wakes.
//
// Cost cap: 5 trades per call. Per-trade Opus cost ~$0.10-0.30 with
// thinking enabled, so a maxed run is ~$1.50. Bounded.
//
// Dedup: BrainEntry.postMortemTradeIds is checked before writing —
// the same trade can never get two post-mortem entries, so the
// agent calling run_post_mortem repeatedly within the same window
// is a no-op past the first call.

import Anthropic from '@anthropic-ai/sdk';
import type { Trade, BrainEntry } from '@prisma/client';
import { prisma } from '@/lib/db';
import { TRADE_DECISION_MODEL } from './models';
import { log } from '@/lib/logger';
import { estimateCostUsd } from '@/lib/pricing';
import { recordApiSpend } from '@/lib/safety/api-spend-log';

export const MAX_TRADES_PER_POST_MORTEM = 5;

export type PostMortemContext = {
  trade: Trade;
  // The most recent agent-authored hypothesis brain entry tagged with
  // this symbol, written during or before the run that placed the
  // trade. Null when the trade was placed by a path that didn't
  // mirror to brain (legacy trades, manual fills).
  originalThesis: BrainEntry | null;
  // Other brain entries the agent wrote about this symbol during the
  // run that placed the trade — research notes, evaluations, etc.
  // Helps the post-mortem model see the full reasoning context.
  relatedNotes: BrainEntry[];
};

export type PostMortemResult = {
  tradeId: string;
  symbol: string;
  outcome: 'win' | 'loss' | 'flat';
  realizedPnlUsd: number;
  realizedPnlPct: number;
  brainEntryId: string;
  thesisSuperseded: boolean;
  costUsd: number;
};

// What we expect Opus to return per trade. Loose Zod-shape via JSON
// parse — the prompt asks for this exact shape and we tolerate small
// schema drift in failure modes.
type PostMortemAnalysis = {
  thesisAssessment: 'correct' | 'wrong' | 'partial' | 'inconclusive';
  reason: string;
  generalLesson: string | null;
  // True when the thesis was demonstrably flawed (not "unlucky") so
  // we should supersede it. The model is instructed to set this only
  // when the original reasoning was wrong on the merits, not when
  // a sound thesis lost money to luck or macro.
  supersedeOriginal: boolean;
};

async function gatherContextFor(trade: Trade): Promise<PostMortemContext> {
  if (!trade.agentRunId) {
    return { trade, originalThesis: null, relatedNotes: [] };
  }
  const entries = await prisma.brainEntry.findMany({
    where: {
      userId: trade.userId,
      sourceRunId: trade.agentRunId,
      relatedSymbols: { has: trade.symbol },
    },
    orderBy: { createdAt: 'asc' },
  });
  // The original thesis is the first hypothesis entry written for
  // this symbol during the placement run. Watchlist-add entries
  // (kind='hypothesis', tags including 'watchlist_add') count too —
  // those are where the agent committed its rationale. Fall through
  // to any hypothesis entry if no flagged one exists.
  const originalThesis =
    entries.find((e) => e.category === 'hypothesis') ?? null;
  const relatedNotes = entries.filter((e) => e.id !== originalThesis?.id);
  return { trade, originalThesis, relatedNotes };
}

// Pure helper exported for tests. Rolls a Trade's realized P/L into a
// post-mortem outcome label without hitting Prisma.
export function classifyOutcome(realizedPnlCents: bigint | null): {
  outcome: PostMortemResult['outcome'];
  pnlUsd: number;
  // 0..100 percent magnitude of the win/loss vs cost basis. Used to
  // decide brain confidence (≥10% = decisive = 'high', else 'medium').
  // Caller passes cost basis separately because Trade row doesn't
  // store it directly.
} {
  if (realizedPnlCents == null) return { outcome: 'flat', pnlUsd: 0 };
  const usd = Number(realizedPnlCents) / 100;
  if (usd > 0) return { outcome: 'win', pnlUsd: usd };
  if (usd < 0) return { outcome: 'loss', pnlUsd: usd };
  return { outcome: 'flat', pnlUsd: 0 };
}

// Pure helper exported for tests. Picks the brain confidence level
// from the magnitude of the realized P/L. Decisive moves (10%+ on
// either side) get 'high' confidence — the lesson is unambiguous.
// Smaller moves get 'medium' — the lesson is real but the signal
// could be noise.
export function classifyConfidence(realizedPnlPct: number): 'high' | 'medium' {
  return Math.abs(realizedPnlPct) >= 10 ? 'high' : 'medium';
}

// Render the per-trade prompt body. Opus gets the trade facts, the
// original thesis (if any), and the related brain context, and is
// instructed to return a single JSON object matching PostMortemAnalysis.
function buildAnalysisPrompt(c: PostMortemContext, pnlUsd: number, pnlPct: number): string {
  const t = c.trade;
  const lines: string[] = [
    `Symbol: ${t.symbol}`,
    `Side: ${t.side}, Qty: ${t.qty}`,
    `Submitted: ${t.submittedAt.toISOString()}`,
    `Closed: ${t.closedAt?.toISOString() ?? 'N/A'}`,
    `Realized P/L: $${pnlUsd.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
    '',
    'On-trade thesis (persisted at placement):',
    t.thesis ?? '(none recorded)',
    '',
    'Bull case at placement:',
    t.bullCase ?? '(none recorded)',
    '',
    'Bear case at placement:',
    t.bearCase ?? '(none recorded)',
  ];
  if (c.originalThesis) {
    lines.push('', 'Original brain hypothesis (longer-form rationale):');
    lines.push(c.originalThesis.body);
  }
  if (c.relatedNotes.length > 0) {
    lines.push('', `Other brain context (${c.relatedNotes.length} entries):`);
    for (const n of c.relatedNotes.slice(0, 5)) {
      lines.push(`- ${n.kind}/${n.confidence}: ${n.title}`);
    }
  }
  lines.push(
    '',
    `Return a single JSON object with this shape, no prose, no markdown fences:`,
    `{`,
    `  "thesisAssessment": "correct" | "wrong" | "partial" | "inconclusive",`,
    `  "reason": "1-3 sentences explaining the assessment",`,
    `  "generalLesson": "1-2 sentence transferable lesson, or null if none",`,
    `  "supersedeOriginal": true | false`,
    `}`,
    '',
    'IMPORTANT: set supersedeOriginal=true ONLY when the original reasoning was demonstrably wrong on the merits — a flawed assumption, a missed risk, a misread of the fundamentals. Do NOT set it true when a sound thesis lost money to luck, macro, or a black-swan event. The point of supersession is to retire bad reasoning, not bad outcomes.'
  );
  return lines.join('\n');
}

const POST_MORTEM_SYSTEM = `You are a value-investing post-mortem analyst. Given a closed trade, its original thesis, and the brain context the firm had at placement time, decide whether the thesis was correct, wrong, partial, or inconclusive — and extract the generalizable lesson, if any. Your tone is dry, precise, and hard on flawed reasoning but fair to bad luck. Write for an analyst reading the firm's internal log six months later, not for a client report. Output a single JSON object exactly matching the requested shape.`;

async function analyzeOne(
  client: Anthropic,
  c: PostMortemContext,
  pnlUsd: number,
  pnlPct: number
): Promise<{ analysis: PostMortemAnalysis; costUsd: number }> {
  const resp = await client.messages.create({
    model: TRADE_DECISION_MODEL,
    max_tokens: 4_096,
    system: POST_MORTEM_SYSTEM,
    messages: [
      { role: 'user', content: buildAnalysisPrompt(c, pnlUsd, pnlPct) },
    ],
  });
  const usage = resp.usage as unknown as Record<string, number | undefined>;
  const costUsd = estimateCostUsd(TRADE_DECISION_MODEL, {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  // Tolerate stray markdown fences just in case the model wraps.
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const parsed = JSON.parse(cleaned) as PostMortemAnalysis;
  return { analysis: parsed, costUsd };
}

export type RunPostMortemArgs = {
  userId: string;
  agentRunId: string; // the run that's invoking the post-mortem
  lookbackDays?: number;
};

// Main entry point. Pulls closed trades in the window, runs Opus on
// each, writes the resulting BrainEntry rows, optionally supersedes
// the original thesis. Idempotent: trades already covered by an
// existing post-mortem brain entry (postMortemTradeIds includes
// trade.id) are skipped.
export async function runPostMortem(
  args: RunPostMortemArgs
): Promise<PostMortemResult[]> {
  const lookbackDays = Math.max(1, Math.min(90, args.lookbackDays ?? 7));
  const since = new Date(Date.now() - lookbackDays * 86_400_000);

  const closedTrades = await prisma.trade.findMany({
    where: {
      userId: args.userId,
      closedAt: { gte: since, not: null },
      realizedPnlCents: { not: null },
    },
    orderBy: { closedAt: 'desc' },
    take: MAX_TRADES_PER_POST_MORTEM * 3, // overfetch — some may be deduped
  });

  // Filter out trades already covered by an existing post-mortem
  // entry. One DB query for all candidate IDs.
  const tradeIds = closedTrades.map((t) => t.id);
  const alreadyCovered = await prisma.brainEntry.findMany({
    where: {
      userId: args.userId,
      kind: 'post_mortem',
      postMortemTradeIds: { hasSome: tradeIds },
    },
    select: { postMortemTradeIds: true },
  });
  const coveredIds = new Set<string>(
    alreadyCovered.flatMap((e) => e.postMortemTradeIds)
  );
  const eligible = closedTrades
    .filter((t) => !coveredIds.has(t.id))
    .slice(0, MAX_TRADES_PER_POST_MORTEM);

  if (eligible.length === 0) {
    log.info('post_mortem.no_eligible_trades', {
      userId: args.userId,
      lookbackDays,
      total: closedTrades.length,
      covered: coveredIds.size,
    });
    return [];
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('post_mortem: ANTHROPIC_API_KEY not configured');
  const client = new Anthropic({ apiKey });

  const results: PostMortemResult[] = [];
  for (const trade of eligible) {
    try {
      const ctx = await gatherContextFor(trade);
      const { outcome, pnlUsd } = classifyOutcome(trade.realizedPnlCents);
      // Cost basis derived from qty × avg from the original Trade row.
      // Prefer the position-tracked avgCost when available; fall back
      // to fillPrice × qty for older rows.
      const costBasisCents =
        trade.fillPriceCents != null
          ? Number(trade.fillPriceCents) * trade.qty
          : null;
      const realizedPnlPct =
        costBasisCents && costBasisCents > 0
          ? (pnlUsd * 100) / (costBasisCents / 100)
          : 0;

      const { analysis, costUsd } = await analyzeOne(client, ctx, pnlUsd, realizedPnlPct);
      // Audit C15: record the nested Anthropic call so MTD aggregation
      // sees post-mortem spend. The orchestrator's totalUsage tracker
      // doesn't capture this — it lives inside a tool subroutine that
      // makes its own messages.create call.
      await recordApiSpend({
        userId: args.userId,
        kind: 'post_mortem',
        model: TRADE_DECISION_MODEL,
        costUsd,
        metadata: { tradeId: trade.id, symbol: trade.symbol, outcome },
      });
      const confidence = classifyConfidence(realizedPnlPct);

      const tagSet = ['post_mortem', 'auto-recorded'];
      tagSet.push(outcome);

      const title = `${trade.symbol} post-mortem — ${outcome} ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(0)} (${realizedPnlPct >= 0 ? '+' : ''}${realizedPnlPct.toFixed(1)}%)`;
      const bodyLines: string[] = [
        `**Outcome**: ${outcome.toUpperCase()} — $${pnlUsd.toFixed(2)} (${realizedPnlPct >= 0 ? '+' : ''}${realizedPnlPct.toFixed(1)}%)`,
        `**Thesis assessment**: ${analysis.thesisAssessment}`,
        '',
        analysis.reason,
      ];
      if (analysis.generalLesson) {
        bodyLines.push('', `**Generalizable lesson**: ${analysis.generalLesson}`);
      }

      // Write the post-mortem entry FIRST, then point the original
      // thesis at it via supersededById. Order matters — we need the
      // new entry's id before we can supersede the old one. If the
      // first write succeeds and the second fails, we have a
      // post-mortem-without-supersession (logged), which is the
      // correct degraded state — losing the supersession link is
      // recoverable, but losing the analysis isn't.
      const created = await prisma.brainEntry.create({
        data: {
          userId: args.userId,
          kind: 'post_mortem',
          category: 'memory',
          confidence,
          sourceRunId: args.agentRunId,
          title: title.slice(0, 240),
          body: bodyLines.join('\n').slice(0, 8_000),
          tags: tagSet,
          relatedSymbols: [trade.symbol],
          postMortemTradeIds: [trade.id],
        },
      });

      let superseded = false;
      if (
        analysis.supersedeOriginal &&
        ctx.originalThesis &&
        ctx.originalThesis.id !== created.id
      ) {
        try {
          await prisma.brainEntry.update({
            where: { id: ctx.originalThesis.id },
            data: { supersededById: created.id },
          });
          superseded = true;
        } catch (supersedeErr) {
          log.warn('post_mortem.supersede_failed', {
            userId: args.userId,
            originalId: ctx.originalThesis.id,
            postMortemId: created.id,
            err: (supersedeErr as Error).message,
          });
        }
      }

      log.info('post_mortem.entry_written', {
        userId: args.userId,
        symbol: trade.symbol,
        outcome,
        thesisAssessment: analysis.thesisAssessment,
        superseded,
        brainEntryId: created.id,
        costUsd,
      });

      results.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        outcome,
        realizedPnlUsd: pnlUsd,
        realizedPnlPct,
        brainEntryId: created.id,
        thesisSuperseded: superseded,
        costUsd,
      });
    } catch (err) {
      log.error('post_mortem.trade_failed', err, {
        userId: args.userId,
        tradeId: trade.id,
        symbol: trade.symbol,
      });
      // Continue with the rest — one bad trade shouldn't kill the run.
    }
  }

  return results;
}
