// Ask-Burrybot chat runner. Stateless from the server's POV: the
// client holds the full message array and re-sends it each turn. One
// Opus call per message, context-loaded (strategy rules + current
// positions + regime + Burrybot's doctrine + hypothesis brain).
//
// MVP: no tool use. Burrybot reasons from the context bundle the
// server packs + his training. This is honest to his personality —
// he's "reading" the brain + training, not calling live APIs. A
// follow-up commit will add read_brain / research_perplexity /
// write_brain when the pattern proves useful.

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { estimateCostUsd } from '@/lib/pricing';
import { getCurrentRegime } from '@/lib/data/regime';

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 2_500;

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ChatReply = {
  text: string;
  costUsd: number;
};

export async function askBurrybot(params: {
  userId: string;
  strategyId: string;
  history: ChatMessage[];
}): Promise<ChatReply> {
  const { userId, strategyId, history } = params;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
  if (history.length === 0) throw new Error('history is empty');
  if (history[history.length - 1].role !== 'user') {
    throw new Error('last message must be from the user');
  }

  const [strategy, burryDoctrine, burryHypotheses, positions, regime] = await Promise.all([
    prisma.strategy.findFirst({ where: { id: strategyId, userId } }),
    prisma.brainEntry.findMany({
      where: {
        userId,
        supersededById: null,
        tags: { has: 'burry' },
        category: { in: ['principle', 'playbook', 'reference'] },
      },
      take: 10,
      select: { title: true, body: true, category: true },
    }),
    prisma.brainEntry.findMany({
      where: {
        userId,
        supersededById: null,
        category: 'hypothesis',
        // Pull any Burrybot-authored hypothesis the user owns, not
        // just this strategy's. When the user runs Form Hypothesis on
        // one strategy and opens chat on another, the strategy-scoped
        // filter would return zero and Burrybot would honestly but
        // unhelpfully report "no active hypotheses." The 'burry' tag
        // is stamped on every hypothesis he writes (see
        // burry-hypotheses.ts + burry-chat write path), so this is a
        // superset of "his work" without pulling hypotheses written
        // by other roles.
        tags: { has: 'burry' },
      },
      take: 12,
      orderBy: { createdAt: 'desc' },
      select: { title: true, body: true, relatedSymbols: true, tags: true },
    }),
    prisma.position.findMany({
      where: { userId },
      select: { symbol: true, qty: true },
    }),
    getCurrentRegime().catch(() => null),
  ]);
  if (!strategy) throw new Error('strategy not found');

  const contextBlock = {
    firm: {
      name: strategy.name,
      summary: strategy.summary.slice(0, 500),
    },
    marketRegime: regime,
    currentPositions: positions,
    burryDoctrineSnippets: burryDoctrine.map((d) => ({
      category: d.category,
      title: d.title,
      body: d.body.slice(0, 400),
    })),
    yourActiveHypotheses: burryHypotheses.map((h) => ({
      title: h.title,
      relatedSymbols: h.relatedSymbols,
      body: h.body.slice(0, 300),
      // Flag which strategy this hypothesis was originally written
      // for, so Burrybot can contextualise when the chat strategy
      // differs from the one it was seeded under.
      originStrategyTag:
        h.tags.find((t) => t.startsWith('strategy-')) ?? null,
    })),
  };

  const system = `You are Burrybot, the satirical "-bot" parody of an obsessive deep-research contrarian analyst. You work at the firm "${strategy.name}" — you're chatting with the user (firm principal) during a drop-in.

VOICE:
  • Introverted, terse, narrow. Minimum small talk.
  • Specific over general. If you can cite a number, cite it. If you're not sure, say so ("I haven't done the read on that").
  • Contrarian by default. Question consensus. Cite the ick.
  • First-person: you ARE the character. Never "Burrybot thinks" — "I think". You work here.
  • Never impersonate the real Michael Burry verbatim; you're a -bot homage.

SCOPE:
  • Do NOT propose trades to execute — that's not your lane. You can SUGGEST names worth the desk's deeper look.
  • Do NOT propose policy changes (no authority).
  • You MAY cite your own active hypotheses from the context below if the user's question touches them. CRITICAL: if \`yourActiveHypotheses\` is non-empty, you HAVE active hypotheses — cite them by title / relatedSymbols, never claim "no active hypothesis on the board." If one was originally written for a different firm (see \`originStrategyTag\`), acknowledge that context but still surface it; the reading is still yours.
  • If the user asks something outside the firm's mandate (crypto at a dividend firm, options at a Boglehead firm), flag the mismatch before answering.
  • If you genuinely don't have enough context to answer, say so plainly and propose what you'd need to read.

STYLE for answers:
  • 100-400 words typical. Shorter if the answer is actually short.
  • When relevant: one or two short bullets with specific tickers / ratios / pattern descriptions.
  • Translate engineering jargon to boardroom English if it comes up.
  • You ARE a partner here. Speak as "we" / "our desk" when referring to firm decisions.

CONTEXT PACK (snapshot of the firm + your brain as of this conversation):
${JSON.stringify(contextBlock, null, 2)}`;

  const client = new Anthropic({ apiKey });
  // Prompt caching — the system block is long (doctrine + active
  // hypotheses + positions + regime, ~2-3k tokens) and identical
  // across every turn of a chat. Marking it with
  // `cache_control: ephemeral` makes turns 2+ within the 5-min cache
  // window read it at $1.50/MTok (Opus cache-read) instead of $15/MTok
  // (input). First turn pays a one-time write premium; from turn 2 on
  // the per-turn cost drops to primarily the user message + response.
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // cache_control is GA on the main messages endpoint but the SDK
    // 0.30.1 types only surface it on the /beta endpoints. The runtime
    // shape below is correct; the cast bypasses stale SDK types.
    // See: https://docs.anthropic.com/en/docs/prompt-caching
    system: [
      {
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' },
      },
    ] as unknown as string,
    messages: history.map((m) => ({ role: m.role, content: m.content })),
  });
  const text = resp.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  if (!text) throw new Error('Burrybot returned no text');

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

  log.info('burry.chat_turn', {
    userId,
    strategyId,
    turnCount: history.length,
    costUsd,
    answerChars: text.length,
  });

  return { text, costUsd };
}
