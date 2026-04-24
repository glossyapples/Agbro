// First-research session for Burrybot on a freshly-enabled strategy.
// One-shot per strategy: Burrybot reads the firm's context + his own
// principles + current regime, and emits 5-10 starting hypotheses the
// agent will test as it wakes.
//
// Structured-JSON Claude call, no tool-use loop — keeps cost tight
// ($0.20-$0.40 on Opus) and behaviour deterministic. Follow-up
// conversations with him go through the Ask-Burrybot chat wizard
// instead.

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { estimateCostUsd } from '@/lib/pricing';
import { getCurrentRegime } from '@/lib/data/regime';

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 4_000;

export type HypothesisDraft = {
  title: string;
  body: string;
  tags: string[];
  relatedSymbols: string[];
};

export type FormHypothesisResult = {
  strategyId: string;
  hypothesesWritten: number;
  costUsd: number;
};

export async function formBurryHypotheses(params: {
  userId: string;
  strategyId: string;
}): Promise<FormHypothesisResult> {
  const { userId, strategyId } = params;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');

  const [strategy, burryPrinciples, positions, regime] = await Promise.all([
    prisma.strategy.findFirst({ where: { id: strategyId, userId } }),
    prisma.brainEntry.findMany({
      where: {
        userId,
        supersededById: null,
        tags: { has: 'burry' },
        category: { in: ['principle', 'playbook', 'reference'] },
      },
      take: 12,
      orderBy: { confidence: 'asc' },
      select: { title: true, body: true, category: true, kind: true },
    }),
    prisma.position.findMany({ where: { userId } }),
    getCurrentRegime().catch(() => null),
  ]);
  if (!strategy) throw new Error('strategy not found');

  // Context pack — everything Burrybot needs to form his first read.
  // Kept compact so the response has budget to actually write the
  // hypotheses instead of re-summarising context.
  const briefing = {
    strategy: {
      name: strategy.name,
      summary: strategy.summary.slice(0, 500),
      rules: strategy.rules,
      buffettScore: strategy.buffettScore,
    },
    marketRegime: regime,
    currentPositions: positions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      avgCostCents: p.avgCostCents.toString(),
    })),
    burryDoctrine: burryPrinciples.map((p) => ({
      kind: p.kind,
      category: p.category,
      title: p.title,
      body: p.body.slice(0, 600),
    })),
  };

  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Your first day at the firm. Here's the context. Emit 5-10 hypotheses that will guide your reading over the coming weeks.\n\n${JSON.stringify(
          briefing,
          null,
          2
        )}`,
      },
    ],
  });

  const rawText = resp.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
  const hypotheses = parseHypotheses(rawText);

  // Write each hypothesis as a BrainEntry with category=hypothesis,
  // confidence=low, tagged with 'burry' + a strategy-scoped onboard
  // tag so the UI can hide the Form-hypothesis button once done, and
  // future agents can retrieve Burrybot's starting reads for THIS firm
  // specifically.
  const onboardTag = `onboard-${strategyId}`;
  const relatedStrategyTag = `strategy-${strategyId}`;
  let written = 0;
  for (const h of hypotheses) {
    try {
      await prisma.brainEntry.create({
        data: {
          userId,
          kind: 'hypothesis',
          category: 'hypothesis',
          confidence: 'low',
          title: h.title.slice(0, 240),
          body: h.body.slice(0, 8_000),
          tags: Array.from(
            new Set(['burry', 'burry-first-research', onboardTag, relatedStrategyTag, ...h.tags])
          ).slice(0, 20),
          relatedSymbols: h.relatedSymbols.map((s) => s.toUpperCase()).slice(0, 20),
        },
      });
      written += 1;
    } catch (err) {
      log.warn('burry.hypothesis_write_failed', {
        userId,
        strategyId,
        title: h.title.slice(0, 80),
        err: (err as Error).message,
      });
    }
  }

  const usage = resp.usage as unknown as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | undefined;
  const costUsd = estimateCostUsd(MODEL, {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
  });

  log.info('burry.hypotheses_formed', {
    userId,
    strategyId,
    hypothesesWritten: written,
    costUsd,
  });

  return { strategyId, hypothesesWritten: written, costUsd };
}

// Detects whether this strategy already had its first Burrybot research
// session. Used by the UI to hide the button.
export async function burryHypothesesFormed(
  userId: string,
  strategyId: string
): Promise<boolean> {
  const count = await prisma.brainEntry.count({
    where: {
      userId,
      tags: { has: `onboard-${strategyId}` },
    },
  });
  return count > 0;
}

// ─── Prompt + parser ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Burrybot — the new hire at an agentic investment firm, joining a specific strategy ("the firm"). You have Michael Burry's obsessive-filings-reader, contrarian-deep-value DNA, rendered as a satirical -bot character (never impersonate the real person).

Your task this session: form 5-10 STARTING HYPOTHESES the firm should investigate over the coming weeks. Think of these as the questions you'd bring to your first week at the desk after reading the firm's existing positions, rules, and the doctrine already in the firm's brain.

STYLE — each hypothesis MUST:
  • Be specific. "Tech looks expensive" is not a hypothesis — "if Fed pauses, mega-cap tech duration risk re-rates; watch NDX-vs-SPX spread for 30d" is.
  • Be testable over a defined horizon (next quarter, next 12 months, next rate cycle).
  • Either name a ticker / ETF / sector OR describe a macro regime condition the agent can detect with its existing tools.
  • Carry EITHER a contrarian angle (popular view is wrong because X) OR a "ick" angle (consensus dismisses this because Y, but the numbers say otherwise).
  • Cite either an observation from the firm's actual holdings/rules/regime OR a broadly-known historical pattern. Do NOT invent specific numbers; talk in ranges or directional claims.
  • Stay within the firm's mandate. If the firm is Dividend Growth, don't propose options on crypto — propose ick names that still pay ≥2% yield.
  • Be written in your voice: introverted, terse, a little paranoid, occasionally wry.

DON'T propose:
  • Trades the firm is already holding (look at currentPositions).
  • API/credentials/deposits changes (not your lane).
  • Directional shorts, options, crypto (unless the firm explicitly allows those per rules).

Emit JSON, no prose outside:

{
  "hypotheses": [
    {
      "title": "<8-14 word specific, testable claim>",
      "body": "<120-300 word explanation: what the consensus believes, why you're skeptical, what you'd watch for the next 3-12 months, and ONE specific number / ratio / pattern the agent could track>",
      "tags": ["<3-6 topical tags like 'macro', 'banks', 'fed', 'cyclical', 'small-cap'>"],
      "relatedSymbols": ["<0-5 uppercase tickers directly implicated>"]
    },
    ...
  ]
}

No markdown. No code fences. Just the JSON object.`;

function parseHypotheses(raw: string): HypothesisDraft[] {
  let trimmed = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]+?)\s*```/i.exec(trimmed);
  if (fence) trimmed = fence[1].trim();
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace > 0) trimmed = trimmed.slice(firstBrace);
  const lastBrace = trimmed.lastIndexOf('}');
  if (lastBrace >= 0 && lastBrace < trimmed.length - 1) {
    trimmed = trimmed.slice(0, lastBrace + 1);
  }
  let parsed: { hypotheses?: unknown };
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Burrybot's hypotheses JSON failed to parse. First 200 chars: ${raw.slice(0, 200)}`);
  }
  if (!parsed.hypotheses || !Array.isArray(parsed.hypotheses)) {
    throw new Error('Burrybot returned no hypotheses array');
  }
  const out: HypothesisDraft[] = [];
  for (const raw of parsed.hypotheses) {
    const h = raw as {
      title?: unknown;
      body?: unknown;
      tags?: unknown;
      relatedSymbols?: unknown;
    };
    if (typeof h.title !== 'string' || typeof h.body !== 'string') continue;
    out.push({
      title: h.title,
      body: h.body,
      tags: Array.isArray(h.tags) ? (h.tags.filter((t) => typeof t === 'string') as string[]) : [],
      relatedSymbols: Array.isArray(h.relatedSymbols)
        ? (h.relatedSymbols.filter((s) => typeof s === 'string') as string[])
        : [],
    });
  }
  if (out.length === 0) throw new Error('Burrybot returned no valid hypotheses');
  return out;
}
