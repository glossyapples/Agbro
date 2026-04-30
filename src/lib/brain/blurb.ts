// Plain-English summarizer for brain entries on the home Brain card.
//
// The agent writes brain entries in dense analyst speak — full
// numbers, mandate citations, capital-structure ratios. Great for the
// /brain page where a serious user is reading carefully. Wrong for
// the home card where an Auto-mode user just glances.
//
// Solution: lazily generate a plain-English one-liner with Haiku 4.5
// the first time an entry is rendered on the home page. Cache on the
// row (homeBlurb column on BrainEntry); brain entries are immutable
// so the cache is forever. Cost per entry: ~$0.001 (typical input
// ~600 tokens body + 300 token system + ~30 token output, all on
// Haiku 4.5 = $1/MTok input, $5/MTok output).
//
// Failure behavior: if the Anthropic call fails or returns garbage,
// we don't write anything to the row. Next render retries. The
// caller falls back to a body excerpt so the card never goes blank.

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { FAST_MODEL } from '@/lib/agents/models';
import { log } from '@/lib/logger';
import { recordApiSpend } from '@/lib/safety/api-spend-log';

// Average cost per blurb at typical input/output token counts. We use
// a constant rather than tracking per-call usage because the Haiku
// `usage` object isn't always returned and the aggregate signal we
// want (frequency × average) is what matters for the budget — not a
// fraction-of-a-cent granularity per row.
const BLURB_AVG_COST_USD = 0.001;

const SYSTEM_PROMPT = `You are summarizing a single trading-agent brain entry for display on the user's home page card. The user wants to see at a glance what the agent learned or did, without reading the full analyst-style entry.

Constraints:
- ONE sentence, max 110 characters.
- Plain English. Active voice. No analyst jargon, no abbreviations the user wouldn't recognize, no precise dollar amounts unless they're the punchline.
- Lead with the verb when possible: "Sold X because Y", "Realized Z about W", "Held off on T pending U".
- If the entry is a post-mortem or insight: focus on the LESSON or the DECISION, not the numbers.
- If the entry is a run summary: focus on what the agent DID, not the play-by-play.
- If multiple symbols are involved, group them ("Sold WEN and UEC — neither fit Quality Compounders mandate").
- No leading "The agent...". The user knows it's the agent.

Return ONLY the sentence. No quotes, no markdown, no preface.`;

export async function generateBrainBlurb(args: {
  title: string;
  body: string;
  kind: string;
  client?: Anthropic;
}): Promise<string | null> {
  const client = args.client ?? new Anthropic();
  // Truncate body to 4000 chars to bound input cost. The summarizer
  // doesn't need the whole entry — the title plus first few paragraphs
  // carry enough signal for a one-liner.
  const trimmed = args.body.length > 4000 ? args.body.slice(0, 4000) + '\n[truncated]' : args.body;

  try {
    const resp = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            `Brain entry kind: ${args.kind}\n\n` +
            `Title: ${args.title}\n\n` +
            `Body:\n${trimmed}\n\n` +
            `Return the one-sentence home-card summary now.`,
        },
      ],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) return null;
    // Strip any wrapping quotes the model may add despite the rule.
    const cleaned = text.replace(/^["'`]|["'`]$/g, '').trim();
    if (cleaned.length === 0) return null;
    // Hard cap at 200 chars in case the model ignored the 110 hint.
    return cleaned.length > 200 ? cleaned.slice(0, 200).trimEnd() + '…' : cleaned;
  } catch (err) {
    log.warn('brain.blurb_generation_failed', {
      kind: args.kind,
      title: args.title,
      error: String(err),
    });
    return null;
  }
}

// Read-or-generate. If the entry already has a homeBlurb, return it.
// Otherwise generate via Haiku, persist, and return. On generation
// failure, returns null and lets the caller fall back to a body
// excerpt.
//
// Idempotent across concurrent calls in practice — Haiku is fast
// enough that a duplicate render firing in parallel just wastes one
// extra ~$0.001 call before the second writer wins. Not worth
// adding a row-level lock.
export async function ensureBrainBlurb(entry: {
  id: string;
  userId: string;
  title: string;
  body: string;
  kind: string;
  homeBlurb: string | null;
}): Promise<string | null> {
  if (entry.homeBlurb && entry.homeBlurb.trim().length > 0) {
    return entry.homeBlurb;
  }
  const blurb = await generateBrainBlurb({
    title: entry.title,
    body: entry.body,
    kind: entry.kind,
  });
  if (!blurb) return null;
  // Audit C15: record the Haiku spend even though it's tiny ($0.001/call).
  // Aggregate-friendly: kind='brain_blurb' lets us track frequency over
  // time independent of the cost.
  await recordApiSpend({
    userId: entry.userId,
    kind: 'brain_blurb',
    model: FAST_MODEL,
    costUsd: BLURB_AVG_COST_USD,
    metadata: { entryId: entry.id, brainKind: entry.kind },
  });
  // Persist for next render. Best-effort — if the write fails (rare),
  // we still return the blurb for this render and try again next
  // time.
  await prisma.brainEntry
    .update({
      where: { id: entry.id },
      data: { homeBlurb: blurb },
    })
    .catch((err) => {
      log.warn('brain.blurb_persist_failed', {
        entryId: entry.id,
        error: String(err),
      });
    });
  return blurb;
}

// Fallback for use when the blurb hasn't been generated yet (or
// generation failed) — extracts the first sentence-ish chunk of the
// body so the home card has something readable while the lazy blurb
// catches up. Pure helper exported for tests.
export function bodyExcerpt(body: string, maxChars = 140): string {
  const trimmed = body.trim();
  if (trimmed.length <= maxChars) return trimmed;
  // Try to break at sentence end, fall through to char cap.
  const slice = trimmed.slice(0, maxChars);
  const lastSentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
  if (lastSentenceEnd > maxChars / 2) {
    return slice.slice(0, lastSentenceEnd + 1);
  }
  return slice.trimEnd() + '…';
}
