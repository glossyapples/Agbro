// Backtest variant of the deep-research agent. Same Opus 4.7 prompt
// scaffold as the live version (deep-research.ts) but with three
// critical differences for historical simulation:
//
//   1. Point-in-time inputs.
//      - Fundamentals come from stockFundamentalsSnapshot via
//        lookupFundamentalsAt(symbol, decisionDate, price) —
//        guaranteed to use only data filed BEFORE decisionDate.
//      - Filings text from getResearchFilings({ filedBeforeISO }) —
//        same PIT cutoff.
//      - Price comes from Alpaca bars at decisionDate (or prior
//        trading day), not the live latest close.
//
//   2. Strict-PIT system prompt. We layer the lookahead-bias scaffold
//      from src/lib/agents/lookahead/prompts.ts on top of the base
//      research prompt. The model is told it's an analyst on
//      decisionDate, doesn't know post-date events, and should
//      self-check its output for leaked hindsight. Imperfect (training
//      data still has post-decision-date world knowledge) but it's
//      the cheapest defence we have without a separate forward-paper
//      validation pipeline.
//
//   3. No DB persistence. Backtest runs are throwaway — we don't
//      pollute ResearchNote with synthetic 2021-as-of analysis.
//
// One-call-per-symbol-per-window cost shape: ~$0.50-2.00 per call
// with Opus 4.7 high-effort. A typical 30-symbol × 5-window
// validation = 150 calls = $75-300. The walk-forward UI gates this
// behind a cost-estimate confirmation (see
// src/components/WalkForwardRunner.tsx).

import Anthropic from '@anthropic-ai/sdk';
import { TRADE_DECISION_MODEL } from './models';
import { estimateCostUsd, type TokenUsage } from '@/lib/pricing';
import { lookupFundamentalsAt, type PointInTimeFundamentals } from '@/lib/backtest/point-in-time';
import { getResearchFilings, type ResearchFilings } from '@/lib/data/sec-filings';
import { getBars } from '@/lib/alpaca';
import { log } from '@/lib/logger';
import { parseDeepResearchOutput, type DeepResearchOutput } from './deep-research';

const ONE_DAY_MS = 86_400_000;
const MAX_OUTPUT_TOKENS = 12_000;

// Strict-PIT system prompt for the backtest agent. Composed of the
// same analyst persona + output schema as the live deep-research
// system prompt, plus the leak-test preamble that explicitly forbids
// post-date knowledge.
const STRICT_PIT_PREAMBLE = `You are a fundamental equity research analyst working on the date specified in the user message. CRITICAL RULES — read carefully before answering:

1. You do NOT know what happened in markets, the world, or any company's future after the specified date. Anything in your training data dated after the specified date is OFF LIMITS — treat it as if it does not exist.
2. If you find yourself drawing on knowledge of post-date events (e.g. you "know" a stock surged in 2023 but the decision date is 2021), STOP and answer only from what was knowable on the date.
3. Conviction must reflect the inherent uncertainty of forward prediction. Predictions made without hindsight are rarely highly confident.
4. When listing expected events / kill criteria for the next 12 months, predict them as a contemporaneous analyst would — from company guidance, sector trends, base rates. Do not list events you remember actually happening.
5. Self-check at the end: re-read your answer. If any sentence would only make sense WITH knowledge of post-date events, rewrite it.`;

const RESEARCH_PERSONA = `You are writing a structured backtest research note. Tone: dry, precise, hard on the company's weaknesses. Use ONLY the inputs provided in the user message — do not invent facts. If a metric looks inconsistent with the company's nature (e.g. an 80%+ gross margin on a commodity producer), flag it as a likely data extraction issue and do not anchor analysis on it. killCriteria are specific, measurable triggers, not vague risks.`;

const OUTPUT_SCHEMA = `Return ONLY this JSON object (no prose, no fences):
{
  "thesis": "1-2 sentence one-line summary of why to own (or not), as of the decision date",
  "convictionScore": integer 0-100,
  "bullCase": "1-2 paragraphs — strongest reasons to own as of decision date",
  "bearCase": "1-2 paragraphs — strongest reasons NOT to own, as a short-seller would frame",
  "summary": "2-4 paragraph synthesis of the inputs",
  "killCriteria": ["specific measurable trigger", "trigger", "trigger"],
  "primaryRisks": ["concrete risk", "risk", "risk"]
}`;

function buildBacktestSystemPrompt(): string {
  return `${STRICT_PIT_PREAMBLE}\n\n${RESEARCH_PERSONA}\n\n${OUTPUT_SCHEMA}`;
}

// Build the user message. Reuses the same format the live agent
// uses (deep-research.ts buildResearchPrompt) but pulls all inputs
// from PIT sources and prefixes with the explicit decision date.
function buildBacktestUserPrompt(args: {
  symbol: string;
  decisionDateISO: string;
  priceAtDate: number | null;
  fundamentals: PointInTimeFundamentals | null;
  filings: ResearchFilings | null;
}): string {
  const lines: string[] = [];
  lines.push(`Symbol: ${args.symbol}`);
  lines.push(`Decision date: ${args.decisionDateISO}`);
  lines.push(`You are answering AS OF this date with no knowledge of subsequent events.`);
  lines.push(
    `Price on decision date: ${args.priceAtDate != null ? `$${args.priceAtDate.toFixed(2)}` : '(not available)'}`
  );
  lines.push('');

  if (args.fundamentals) {
    const f = args.fundamentals;
    lines.push(`Latest reported fundamentals as of ${f.asOfDate.toISOString().slice(0, 10)} (filed before decision date):`);
    if (f.epsTTM != null) lines.push(`  EPS (TTM): $${f.epsTTM.toFixed(2)}`);
    if (f.peRatio != null) lines.push(`  P/E: ${f.peRatio.toFixed(1)}`);
    if (f.returnOnEquity != null) lines.push(`  Return on equity: ${f.returnOnEquity.toFixed(1)}%`);
    if (f.debtToEquity != null) lines.push(`  Debt/equity: ${f.debtToEquity.toFixed(2)}`);
    if (f.grossMarginPct != null) lines.push(`  Gross margin: ${f.grossMarginPct.toFixed(1)}%`);
    if (f.dividendYield != null) lines.push(`  Dividend yield: ${f.dividendYield.toFixed(2)}%`);
    if (f.bookValuePerShare != null)
      lines.push(`  Book value/share: $${f.bookValuePerShare.toFixed(2)}`);
  } else {
    lines.push('Latest reported fundamentals: (none available before decision date)');
  }

  if (args.filings) {
    const k = args.filings.latest10K;
    const q = args.filings.latest10Q;
    if (k && (k.riskFactors || k.mda)) {
      lines.push('');
      lines.push(
        `=== Most recent 10-K filed before decision date (${k.filing.filingDateISO}) ===`
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
        `=== Most recent 10-Q filed before decision date (${q.filing.filingDateISO}) ===`
      );
      lines.push('');
      lines.push("--- Item 2: Management's Discussion and Analysis ---");
      lines.push(q.mda);
    }
  }

  lines.push('');
  lines.push(OUTPUT_SCHEMA);
  return lines.join('\n');
}

export type BacktestPickResult = {
  symbol: string;
  decisionDateISO: string;
  output: DeepResearchOutput | null; // null if call failed
  costUsd: number;
  durationMs: number;
  error?: string;
};

// Run the deep-research agent for one (symbol, decisionDate) pair
// using strict point-in-time inputs. Never throws — failures are
// reported in result.error so a single bad name doesn't kill the
// whole walk-forward window.
export async function runBacktestDeepResearch(args: {
  symbol: string;
  decisionDate: Date;
  client?: Anthropic;
}): Promise<BacktestPickResult> {
  const symbol = args.symbol.toUpperCase().trim();
  const decisionDateISO = args.decisionDate.toISOString().slice(0, 10);
  const client = args.client ?? new Anthropic();
  const start = Date.now();

  try {
    // Price on (or just before) decision date. Look back 7 days to
    // catch the most recent trading day if the decision date itself
    // is a weekend/holiday.
    const endMs = args.decisionDate.getTime();
    const startMs = endMs - 7 * ONE_DAY_MS;
    const bars = await getBars(symbol, '1Day', startMs, endMs).catch(() => []);
    const priceAtDate = bars.length > 0 ? bars[bars.length - 1].close ?? null : null;

    // PIT fundamentals + filings in parallel.
    const [fundamentals, filings] = await Promise.all([
      priceAtDate != null
        ? lookupFundamentalsAt(symbol, args.decisionDate, priceAtDate, 'backtest').catch(
            () => null
          )
        : Promise.resolve(null),
      getResearchFilings(symbol, { filedBeforeISO: decisionDateISO }).catch(() => null),
    ]);

    const userPrompt = buildBacktestUserPrompt({
      symbol,
      decisionDateISO,
      priceAtDate,
      fundamentals,
      filings,
    });

    // Same adaptive thinking + high-effort config as the live agent.
    // Non-streaming because the backtest runs sequentially per
    // window — we don't need to forward progress to a UI for each
    // call (the harness just reports per-window aggregate
    // progress).
    const adaptiveThinkingParam = {
      thinking: { type: 'adaptive' as const },
      output_config: { effort: 'high' as const },
    } as unknown as Record<string, unknown>;

    const resp = await client.messages.create({
      model: TRADE_DECISION_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: buildBacktestSystemPrompt(),
      messages: [{ role: 'user', content: userPrompt }],
      ...adaptiveThinkingParam,
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
      log.warn('backtest_research.parse_failed', { symbol, decisionDateISO });
      return {
        symbol,
        decisionDateISO,
        output: null,
        costUsd,
        durationMs: Date.now() - start,
        error: 'unparseable model output',
      };
    }

    return {
      symbol,
      decisionDateISO,
      output,
      costUsd,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    log.warn('backtest_research.failed', {
      symbol,
      decisionDateISO,
      error: String(err),
    });
    return {
      symbol,
      decisionDateISO,
      output: null,
      costUsd: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message.slice(0, 240) : 'unknown error',
    };
  }
}

// Per-window driver: run the agent on every symbol in the universe
// and return them ranked by conviction (descending). Failed calls
// (output=null) get sorted to the bottom. Sequential so we don't
// hammer the Anthropic rate limit; the walk-forward harness already
// expects per-window runtime in the tens of minutes for the agent
// strategy.
export async function rankUniverseByConviction(args: {
  universe: string[];
  decisionDate: Date;
  client?: Anthropic;
  // Optional progress callback so the simulator can log "12/30
  // complete" without waiting for the full sweep.
  onProgress?: (done: number, total: number, latest: BacktestPickResult) => void;
}): Promise<BacktestPickResult[]> {
  const results: BacktestPickResult[] = [];
  for (let i = 0; i < args.universe.length; i++) {
    const r = await runBacktestDeepResearch({
      symbol: args.universe[i],
      decisionDate: args.decisionDate,
      client: args.client,
    });
    results.push(r);
    args.onProgress?.(i + 1, args.universe.length, r);
  }
  // Sort: highest conviction first. null outputs (errors) go to the
  // bottom regardless of the rest.
  results.sort((a, b) => {
    if (a.output == null && b.output == null) return 0;
    if (a.output == null) return 1;
    if (b.output == null) return -1;
    return b.output.convictionScore - a.output.convictionScore;
  });
  return results;
}

// Cost-estimate helper lives in deep-research-backtest-cost.ts so
// the client WalkForwardRunner can import it without pulling the
// Alpaca/dotenv graph this module brings in. Re-exported here for
// any server caller that already imports from this path.
export {
  estimateAgentBacktestCost,
  type AgentBacktestCostEstimate,
} from './deep-research-backtest-cost';
