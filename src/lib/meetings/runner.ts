// Executive meeting runner. Builds the week's briefing from real
// data (trades, agent runs, brain entries, market regime, portfolio
// state), sends it to Claude with the MEETING_SYSTEM_PROMPT, parses
// the structured JSON output, persists everything into Meeting +
// MeetingActionItem + PolicyChange rows, then optionally kicks off
// comic generation if the user has an OpenAI key saved.
//
// One Claude call per meeting. The "four executives arguing" happens
// inside the model, not across API calls.

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { MEETING_SYSTEM_PROMPT, type MeetingOutput } from './schema';
import { getCurrentRegime } from '@/lib/data/regime';
import { getUserCredential } from '@/lib/credentials';

const MEETING_MODEL = 'claude-opus-4-7';
const MEETING_MAX_TOKENS = 16_000;

export async function runMeeting(params: {
  userId: string;
  kind?: 'weekly' | 'impromptu';
  agendaOverride?: string;
}): Promise<{ meetingId: string; status: 'completed' | 'errored' }> {
  const { userId, kind = 'weekly', agendaOverride } = params;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');

  const meeting = await prisma.meeting.create({
    data: { userId, kind, status: 'running' },
  });

  try {
    const briefing = await buildBriefing(userId, agendaOverride);
    const userMessage = JSON.stringify(briefing, null, 2);

    const client = new Anthropic({ apiKey });
    const startedAt = Date.now();
    const resp = await client.messages.create({
      model: MEETING_MODEL,
      max_tokens: MEETING_MAX_TOKENS,
      system: MEETING_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Conduct this week's executive meeting using the following briefing. Respond with a single JSON object matching the schema in your instructions.\n\nBRIEFING:\n${userMessage}`,
        },
      ],
    });

    const rawText = resp.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    const parsed = parseMeetingJson(rawText);
    const elapsedMs = Date.now() - startedAt;

    // Crude but stable cost estimate. Opus pricing is public; we're
    // in the ballpark. Replace with tokens-usage math when the SDK
    // surfaces both input + output counts.
    const costUsd = estimateCost(resp.usage?.input_tokens ?? 0, resp.usage?.output_tokens ?? 0);

    await prisma.$transaction(async (tx) => {
      await tx.meeting.update({
        where: { id: meeting.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          summary: parsed.summary,
          transcriptJson: parsed as unknown as object,
          agendaJson: briefing as unknown as object,
          costUsd,
        },
      });
      for (const item of parsed.actionItems) {
        await tx.meetingActionItem.create({
          data: {
            meetingId: meeting.id,
            userId,
            kind: item.kind,
            description: item.description,
            status: 'started',
          },
        });
      }
      for (const change of parsed.policyChanges) {
        await tx.policyChange.create({
          data: {
            meetingId: meeting.id,
            userId,
            kind: change.kind,
            targetKey: change.targetKey,
            before: change.before as object,
            after: change.after as object,
            rationale: change.rationale,
            status: 'proposed',
          },
        });
      }
    });

    log.info('meeting.completed', {
      userId,
      meetingId: meeting.id,
      kind,
      elapsedMs,
      costUsd,
      transcriptTurns: parsed.transcript.length,
      actionItems: parsed.actionItems.length,
      policyChanges: parsed.policyChanges.length,
      sentiment: parsed.sentiment,
    });

    // Comic generation (opt-in via user's OpenAI key). Fire-and-forget
    // — a meeting is considered complete even if the comic fails.
    const openaiKey = await getUserCredential(userId, 'openai').catch(() => null);
    if (openaiKey) {
      void import('./comic').then(({ generateMeetingComic }) =>
        generateMeetingComic({ meetingId: meeting.id, userId, openaiKey }).catch((err) => {
          log.error('meeting.comic_failed', err, { meetingId: meeting.id });
        })
      );
    }

    return { meetingId: meeting.id, status: 'completed' };
  } catch (err) {
    await prisma.meeting.update({
      where: { id: meeting.id },
      data: {
        status: 'errored',
        completedAt: new Date(),
        errorMessage: (err as Error).message.slice(0, 500),
      },
    });
    log.error('meeting.failed', err, { userId, meetingId: meeting.id });
    return { meetingId: meeting.id, status: 'errored' };
  }
}

// ─── Briefing ────────────────────────────────────────────────────────────
// Pack one week of real data into a JSON object the model will read.
// Kept compact — no prose, just numbers the roles can argue from.

async function buildBriefing(userId: string, agendaOverride?: string) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);

  const [account, activeStrategy, recentTrades, recentRuns, brainEntries, regime, positions, priorMeeting] =
    await Promise.all([
      prisma.account.findUnique({ where: { userId } }),
      prisma.strategy.findFirst({ where: { userId, isActive: true } }),
      prisma.trade.findMany({
        where: { userId, submittedAt: { gte: sevenDaysAgo } },
        orderBy: { submittedAt: 'desc' },
        take: 50,
      }),
      prisma.agentRun.findMany({
        where: { userId, startedAt: { gte: sevenDaysAgo } },
        orderBy: { startedAt: 'desc' },
        take: 30,
        select: { startedAt: true, decision: true, summary: true, status: true, costUsd: true },
      }),
      prisma.brainEntry.findMany({
        where: { userId, createdAt: { gte: sevenDaysAgo } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { kind: true, title: true, body: true, createdAt: true },
      }),
      getCurrentRegime().catch(() => null),
      prisma.position.findMany({ where: { userId } }),
      prisma.meeting.findFirst({
        where: { userId, status: 'completed' },
        orderBy: { startedAt: 'desc' },
        select: { summary: true, startedAt: true },
      }),
    ]);

  return {
    agenda:
      agendaOverride ??
      'Standard weekly: review past week, flag risks, decide next-week priorities.',
    account: account
      ? {
          depositedCents: account.depositedCents.toString(),
          expectedAnnualPct: account.expectedAnnualPct,
          riskTolerance: account.riskTolerance,
          agentCadenceMinutes: account.agentCadenceMinutes,
          isPaused: account.isPaused,
          isStopped: account.isStopped,
        }
      : null,
    activeStrategy: activeStrategy
      ? {
          id: activeStrategy.id,
          name: activeStrategy.name,
          summary: activeStrategy.summary.slice(0, 400),
        }
      : null,
    marketRegime: regime,
    positions: (positions as Array<{
      symbol: string;
      qty: number;
      avgCostCents: bigint;
      openedAt: Date;
    }>).map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      avgCostCents: p.avgCostCents.toString(),
      openedAt: p.openedAt.toISOString(),
    })),
    pastWeekTrades: (recentTrades as Array<{
      symbol: string;
      side: string;
      qty: number;
      assetClass: string;
      submittedAt: Date;
      status: string;
      thesis: string | null;
    }>).map((t) => ({
      symbol: t.symbol,
      side: t.side,
      qty: t.qty,
      assetClass: t.assetClass,
      submittedAt: t.submittedAt.toISOString(),
      status: t.status,
      thesis: t.thesis?.slice(0, 300) ?? null,
    })),
    pastWeekAgentRuns: (recentRuns as Array<{
      startedAt: Date;
      decision: string | null;
      status: string;
      costUsd: number | null;
      summary: string | null;
    }>).map((r) => ({
      at: r.startedAt.toISOString(),
      decision: r.decision,
      status: r.status,
      costUsd: r.costUsd,
      summary: r.summary?.slice(0, 240),
    })),
    pastWeekBrainEntries: (brainEntries as Array<{
      kind: string;
      title: string;
      body: string;
      createdAt: Date;
    }>).map((e) => ({
      kind: e.kind,
      title: e.title,
      body: e.body.slice(0, 800),
      at: e.createdAt.toISOString(),
    })),
    priorMeetingSummary: priorMeeting?.summary ?? null,
    priorMeetingAt: priorMeeting?.startedAt.toISOString() ?? null,
  };
}

// ─── JSON parsing ────────────────────────────────────────────────────────
// Claude occasionally prefixes with a line or wraps in a code fence
// despite instructions. Best-effort recovery; errors on failure.

function parseMeetingJson(raw: string): MeetingOutput {
  let trimmed = raw.trim();
  // Strip ```json ... ``` fences if the model added them.
  const fenceMatch = /```(?:json)?\s*([\s\S]+?)\s*```/i.exec(trimmed);
  if (fenceMatch) trimmed = fenceMatch[1].trim();
  // Strip any leading non-JSON prefix up to the first '{'.
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace > 0) trimmed = trimmed.slice(firstBrace);
  // Strip any trailing non-JSON suffix after the last '}'.
  const lastBrace = trimmed.lastIndexOf('}');
  if (lastBrace >= 0 && lastBrace < trimmed.length - 1) {
    trimmed = trimmed.slice(0, lastBrace + 1);
  }
  let parsed: MeetingOutput;
  try {
    parsed = JSON.parse(trimmed) as MeetingOutput;
  } catch (err) {
    throw new Error(
      `meeting output was not valid JSON: ${(err as Error).message}. raw start: ${raw.slice(0, 200)}`
    );
  }
  // Minimal shape validation — if the model skipped a required field
  // we throw rather than proceeding with half data.
  if (!Array.isArray(parsed.transcript) || parsed.transcript.length === 0) {
    throw new Error('meeting output missing transcript');
  }
  if (!parsed.summary) throw new Error('meeting output missing summary');
  parsed.decisions = parsed.decisions ?? [];
  parsed.actionItems = parsed.actionItems ?? [];
  parsed.policyChanges = parsed.policyChanges ?? [];
  parsed.sentiment = parsed.sentiment ?? 'cautious';
  return parsed;
}

// Opus 4.7 public pricing (Apr 2026): $15 / $75 per 1M tokens in/out.
// Keep local; env-driven override in future if Anthropic adjusts.
function estimateCost(inTokens: number, outTokens: number): number {
  return (inTokens / 1_000_000) * 15 + (outTokens / 1_000_000) * 75;
}
