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
import { type FundamentalsSnapshot } from '@/lib/data/sec-edgar';
import { refreshFundamentalsForSymbol } from '@/lib/data/refresh-fundamentals';
import { getResearchFilings, type ResearchFilings } from '@/lib/data/sec-filings';
import { getBars } from '@/lib/alpaca';
import { log } from '@/lib/logger';
import { recordApiSpend } from '@/lib/safety/api-spend-log';

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

Inputs you will receive:
- A fundamentals snapshot (SEC XBRL) — EPS, ROE, margins, debt/equity, etc.
- The current market price.
- The narrative sections of the company's most recent 10-K (Risk Factors + MD&A) and 10-Q (MD&A) where available. These are the company's OWN words about its business and risks.

Constraints:
- Use ONLY the inputs provided. Do not invent facts. If you reference a metric or claim, it must appear in the input.
- When the filing text is provided, USE IT. Cite specific risks the company itself disclosed, specific operational commentary from MD&A. The bear case should pull short-thesis material from the company's own Risk Factors when those rise to a real concern. Generic risks ("regulatory risk, competition") are unacceptable when the filing names specific risks.
- If a fundamentals number looks inconsistent with the company's nature (e.g. an 80%+ gross margin on a commodity producer), flag it as a likely data-extraction issue and do not anchor analysis on it.
- If the input is sparse (no filings, no fundamentals), say so in the summary and lower conviction accordingly.
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

// Build the user-message body — formats fundamentals + price + filing
// text for the model. Pure function exported for tests.
//
// `filings` is the optional W2 addition: when present, the prompt
// includes the latest 10-K's Risk Factors + MD&A and the latest 10-Q's
// MD&A. This is the moat-deepener — chat-Claude doesn't have these
// documents at this granularity, so the agent's analysis can quote
// the company's own language back rather than infer everything from
// a fundamentals snapshot.
export function buildResearchPrompt(args: {
  symbol: string;
  currentPriceUsd: number | null;
  fundamentals: FundamentalsSnapshot | null;
  asOfISO: string;
  filings?: ResearchFilings | null;
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

  // Filing text — Risk Factors + MD&A from the latest 10-K and the
  // most recent 10-Q. Anchor each block with what filing it came
  // from so the model can cite "their FY24 10-K Risk Factors" rather
  // than just "the company says..." in its response.
  if (args.filings) {
    const k = args.filings.latest10K;
    const q = args.filings.latest10Q;
    if (k && (k.riskFactors || k.mda)) {
      lines.push('');
      lines.push(
        `=== Latest 10-K (${k.filing.form}, filed ${k.filing.filingDateISO}, accession ${k.filing.accession}) ===`
      );
      if (k.riskFactors) {
        lines.push('');
        lines.push('--- Item 1A: Risk Factors ---');
        lines.push(k.riskFactors);
      }
      if (k.mda) {
        lines.push('');
        lines.push("--- Item 7: Management's Discussion and Analysis ---");
        lines.push(k.mda);
      }
    }
    if (q && q.mda) {
      lines.push('');
      lines.push(
        `=== Latest 10-Q (filed ${q.filing.filingDateISO}, accession ${q.filing.accession}) ===`
      );
      lines.push('');
      lines.push("--- Item 2: Management's Discussion and Analysis ---");
      lines.push(q.mda);
    }
    if (!k && !q) {
      lines.push('');
      lines.push('SEC filings: (no recent 10-K or 10-Q available for this symbol)');
    }
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

// Callback used by the streaming runner to push events back to the
// caller (the API route, which translates them to SSE for the
// browser). Intentionally tiny + serializable so the route doesn't
// have to know about agent internals.
export type DeepResearchEvent =
  | { type: 'phase'; phase: 'fetching' | 'thinking' | 'writing' | 'persisting' }
  | { type: 'thinking_progress'; chars: number }
  | { type: 'writing_progress'; chars: number }
  | { type: 'done'; result: DeepResearchResult }
  | { type: 'error'; message: string; kind: string };

export type RunDeepResearchArgs = {
  userId: string;
  symbol: string;
  // Optional injection points for tests.
  client?: Anthropic;
  // Stub fundamentals/price/filings in tests.
  fundamentalsOverride?: FundamentalsSnapshot | null;
  currentPriceOverride?: number | null;
  filingsOverride?: ResearchFilings | null;
  // Skip persistence in tests.
  skipPersist?: boolean;
  // Stream consumer. When provided, the runner emits progress events
  // throughout the call so the UI can show "thinking…", "writing…",
  // etc. without waiting for the final answer. Mandatory for the
  // production /api/research/deep route — the streaming is what
  // keeps mobile Safari's fetch alive during long Opus runs.
  onEvent?: (e: DeepResearchEvent) => void;
  // Abort signal — when the consumer (browser modal) cancels, we
  // stop pushing tokens through Opus and tear down cleanly.
  signal?: AbortSignal;
};

function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  if (msg.includes('anthropic') || msg.includes('api key') || msg.includes('api_key'))
    return 'anthropic_auth';
  if (msg.includes('rate') && msg.includes('limit')) return 'rate_limit';
  if (msg.includes('unparseable') || msg.includes('parse')) return 'model_output_parse';
  if (msg.includes('invalid symbol')) return 'invalid_symbol';
  if (msg.includes('timeout') || msg.includes('aborted')) return 'timeout';
  return 'unknown';
}

export async function runDeepResearch(
  args: RunDeepResearchArgs
): Promise<DeepResearchResult> {
  const symbol = args.symbol.toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(symbol)) {
    throw new Error(`Invalid symbol: ${args.symbol}`);
  }

  const client = args.client ?? new Anthropic();
  const asOfISO = new Date().toISOString().slice(0, 10);
  const emit = args.onEvent ?? (() => {});

  emit({ type: 'phase', phase: 'fetching' });

  // Gather inputs in parallel — three external I/O calls, all
  // independent. Filings is the slowest (1 submissions index fetch +
  // up to 2 filing-doc fetches) but we cache aggressively in
  // sec-filings.ts so re-clicks on the same name within a session
  // are cheap. Each call has its own catch — a flaky SEC fetch on
  // filings shouldn't kill the whole research call; the agent can
  // still produce a useful note from fundamentals + price alone.
  //
  // Fundamentals fetch deliberately uses refreshFundamentalsForSymbol
  // (which both fetches AND upserts the Stock catalog row) rather
  // than a bare fetchFundamentals call. Side effect: every Research
  // click also marks the watchlist row as "EDGAR · fresh" and
  // updates the cached fundamentals other surfaces read from. Without
  // this, users who only ever click Research never see the badge
  // refresh and have to remember to hit "Refresh from SEC" separately.
  const [fundamentals, currentPrice, filings] = await Promise.all([
    args.fundamentalsOverride !== undefined
      ? Promise.resolve(args.fundamentalsOverride)
      : refreshFundamentalsForSymbol(symbol)
          .then((r) => r.snapshot ?? null)
          .catch((err) => {
            log.warn('deep_research.fundamentals_failed', { symbol, error: String(err) });
            return null;
          }),
    args.currentPriceOverride !== undefined
      ? Promise.resolve(args.currentPriceOverride)
      : fetchLatestClose(symbol),
    args.filingsOverride !== undefined
      ? Promise.resolve(args.filingsOverride)
      : getResearchFilings(symbol).catch((err) => {
          log.warn('deep_research.filings_failed', { symbol, error: String(err) });
          return null;
        }),
  ]);

  const userPrompt = buildResearchPrompt({
    symbol,
    currentPriceUsd: currentPrice,
    fundamentals,
    asOfISO,
    filings,
  });

  // Adaptive thinking + HIGH effort. Sprint W4 enabled streaming
  // (Server-Sent Events end-to-end, see /api/research/deep/route.ts)
  // so the request stays alive for as long as Opus needs — mobile
  // Safari's ~60s fetch timeout is no longer the bottleneck because
  // the server keeps writing bytes the whole time. 'high' is the
  // right setting for a one-shot research note where reasoning depth
  // matters more than latency. Was 'medium' in the pre-streaming
  // build only because mobile Safari was timing out otherwise.
  // SDK at @anthropic-ai/sdk@0.30.1 doesn't type the new fields;
  // conditional-spread cast keeps the call site clean.
  const adaptiveThinkingParam = {
    thinking: { type: 'adaptive' as const },
    output_config: { effort: 'high' as const },
  } as unknown as Record<string, unknown>;
  const callStart = Date.now();

  // Streaming Opus call. Iterate the raw SSE stream the SDK gives us
  // and route each event:
  //  - thinking deltas → emit thinking_progress events
  //  - text deltas    → accumulate + emit writing_progress events
  //  - usage updates  → captured for the final cost number
  // The text deltas accumulate into `accumText` which we parse at
  // message_stop into the structured output.
  const stream = (await client.messages.create({
    model: TRADE_DECISION_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    stream: true,
    ...adaptiveThinkingParam,
  })) as AsyncIterable<unknown>;

  let accumText = '';
  let thinkingChars = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let phaseEmitted: 'thinking' | 'writing' | null = null;

  for await (const ev of stream) {
    // Cheap defensive abort check — every iteration. The Opus stream
    // can run for a minute+; if the user closed the modal we want to
    // bail before wasting more tokens.
    if (args.signal?.aborted) {
      throw new Error('aborted by client');
    }
    // Untyped events in SDK 0.30.1; keys are stable on the wire.
    const e = ev as {
      type: string;
      content_block?: { type?: string };
      delta?: { type?: string; text?: string; thinking?: string };
      message?: { usage?: Record<string, number> };
      usage?: Record<string, number>;
    };
    if (e.type === 'message_start') {
      const u = e.message?.usage;
      if (u) {
        inputTokens = u.input_tokens ?? inputTokens;
        cacheReadTokens = u.cache_read_input_tokens ?? cacheReadTokens;
        cacheWriteTokens = u.cache_creation_input_tokens ?? cacheWriteTokens;
      }
    } else if (e.type === 'content_block_start') {
      const t = e.content_block?.type;
      if (t === 'thinking' && phaseEmitted !== 'thinking') {
        phaseEmitted = 'thinking';
        emit({ type: 'phase', phase: 'thinking' });
      } else if (t === 'text' && phaseEmitted !== 'writing') {
        phaseEmitted = 'writing';
        emit({ type: 'phase', phase: 'writing' });
      }
    } else if (e.type === 'content_block_delta') {
      const dt = e.delta?.type;
      if (dt === 'thinking_delta' && e.delta?.thinking) {
        thinkingChars += e.delta.thinking.length;
        emit({ type: 'thinking_progress', chars: thinkingChars });
      } else if (dt === 'text_delta' && e.delta?.text) {
        accumText += e.delta.text;
        emit({ type: 'writing_progress', chars: accumText.length });
      }
    } else if (e.type === 'message_delta') {
      const u = e.usage;
      if (u) {
        outputTokens = u.output_tokens ?? outputTokens;
      }
    }
  }

  log.info('deep_research.opus_done', {
    symbol,
    durationMs: Date.now() - callStart,
    thinkingChars,
    outputChars: accumText.length,
  });

  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
  const costUsd = estimateCostUsd(TRADE_DECISION_MODEL, usage);

  const output = parseDeepResearchOutput(accumText);
  if (!output) {
    log.error('deep_research.parse_failed', new Error('parse failed'), {
      symbol,
      rawSnippet: accumText.slice(0, 500),
    });
    throw new Error('Deep research model returned unparseable output');
  }

  emit({ type: 'phase', phase: 'persisting' });

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
          inputs: {
            hasFundamentals: !!fundamentals,
            currentPrice,
            // W2/W3 diagnostic — record what filing context the agent
            // had so we can correlate output quality with input
            // richness when reviewing notes later.
            has10K: !!filings?.latest10K,
            has10KRiskFactors: !!filings?.latest10K?.riskFactors,
            has10KMda: !!filings?.latest10K?.mda,
            has10Q: !!filings?.latest10Q,
            has10QMda: !!filings?.latest10Q?.mda,
            latest10KFilingDate: filings?.latest10K?.filing.filingDateISO ?? null,
            latest10QFilingDate: filings?.latest10Q?.filing.filingDateISO ?? null,
          },
          costUsd,
        }),
        scoreDelta: 0,
      },
    });
    noteId = note.id;
    createdAt = note.createdAt;
    log.info('deep_research.persisted', { userId: args.userId, symbol, noteId, costUsd });
  }

  // Audit C15: record the spend so it shows up in MTD aggregation.
  // Deep-research is user-triggered ($1+ per click), runs outside the
  // agent loop, and historically had no persistence path that the
  // budget enforcer could read.
  await recordApiSpend({
    userId: args.userId,
    kind: 'deep_research',
    model: TRADE_DECISION_MODEL,
    costUsd,
    metadata: { symbol, noteId },
  });

  const result: DeepResearchResult = {
    symbol,
    output,
    costUsd,
    usage,
    noteId,
    createdAtISO: createdAt.toISOString(),
  };
  // Emit terminal event so the caller knows the stream is done +
  // can deliver the final result to the UI.
  emit({ type: 'done', result });
  return result;
}

// Wrapper that converts errors thrown by runDeepResearch into the
// 'error' event shape so the route doesn't have to know about
// classifyError. Always resolves; never throws. Use this from the
// streaming route handler.
export async function runDeepResearchSafe(
  args: RunDeepResearchArgs
): Promise<void> {
  const emit = args.onEvent ?? (() => {});
  try {
    await runDeepResearch(args);
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : 'unknown error';
    emit({ type: 'error', message, kind: classifyError(err) });
    log.error('deep_research.failed', err, { symbol: args.symbol });
  }
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
