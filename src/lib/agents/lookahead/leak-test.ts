// Single-pair + batch runner for the lookahead-bias leak test.
//
// One "pair" = (symbol, decisionDate). For each pair we run BOTH
// arms (strict + unrestricted) on the same model, parse both
// responses, then look up actual 12-month return from Alpaca bars
// and compute leak metrics.
//
// Defaults to Haiku 4.5 because the leak test is a technique
// validator, not a production research pipeline. A 10-pair Haiku
// run costs ~$0.10. The same code with `model: 'claude-opus-4-7'`
// next month gives the rigorous answer at ~10x the cost.

import Anthropic from '@anthropic-ai/sdk';
import { getBars } from '@/lib/alpaca';
import { estimateCostUsd, type TokenUsage } from '@/lib/pricing';
import { FAST_MODEL } from '../models';
import {
  buildLeakPrompt,
  parseLeakResponse,
  type LeakArm,
  type LeakResponse,
} from './prompts';

const ONE_DAY_MS = 86_400_000;
const ONE_YEAR_MS = 365 * ONE_DAY_MS;

export type LeakPair = { symbol: string; decisionDateISO: string };

export type LeakArmResult = {
  arm: LeakArm;
  rawText: string;
  parsed: LeakResponse | null;
  usage: TokenUsage;
  costUsd: number;
};

export type LeakPairResult = {
  pair: LeakPair;
  // Actual close price as of decisionDate and ~365 days later.
  // Null if Alpaca didn't have bars for either lookup.
  decisionPrice: number | null;
  oneYearLaterPrice: number | null;
  actualReturnPct: number | null;
  strict: LeakArmResult;
  unrestricted: LeakArmResult;
  // True iff unrestricted's price target was closer to actual than
  // strict's. The fraction of pairs where this is true is the
  // headline leak indicator.
  unrestrictedCloserToActual: boolean | null;
  // Conviction divergence — |strict - unrestricted|. If always 0,
  // the strict scaffold isn't constraining the model.
  convictionDivergence: number | null;
};

export type LeakBatchSummary = {
  pairCount: number;
  parsedBoth: number;
  withActualReturn: number;
  // Headline metric: in what fraction of valid pairs did the
  // UNRESTRICTED arm beat the STRICT arm at predicting actual
  // 1-year return? 0.5 = no leak (random). 0.7+ = strong leak.
  // Below 0.4 means the strict prompt is somehow MORE accurate,
  // which would itself be suspicious.
  unrestrictedWinRate: number | null;
  // Mean |strict_target - unrestricted_target| / decision_price,
  // expressed as a percent. If 0, the prompts produce identical
  // numeric outputs and the strict scaffold isn't doing anything.
  meanTargetDivergencePct: number | null;
  meanConvictionDivergence: number | null;
  totalCostUsd: number;
  results: LeakPairResult[];
};

export async function runLeakPair(args: {
  pair: LeakPair;
  model?: string;
  // Provider dispatch. Defaults to anthropic for backwards compat.
  // 'openai' requires args.openaiKey to be set; the API route fetches
  // it from the user's encrypted UserApiCredential.
  provider?: LeakProvider;
  client?: Anthropic;
  openaiKey?: string;
  // Hard cap to prevent runaway output if the model ignores the
  // "JSON only" instruction. ~600 tokens is plenty for the schema.
  maxTokens?: number;
}): Promise<LeakPairResult> {
  const provider: LeakProvider = args.provider ?? 'anthropic';
  const model = args.model ?? FAST_MODEL;
  const client = provider === 'anthropic' ? args.client ?? new Anthropic() : undefined;
  const maxTokens = args.maxTokens ?? 600;

  const [strict, unrestricted] = await Promise.all([
    runOneArm({
      arm: 'strict',
      pair: args.pair,
      model,
      provider,
      client,
      openaiKey: args.openaiKey,
      maxTokens,
    }),
    runOneArm({
      arm: 'unrestricted',
      pair: args.pair,
      model,
      provider,
      client,
      openaiKey: args.openaiKey,
      maxTokens,
    }),
  ]);

  const decisionPrice = await closeOnOrAfter(args.pair.symbol, args.pair.decisionDateISO);
  const oneYearLaterISO = isoPlusDays(args.pair.decisionDateISO, 365);
  const oneYearLaterPrice = await closeOnOrAfter(args.pair.symbol, oneYearLaterISO);

  const actualReturnPct =
    decisionPrice != null && oneYearLaterPrice != null && decisionPrice > 0
      ? ((oneYearLaterPrice - decisionPrice) / decisionPrice) * 100
      : null;

  const unrestrictedCloserToActual =
    decisionPrice != null &&
    actualReturnPct != null &&
    strict.parsed != null &&
    unrestricted.parsed != null
      ? Math.abs(predToReturnPct(unrestricted.parsed.twelve_month_price_target_usd, decisionPrice) - actualReturnPct) <
        Math.abs(predToReturnPct(strict.parsed.twelve_month_price_target_usd, decisionPrice) - actualReturnPct)
      : null;

  const convictionDivergence =
    strict.parsed != null && unrestricted.parsed != null
      ? Math.abs(strict.parsed.conviction_0_to_100 - unrestricted.parsed.conviction_0_to_100)
      : null;

  return {
    pair: args.pair,
    decisionPrice,
    oneYearLaterPrice,
    actualReturnPct,
    strict,
    unrestricted,
    unrestrictedCloserToActual,
    convictionDivergence,
  };
}

export async function runLeakBatch(args: {
  pairs: LeakPair[];
  model?: string;
  provider?: LeakProvider;
  client?: Anthropic;
  openaiKey?: string;
  // Soft cost cap. If the rolling cost exceeds this before the
  // batch completes, the runner stops mid-batch and returns
  // partial results. Cheap insurance against the prompt going
  // off the rails on the first few names.
  costCapUsd?: number;
  // Per-pair callback for progress reporting (CLI uses this to
  // print incremental cost).
  onPair?: (i: number, result: LeakPairResult) => void;
}): Promise<LeakBatchSummary> {
  const results: LeakPairResult[] = [];
  let totalCost = 0;
  for (let i = 0; i < args.pairs.length; i++) {
    if (args.costCapUsd != null && totalCost >= args.costCapUsd) break;
    const result = await runLeakPair({
      pair: args.pairs[i],
      model: args.model,
      provider: args.provider,
      client: args.client,
      openaiKey: args.openaiKey,
    });
    results.push(result);
    totalCost += result.strict.costUsd + result.unrestricted.costUsd;
    args.onPair?.(i, result);
  }
  return summarize(results, totalCost);
}

function summarize(results: LeakPairResult[], totalCost: number): LeakBatchSummary {
  const parsedBoth = results.filter((r) => r.strict.parsed && r.unrestricted.parsed);
  const withReturn = parsedBoth.filter((r) => r.actualReturnPct != null);
  const wins = withReturn.filter((r) => r.unrestrictedCloserToActual === true).length;

  const targetDivergences: number[] = [];
  for (const r of parsedBoth) {
    if (r.decisionPrice == null || r.decisionPrice <= 0) continue;
    const s = r.strict.parsed!.twelve_month_price_target_usd;
    const u = r.unrestricted.parsed!.twelve_month_price_target_usd;
    targetDivergences.push((Math.abs(s - u) / r.decisionPrice) * 100);
  }
  const convictionDivergences = parsedBoth
    .map((r) => r.convictionDivergence)
    .filter((v): v is number => v != null);

  return {
    pairCount: results.length,
    parsedBoth: parsedBoth.length,
    withActualReturn: withReturn.length,
    unrestrictedWinRate: withReturn.length > 0 ? wins / withReturn.length : null,
    meanTargetDivergencePct:
      targetDivergences.length > 0
        ? targetDivergences.reduce((s, v) => s + v, 0) / targetDivergences.length
        : null,
    meanConvictionDivergence:
      convictionDivergences.length > 0
        ? convictionDivergences.reduce((s, v) => s + v, 0) / convictionDivergences.length
        : null,
    totalCostUsd: totalCost,
    results,
  };
}

export type LeakProvider = 'anthropic' | 'openai';

async function runOneArm(args: {
  arm: LeakArm;
  pair: LeakPair;
  model: string;
  provider: LeakProvider;
  client?: Anthropic;
  openaiKey?: string;
  maxTokens: number;
}): Promise<LeakArmResult> {
  const { system, user } = buildLeakPrompt({
    arm: args.arm,
    symbol: args.pair.symbol,
    decisionDateISO: args.pair.decisionDateISO,
  });
  if (args.provider === 'anthropic') {
    return runOneArmAnthropic({ ...args, system, user });
  }
  return runOneArmOpenAI({ ...args, system, user });
}

async function runOneArmAnthropic(args: {
  arm: LeakArm;
  model: string;
  client?: Anthropic;
  maxTokens: number;
  system: string;
  user: string;
}): Promise<LeakArmResult> {
  const client = args.client ?? new Anthropic();
  const resp = await client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens,
    system: args.system,
    messages: [{ role: 'user', content: args.user }],
  });
  const rawText = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const u = resp.usage as unknown as Record<string, number | undefined>;
  const usage: TokenUsage = {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
  return {
    arm: args.arm,
    rawText,
    parsed: parseLeakResponse(rawText),
    usage,
    costUsd: estimateCostUsd(args.model, usage),
  };
}

// OpenAI dispatch via raw fetch to /v1/chat/completions, mirroring the
// pattern in src/lib/meetings/comic.ts. Newer reasoning models
// (gpt-5-pro, o1-pro, o3-pro) accept `max_completion_tokens` instead
// of `max_tokens`; we send both keys and trust the API to ignore the
// one it doesn't understand. response_format=json_object pushes the
// model toward valid JSON output without a separate JSON-mode prompt.
async function runOneArmOpenAI(args: {
  arm: LeakArm;
  model: string;
  openaiKey?: string;
  maxTokens: number;
  system: string;
  user: string;
}): Promise<LeakArmResult> {
  if (!args.openaiKey) {
    throw new Error(
      'runOneArmOpenAI: openaiKey missing. Add an OpenAI API key in Settings → API keys.'
    );
  }
  const body: Record<string, unknown> = {
    model: args.model,
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
    max_tokens: args.maxTokens,
    max_completion_tokens: args.maxTokens,
    response_format: { type: 'json_object' },
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`openai chat ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const rawText = data.choices?.[0]?.message?.content ?? '';
  const usage: TokenUsage = {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
  return {
    arm: args.arm,
    rawText,
    parsed: parseLeakResponse(rawText),
    usage,
    costUsd: estimateCostUsd(args.model, usage),
  };
}

// Convert a price target back to a return percent given the decision-
// date price. Used to compare predictions against actual return on
// the same scale.
function predToReturnPct(targetUsd: number, decisionPrice: number): number {
  return ((targetUsd - decisionPrice) / decisionPrice) * 100;
}

function isoPlusDays(iso: string, days: number): string {
  const t = new Date(`${iso}T00:00:00Z`).getTime() + days * ONE_DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

// Find the close on the requested date OR the next trading day after.
// Alpaca bars skip weekends/holidays so an exact-date lookup misses
// roughly 30% of dates the user might pass.
async function closeOnOrAfter(symbol: string, isoDate: string): Promise<number | null> {
  const startMs = new Date(`${isoDate}T00:00:00Z`).getTime();
  // Look 14 days forward to catch Mondays after long weekends.
  const endMs = startMs + 14 * ONE_DAY_MS;
  const bars = await getBars(symbol, '1Day', startMs, endMs);
  if (!bars || bars.length === 0) return null;
  return bars[0].close ?? null;
}
