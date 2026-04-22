// Candidate review wizard — a non-agentic Opus call that scans the user's
// pending candidates, ranks them against the active strategy + Buffett
// principles, and returns a structured recommendation per candidate.
//
// Advisory only. Does NOT promote or reject anything — the user still
// clicks the existing Approve/Reject buttons. This exists because the
// jump from "unaided manual approval" to "trust the auto-promote bar" was
// too big for a user who wants a second opinion before committing.
//
// One-shot call; no tool use, no multi-turn loop. Everything the wizard
// needs is packed into a single prompt: candidate cards + active strategy
// rules + relevant brain excerpts.

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { TRADE_DECISION_MODEL } from './models';
import { estimateCostUsd } from '@/lib/pricing';
import type { BrainEntry, Stock, Strategy } from '@prisma/client';

export type WizardRecommendation = 'approve' | 'reject' | 'defer';

export type WizardVerdict = {
  symbol: string;
  rank: number;
  recommendation: WizardRecommendation;
  confidence: number; // 0..1
  bullCase: string;
  bearCase: string;
  fitWithStrategy: string;
  concerns: string;
};

export type WizardResult = {
  overallSummary: string;
  topPick: string | null;
  verdicts: WizardVerdict[];
  costUsd: number;
  latencyMs: number;
  model: string;
};

const SYSTEM = `You are AgBro's Candidate Review Wizard.

The user has already generated pending investment candidates from the
screener. They want your second opinion before approving any — you are
their research analyst, not their decision-maker. You will receive a
list of candidates + the user's active strategy rules + the most relevant
Buffett-style principles from the brain library.

Your job, for each candidate:
  1. Read the business description and fundamentals.
  2. Evaluate fit against the active strategy's rules (sector allowlist,
     P/E ceiling, ROE floor, moat requirement, etc.).
  3. Write a tight Bull Case (2-3 sentences).
  4. Write a tight Bear Case (2-3 sentences). Never skip — if you can't
     articulate a bear case, the thesis isn't complete.
  5. Give a recommendation: approve | reject | defer.
  6. Give a confidence score 0..1.

Then at the top: a one-paragraph overall summary + your top pick (a single
symbol, or null if nothing crosses the bar). Be willing to recommend REJECT
for everything if nothing is a fit — "no new positions" is a valid answer
and often the correct one.

Output MUST be a single JSON object, no prose outside it, no markdown
fences. Schema:
{
  "overallSummary": string,
  "topPick": string | null,
  "verdicts": [
    {
      "symbol": string,
      "rank": number (1 = best),
      "recommendation": "approve" | "reject" | "defer",
      "confidence": number (0..1),
      "bullCase": string,
      "bearCase": string,
      "fitWithStrategy": string,
      "concerns": string
    }
  ]
}`;

type CandidateInput = Pick<
  Stock,
  | 'symbol'
  | 'name'
  | 'sector'
  | 'industry'
  | 'candidateNotes'
  | 'businessDescription'
  | 'peRatio'
  | 'pbRatio'
  | 'dividendYield'
  | 'debtToEquity'
  | 'returnOnEquity'
  | 'grossMarginPct'
  | 'epsGrowthPct5y'
  | 'fundamentalsSource'
>;

function formatCandidate(c: CandidateInput): string {
  const fundamentals: string[] = [];
  if (c.peRatio != null) fundamentals.push(`P/E ${c.peRatio.toFixed(1)}`);
  if (c.pbRatio != null) fundamentals.push(`P/B ${c.pbRatio.toFixed(1)}`);
  if (c.returnOnEquity != null) fundamentals.push(`ROE ${c.returnOnEquity.toFixed(1)}%`);
  if (c.debtToEquity != null) fundamentals.push(`D/E ${c.debtToEquity.toFixed(2)}`);
  if (c.grossMarginPct != null) fundamentals.push(`GM ${c.grossMarginPct.toFixed(1)}%`);
  if (c.dividendYield != null && c.dividendYield > 0)
    fundamentals.push(`Div ${c.dividendYield.toFixed(2)}%`);
  if (c.epsGrowthPct5y != null) fundamentals.push(`5y EPS growth ${c.epsGrowthPct5y.toFixed(1)}%`);
  return [
    `SYMBOL: ${c.symbol}`,
    `NAME: ${c.name}`,
    `SECTOR: ${c.sector ?? '—'}${c.industry ? ` (${c.industry})` : ''}`,
    c.businessDescription ? `BUSINESS: ${c.businessDescription}` : null,
    c.candidateNotes ? `SCREENER THESIS: ${c.candidateNotes}` : null,
    `FUNDAMENTALS (${c.fundamentalsSource ?? 'unknown source'}): ${fundamentals.length > 0 ? fundamentals.join(' · ') : 'not fetched yet'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatStrategy(strategy: Strategy | null): string {
  if (!strategy) return 'No active strategy — use generic Buffett-style defaults.';
  return `ACTIVE STRATEGY: ${strategy.name}
Summary: ${strategy.summary}
Rules: ${JSON.stringify(strategy.rules, null, 2)}`;
}

function formatPrinciples(entries: BrainEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .slice(0, 8)
    .map((e) => `- ${e.title}: ${e.body.slice(0, 400)}`)
    .join('\n');
}

export async function runCandidateWizard(userId: string): Promise<WizardResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY missing — wizard disabled');
  }

  const [candidates, activeStrategy, principles] = await Promise.all([
    prisma.stock.findMany({
      where: { candidateSource: 'screener' },
      orderBy: { discoveredAt: 'desc' },
    }),
    prisma.strategy.findFirst({ where: { userId, isActive: true } }),
    prisma.brainEntry.findMany({
      where: { userId, kind: { in: ['principle', 'checklist', 'pitfall'] } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  if (candidates.length === 0) {
    return {
      overallSummary: 'No pending candidates to review. Generate some via the screener first.',
      topPick: null,
      verdicts: [],
      costUsd: 0,
      latencyMs: 0,
      model: TRADE_DECISION_MODEL,
    };
  }

  const userMessage = [
    formatStrategy(activeStrategy),
    '',
    'RELEVANT PRINCIPLES FROM THE BRAIN:',
    formatPrinciples(principles) || '(no principles seeded)',
    '',
    `PENDING CANDIDATES (${candidates.length}):`,
    ...candidates.map((c, i) => `\n--- Candidate ${i + 1} ---\n${formatCandidate(c)}`),
    '',
    'Analyse each candidate and return the JSON verdict object per the schema in the system prompt. Be honest — recommend reject on anything that doesn\'t clear the bar. "No new positions today" is always a valid answer.',
  ].join('\n');

  const anthropic = new Anthropic({ apiKey });
  const t0 = Date.now();
  const resp = await anthropic.messages.create({
    model: TRADE_DECISION_MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  });
  const latencyMs = Date.now() - t0;

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  // The model is instructed to emit JSON only, but defensively strip any
  // surrounding markdown fence or leading prose if it slips in.
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  const jsonSlice = jsonStart >= 0 && jsonEnd > jsonStart ? text.slice(jsonStart, jsonEnd + 1) : text;

  let parsed: {
    overallSummary: string;
    topPick: string | null;
    verdicts: WizardVerdict[];
  };
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    log.error('wizard.json_parse_failed', err, { userId, textPreview: text.slice(0, 500) });
    throw new Error('wizard returned malformed JSON');
  }

  // Defensive: filter verdicts to symbols that were actually in the input.
  const validSymbols = new Set(candidates.map((c) => c.symbol));
  const cleaned: WizardVerdict[] = (parsed.verdicts ?? [])
    .filter((v) => validSymbols.has(v.symbol?.toUpperCase?.()))
    .map<WizardVerdict>((v) => ({
      symbol: v.symbol.toUpperCase(),
      rank: Math.max(1, Math.round(v.rank ?? 99)),
      recommendation:
        v.recommendation === 'approve' || v.recommendation === 'reject'
          ? v.recommendation
          : ('defer' as WizardRecommendation),
      confidence: Math.max(0, Math.min(1, Number(v.confidence ?? 0.5))),
      bullCase: String(v.bullCase ?? '').slice(0, 1_000),
      bearCase: String(v.bearCase ?? '').slice(0, 1_000),
      fitWithStrategy: String(v.fitWithStrategy ?? '').slice(0, 500),
      concerns: String(v.concerns ?? '').slice(0, 500),
    }))
    .sort((a, b) => a.rank - b.rank);

  const costUsd = estimateCostUsd(TRADE_DECISION_MODEL, {
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
  });

  log.info('wizard.completed', {
    userId,
    candidateCount: candidates.length,
    verdictCount: cleaned.length,
    topPick: parsed.topPick ?? null,
    approveCount: cleaned.filter((v) => v.recommendation === 'approve').length,
    costUsd: costUsd.toFixed(4),
    latencyMs,
  });

  return {
    overallSummary: String(parsed.overallSummary ?? '').slice(0, 2_000),
    topPick: parsed.topPick && validSymbols.has(parsed.topPick.toUpperCase()) ? parsed.topPick.toUpperCase() : null,
    verdicts: cleaned,
    costUsd,
    latencyMs,
    model: TRADE_DECISION_MODEL,
  };
}
