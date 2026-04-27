// Deep Research agent. Single-symbol, on-demand: the user clicks
// "Research" on a holding, this module fetches what's knowable about
// the company (fundamentals via SEC XBRL + recent price), asks Opus
// 4.7 with extended thinking to write a structured research note,
// persists it as a ResearchNote, and returns the parsed output for
// the UI to render.
//
// What this is NOT (yet): the bulk walk-forward research engine
// scoped in the sprint plan. This is the smallest end-to-end version
// — visible in the live app on day one — so the user can iterate on
// output quality on real holdings before we spend bulk-validation
// budget. v2 layers in full 10-K / 10-Q filing text from EDGAR; v1
// runs on fundamentals + price context, which is already richer than
// what a chat-Claude session has access to (it's the live portfolio's
// numbers, persisted, and tied to a real symbol the user owns).
//
// Cost target per call: ~$0.50-1.50 with Opus 4.7 + 8k thinking +
// 4k output. Hard cap on max_tokens enforced below so a runaway
// generation can't burn $10 on one click.

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { TRADE_DECISION_MODEL } from './models';
import { estimateCostUsd, type TokenUsage } from '@/lib/pricing';
import { fetchFundamentals, type FundamentalsSnapshot } from '@/lib/data/sec-edgar';
import { getBars } from '@/lib/alpaca';
import { log } from '@/lib/logger';

// 8k thinking + 4k output = ~$0.75 worst-case with Opus 4.7. Capped
// so a single click can't blow the budget. Adaptive thinking on
// Opus 4.7 manages its own budget given an effort level — we set
// max_tokens to a generous upper bound and let the model use what
// it needs.
const MAX_OUTPUT_TOKENS = 12_000;

export type DeepResearchOutput = {
  thesis: string;
  convictionScore: number; // 0-100
  bullCase: string;
  bearCase: string;
  summary: string; // 2-4 paragraph deep-dive
  killCriteria: string[];
  primaryRisks: string[];
};

export type DeepResearchResult = {
  symbol: string;
  output: DeepResearchOutput;
  costUsd: number;
  usage: TokenUsage;
  noteId: string;
  createdAtISO: string;
};

const SYSTEM_PROMPT = `You are a fundamental equity research analyst writing a structured note for a single stock. Your reader is a retail investor who already holds (or is considering) this name and wants a clear-eyed assessment, not marketing copy.

Tone: dry, precise, hard on the company's weaknesses. Write the bear case as if you were short, not as a token disclaimer. Conviction reflects strength of evidence, not enthusiasm — a name with limited public information should score lower regardless of how attractive the surface metrics look.

Constraints:
- Use ONLY the inputs provided in the user message. Do not invent facts about the company. If you reference a metric, it must appear in the input.
- If the input is sparse (no fundamentals, no recent price), say so in the summary and lower conviction accordingly.
- killCriteria are specific, measurable triggers (e.g. "ROE drops below 12% for 2 consecutive quarters", "Free cash flow turns negative") — not vague risks.
- Output a single JSON object matching the schema. No prose, no markdown fences, no leading explanation.`;

const OUTPUT_SCHEMA_INSTRUCTION = `Return ONLY this JSON object (no prose, no fences):
{
  "thesis": "1-2 sentence one-line summary of why to own (or not)",
  "convictionScore": integer 0-100,
  "bullCase": "1-2 paragraphs — strongest reasons to own",
  "bearCase": "1-2 paragraphs — strongest reasons NOT to own, written as a short-seller would",
  "summary": "2-4 paragraph deep-dive synthesizing the inputs",
  "killCriteria": ["specific measurable trigger 1", "trigger 2", "trigger 3"],
  "primaryRisks": ["concrete risk 1", "risk 2", "risk 3"]
}`;

// Build the user-message body — formats fundamentals + price context
// for the model. Pure function exported for tests.
export function buildResearchPrompt(args: {
  symbol: string;
  currentPriceUsd: number | null;
  fundamentals: FundamentalsSnapshot | null;
  asOfISO: string;
}): string {
  const lines: string[] = [];
  lines.push(`Symbol: ${args.symbol}`);
  lines.push(`As of: ${args.asOfISO}`);
  lines.push(
    `Current price: ${args.currentPriceUsd != null ? `$${args.currentPriceUsd.toFixed(2)}` : '(not available)'}`
  );
  lines.push('');

  if (args.fundamentals) {
    const f = args.fundamentals;
    lines.push(`Latest reported fundamentals (SEC XBRL, as of ${f.asOf}):`);
    if (f.epsTTM != null) lines.push(`  EPS (TTM): $${f.epsTTM.toFixed(2)}`);
    // Compute P/E inline since FundamentalsSnapshot doesn't carry it.
    if (f.epsTTM != null && f.epsTTM > 0 && args.currentPriceUsd != null) {
      lines.push(`  Implied P/E (price/EPS): ${(args.currentPriceUsd / f.epsTTM).toFixed(1)}`);
    }
    if (f.returnOnEquityPct != null)
      lines.push(`  Return on equity: ${f.returnOnEquityPct.toFixed(1)}%`);
    if (f.debtToEquity != null) lines.push(`  Debt/equity: ${f.debtToEquity.toFixed(2)}`);
    if (f.grossMarginPct != null) lines.push(`  Gross margin: ${f.grossMarginPct.toFixed(1)}%`);
    if (f.revenues != null)
      lines.push(`  Revenue (TTM): $${(f.revenues / 1_000_000_000).toFixed(2)}B`);
    if (f.netIncome != null)
      lines.push(`  Net income (TTM): $${(f.netIncome / 1_000_000_000).toFixed(2)}B`);
    if (f.bookValuePerShare != null)
      lines.push(`  Book value/share: $${f.bookValuePerShare.toFixed(2)}`);
    if (f.dividendPerShare != null) {
      lines.push(`  Dividend/share: $${f.dividendPerShare.toFixed(2)}`);
      if (args.currentPriceUsd != null && args.currentPriceUsd > 0) {
        lines.push(
          `  Implied dividend yield: ${((f.dividendPerShare / args.currentPriceUsd) * 100).toFixed(2)}%`
        );
      }
    }
    if (f.totalDebt != null && f.totalEquity != null) {
      lines.push(
        `  Capital structure: $${(f.totalDebt / 1_000_000_000).toFixed(2)}B debt / $${(f.totalEquity / 1_000_000_000).toFixed(2)}B equity`
      );
    }
    if (f.epsGrowthPct5y != null)
      lines.push(`  5-yr EPS growth: ${f.epsGrowthPct5y.toFixed(1)}%`);
    if (f.missingFields.length > 0) {
      lines.push(`  (XBRL extraction missed: ${f.missingFields.join(', ')})`);
    }
  } else {
    lines.push('Latest reported fundamentals: (not available — SEC EDGAR returned no XBRL facts for this symbol)');
  }

  lines.push('');
  lines.push(OUTPUT_SCHEMA_INSTRUCTION);
  return lines.join('\n');
}

// Tolerant JSON parser. Strips markdown fences if the model wraps
// despite the instruction; extracts the first balanced object.
export function parseDeepResearchOutput(raw: string): DeepResearchOutput | null {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  const start = stripped.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (
      typeof parsed?.thesis === 'string' &&
      typeof parsed?.convictionScore === 'number' &&
      typeof parsed?.bullCase === 'string' &&
      typeof parsed?.bearCase === 'string' &&
      typeof parsed?.summary === 'string' &&
      Array.isArray(parsed?.killCriteria) &&
      Array.isArray(parsed?.primaryRisks)
    ) {
      return parsed as DeepResearchOutput;
    }
    return null;
  } catch {
    return null;
  }
}

export type RunDeepResearchArgs = {
  userId: string;
  symbol: string;
  // Optional injection points for tests.
  client?: Anthropic;
  // Stub fundamentals/price in tests.
  fundamentalsOverride?: FundamentalsSnapshot | null;
  currentPriceOverride?: number | null;
  // Skip persistence in tests.
  skipPersist?: boolean;
};

export async function runDeepResearch(
  args: RunDeepResearchArgs
): Promise<DeepResearchResult> {
  const symbol = args.symbol.toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(symbol)) {
    throw new Error(`Invalid symbol: ${args.symbol}`);
  }

  const client = args.client ?? new Anthropic();
  const asOfISO = new Date().toISOString().slice(0, 10);

  // Gather inputs in parallel — both are external I/O and independent.
  const [fundamentals, currentPrice] = await Promise.all([
    args.fundamentalsOverride !== undefined
      ? Promise.resolve(args.fundamentalsOverride)
      : fetchFundamentals(symbol).catch((err) => {
          log.warn('deep_research.fundamentals_failed', { symbol, error: String(err) });
          return null;
        }),
    args.currentPriceOverride !== undefined
      ? Promise.resolve(args.currentPriceOverride)
      : fetchLatestClose(symbol),
  ]);

  const userPrompt = buildResearchPrompt({
    symbol,
    currentPriceUsd: currentPrice,
    fundamentals,
    asOfISO,
  });

  // Adaptive thinking + medium effort. Opus 4.7's API requires the
  // adaptive shape (older `thinking.type: 'enabled'` is rejected).
  // Effort='medium' keeps end-to-end latency under ~30s for a typical
  // call, which is below mobile Safari's fetch timeout (~60s on
  // cellular). 'high' produced "Load failed" timeouts on iPhone for
  // slow names. Switch back up to 'high' if we ship a streaming /
  // background-job version that keeps the connection alive.
  // SDK at @anthropic-ai/sdk@0.30.1 doesn't type the new fields;
  // conditional-spread cast keeps the call site clean.
  const adaptiveThinkingParam = {
    thinking: { type: 'adaptive' as const },
    output_config: { effort: 'medium' as const },
  } as unknown as Record<string, unknown>;
  const callStart = Date.now();
  const resp = await client.messages.create({
    model: TRADE_DECISION_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    ...adaptiveThinkingParam,
  });
  log.info('deep_research.opus_done', {
    symbol,
    durationMs: Date.now() - callStart,
  });

  const u = resp.usage as unknown as Record<string, number | undefined>;
  const usage: TokenUsage = {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
  const costUsd = estimateCostUsd(TRADE_DECISION_MODEL, usage);

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const output = parseDeepResearchOutput(text);
  if (!output) {
    log.error('deep_research.parse_failed', new Error('parse failed'), {
      symbol,
      rawSnippet: text.slice(0, 500),
    });
    throw new Error('Deep research model returned unparseable output');
  }

  let noteId = '';
  let createdAt = new Date();
  if (!args.skipPersist) {
    const note = await prisma.researchNote.create({
      data: {
        symbol,
        topic: `Deep research — ${symbol}`,
        source: 'claude',
        bullCase: output.bullCase,
        bearCase: output.bearCase,
        summary: output.summary,
        rawExcerpt: JSON.stringify({
          thesis: output.thesis,
          convictionScore: output.convictionScore,
          killCriteria: output.killCriteria,
          primaryRisks: output.primaryRisks,
          inputs: { hasFundamentals: !!fundamentals, currentPrice },
          costUsd,
        }),
        scoreDelta: 0,
      },
    });
    noteId = note.id;
    createdAt = note.createdAt;
    log.info('deep_research.persisted', { userId: args.userId, symbol, noteId, costUsd });
  }

  return {
    symbol,
    output,
    costUsd,
    usage,
    noteId,
    createdAtISO: createdAt.toISOString(),
  };
}

async function fetchLatestClose(symbol: string): Promise<number | null> {
  // Look back 7 days to catch the most recent trading day even if
  // today is a weekend / holiday.
  const endMs = Date.now();
  const startMs = endMs - 7 * 86_400_000;
  try {
    const bars = await getBars(symbol, '1Day', startMs, endMs);
    if (!bars || bars.length === 0) return null;
    return bars[bars.length - 1].close ?? null;
  } catch (err) {
    log.warn('deep_research.price_fetch_failed', { symbol, error: String(err) });
    return null;
  }
}
