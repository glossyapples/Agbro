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
import { castForStrategyName, BURRY_GUEST_SHEET, type CastBundle } from './cast';
import { estimateCostUsd } from '@/lib/pricing';

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
    // Pick the cast for the user's active strategy. Characters'
    // names + personalities get injected into the system prompt so
    // Claude addresses them correctly in transcript turns.
    const cast = castForStrategyName(briefing.activeStrategy?.name ?? null);
    // Guest-mode Burrybot: when the active strategy opted him in via
    // allowBurryGuest AND the strategy isn't already Burry's own firm
    // (he's already the principal there). The flag is per-strategy so
    // users can have him kibitzing at Buffett Core but silent at
    // Quality Compounders.
    const burryGuest =
      briefing.activeStrategy?.allowBurryGuest === true &&
      cast.strategyKey !== 'burry_deep_research'
        ? BURRY_GUEST_SHEET
        : null;

    const client = new Anthropic({ apiKey });
    const startedAt = Date.now();
    const resp = await client.messages.create({
      model: MEETING_MODEL,
      max_tokens: MEETING_MAX_TOKENS,
      system: buildMeetingSystemPrompt(cast, burryGuest),
      messages: [
        {
          role: 'user',
          content: `Conduct this week's executive meeting using the following briefing. Respond with a single JSON object matching the schema in your instructions.\n\nBRIEFING:\n${JSON.stringify(briefing, null, 2)}`,
        },
      ],
    });

    const rawText = resp.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    const parsed = parseMeetingJson(rawText);
    // Attach the cast snapshot so the display + comic generator know
    // which characters were on stage, even if cast definitions
    // evolve in the future.
    parsed.cast = castSnapshot(cast, burryGuest);
    const elapsedMs = Date.now() - startedAt;

    // Delegate to the shared pricing module so cache-read / cache-write
    // tokens are credited at their real (lower) rates. The previous
    // version counted everything at full input rate and overstated
    // meetings by 15-30x — which then polluted policy-change rationales
    // with phantom "$4-7 per run" figures.
    const usage = resp.usage as unknown as {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    } | undefined;
    const costUsd = estimateCostUsd(MEETING_MODEL, {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    });

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

      // Apply updates to prior action items. Each update targets an
      // existing item by id; we ignore updates targeting items that
      // don't belong to this user (defence against the model making
      // up an id). completedAt is set when status goes to completed.
      for (const update of parsed.actionItemUpdates ?? []) {
        const existing = await tx.meetingActionItem.findUnique({
          where: { id: update.id },
        });
        if (!existing || existing.userId !== userId) continue;
        await tx.meetingActionItem.update({
          where: { id: update.id },
          data: {
            status: update.status,
            completedAt:
              update.status === 'completed'
                ? existing.completedAt ?? new Date()
                : null,
            // Append the note to the description as a history breadcrumb.
            description: update.note
              ? `${existing.description}\n  • ${new Date().toISOString().slice(0, 10)} (${update.status}): ${update.note}`
              : existing.description,
          },
        });
      }

      // Then create any NEW action items.
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

    // Comic generation (opt-in via user's OpenAI key). Awaited in-band
    // — earlier we fired-and-forgot, but Next.js route handlers don't
    // guarantee the event loop keeps draining after the response ships,
    // so the comic intermittently never ran. Total path is meeting
    // (~40s) + comic (~20-30s), well inside the route's 120s budget.
    // Comic failures still don't fail the meeting — we persist the
    // error to meeting.comicError and return status:'completed'.
    let openaiKey: string | null = null;
    try {
      openaiKey = await getUserCredential(userId, 'openai');
    } catch (err) {
      log.warn('meeting.comic_credential_read_failed', {
        meetingId: meeting.id,
        userId,
        err: (err as Error).message,
      });
    }
    if (openaiKey) {
      log.info('meeting.comic_trigger', { meetingId: meeting.id, userId });
      try {
        const { generateMeetingComic } = await import('./comic');
        const result = await generateMeetingComic({
          meetingId: meeting.id,
          userId,
          openaiKey,
        });
        log.info('meeting.comic_result', {
          meetingId: meeting.id,
          ok: result.ok,
          costUsd: result.costUsd,
        });
      } catch (err) {
        log.error('meeting.comic_failed_trigger', err, {
          meetingId: meeting.id,
        });
        await prisma.meeting
          .update({
            where: { id: meeting.id },
            data: {
              comicError: `trigger: ${(err as Error).message.slice(0, 400)}`,
            },
          })
          .catch(() => {});
      }
    } else {
      log.info('meeting.comic_skipped', {
        meetingId: meeting.id,
        userId,
        reason: 'no_openai_key',
      });
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

  const [
    account,
    activeStrategy,
    recentTrades,
    recentRuns,
    brainDoctrine,
    brainRecent,
    regime,
    positions,
    priorMeeting,
    openActionItems,
    cryptoConfig,
  ] = await Promise.all([
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
      // Brain split into two slices so the partners reason from doctrine
      // AND recent experience, not just the noisy last-7-days memory:
      //   (1) canonical doctrine — principles + firm charter — always
      //       in the briefing, bounded tight so it doesn't swamp the
      //       budget.
      //   (2) recent memory — last 7 days of run summaries, post-mortems,
      //       weekly updates, lessons — the concrete things to discuss.
      // Both skip superseded entries so contradictions don't leak in.
      prisma.brainEntry.findMany({
        where: {
          userId,
          supersededById: null,
          category: { in: ['principle', 'playbook'] },
          confidence: { in: ['canonical', 'high'] },
        },
        orderBy: [{ confidence: 'asc' }, { updatedAt: 'desc' }],
        take: 12,
        select: {
          kind: true,
          category: true,
          confidence: true,
          title: true,
          body: true,
          createdAt: true,
        },
      }),
      prisma.brainEntry.findMany({
        where: {
          userId,
          supersededById: null,
          category: { in: ['memory', 'hypothesis'] },
          createdAt: { gte: sevenDaysAgo },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          kind: true,
          category: true,
          confidence: true,
          title: true,
          body: true,
          createdAt: true,
        },
      }),
      getCurrentRegime().catch(() => null),
      prisma.position.findMany({ where: { userId } }),
      prisma.meeting.findFirst({
        where: { userId, status: 'completed' },
        orderBy: { startedAt: 'desc' },
        select: { summary: true, startedAt: true },
      }),
      // Every open action item — the meeting MUST review each of these
      // and emit an actionItemUpdates entry for it. Capped at 40 to
      // protect context budget; if a user ever has >40 open items
      // that's its own problem (the meeting should complete some).
      prisma.meetingActionItem.findMany({
        where: {
          userId,
          status: { in: ['started', 'on_hold', 'blocked'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: {
          id: true,
          kind: true,
          description: true,
          status: true,
          createdAt: true,
        },
      }),
      // Crypto config so meetings can reason about DCA cadence vs.
      // the allocation cap — the pair matters together, neither
      // alone.
      prisma.cryptoConfig.findUnique({ where: { userId } }),
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
          // Full risk posture — meetings used to see only the first
          // six fields, which led to comics saying "no cap" about
          // caps that existed. These are all policyChange-able
          // targets so the partners should see them to reason well.
          safetyRails: {
            maxPositionPct: account.maxPositionPct,
            maxDailyTrades: account.maxDailyTrades,
            minCashReservePct: account.minCashReservePct,
            maxCryptoAllocationPct: account.maxCryptoAllocationPct,
            maxDailyCryptoTrades: account.maxDailyCryptoTrades,
            dailyLossKillPct: account.dailyLossKillPct,
            drawdownPauseThresholdPct: account.drawdownPauseThresholdPct,
            maxTradeNotionalCents: account.maxTradeNotionalCents.toString(),
            tradingHoursStart: account.tradingHoursStart,
            tradingHoursEnd: account.tradingHoursEnd,
            allowDayTrades: account.allowDayTrades,
            cryptoEnabled: account.cryptoEnabled,
            optionsEnabled: account.optionsEnabled,
            killSwitchActive: !!account.killSwitchTriggeredAt,
            killSwitchReason: account.killSwitchReason ?? null,
          },
          walletBalanceCents: account.walletBalanceCents.toString(),
        }
      : null,
    cryptoConfig: cryptoConfig
      ? {
          dcaAmountCents: cryptoConfig.dcaAmountCents.toString(),
          dcaCadenceDays: cryptoConfig.dcaCadenceDays,
          presetKey: cryptoConfig.presetKey,
          targetAllocations: cryptoConfig.targetAllocations,
          lastDcaAt: cryptoConfig.lastDcaAt?.toISOString() ?? null,
        }
      : null,
    activeStrategy: activeStrategy
      ? {
          id: activeStrategy.id,
          name: activeStrategy.name,
          summary: activeStrategy.summary.slice(0, 400),
          allowBurryGuest: activeStrategy.allowBurryGuest,
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
    // Honest cost rollup so the partners don't have to eyeball per-run
    // numbers (and, previously, invent them — rationales were quoting
    // $4-7/run when the real number was $0.20). Source-of-truth math.
    agentRunCostSummary: summariseAgentRunCosts(
      recentRuns as Array<{ costUsd: number | null; startedAt: Date; status: string }>
    ),
    // Doctrine: principles + playbooks the partners should always
    // reason from. Shorter body slice — these are reminders, not
    // refreshers. Agents read the full versions via read_brain.
    brainDoctrine: (brainDoctrine as Array<{
      kind: string;
      category: string;
      confidence: string;
      title: string;
      body: string;
      createdAt: Date;
    }>).map((e) => ({
      kind: e.kind,
      category: e.category,
      confidence: e.confidence,
      title: e.title,
      body: e.body.slice(0, 300),
    })),
    pastWeekBrainEntries: (brainRecent as Array<{
      kind: string;
      category: string;
      confidence: string;
      title: string;
      body: string;
      createdAt: Date;
    }>).map((e) => ({
      kind: e.kind,
      category: e.category,
      confidence: e.confidence,
      title: e.title,
      body: e.body.slice(0, 800),
      at: e.createdAt.toISOString(),
    })),
    priorMeetingSummary: priorMeeting?.summary ?? null,
    priorMeetingAt: priorMeeting?.startedAt.toISOString() ?? null,
    // Open action items from prior meetings. The model MUST emit an
    // actionItemUpdates entry for every id here — see MEETING_SYSTEM_PROMPT.
    openActionItems: (openActionItems as Array<{
      id: string;
      kind: string;
      description: string;
      status: string;
      createdAt: Date;
    }>).map((a) => ({
      id: a.id,
      kind: a.kind,
      description: a.description,
      status: a.status,
      openedAt: a.createdAt.toISOString(),
    })),
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
  parsed.actionItemUpdates = parsed.actionItemUpdates ?? [];
  parsed.policyChanges = parsed.policyChanges ?? [];
  parsed.sentiment = parsed.sentiment ?? 'cautious';
  // Fallback comicFocus if the model skipped it — defaults to the
  // meeting as a whole with everyone on stage. Not ideal for drama
  // but keeps the comic renderable.
  if (!parsed.comicFocus) {
    parsed.comicFocus = {
      title: 'Weekly review',
      arc: parsed.summary.slice(0, 300),
      roles: ['warren_buffbot', 'charlie_mungbot', 'analyst', 'risk', 'operations'],
    };
  }
  return parsed;
}

// Summarise last-7-days agent-run cost into fields the model can read
// without having to sum. Median + max make outliers visible without a
// full histogram; weeklyTotal is the number the partners actually care
// about when debating cadence.
function summariseAgentRunCosts(
  runs: Array<{ costUsd: number | null; startedAt: Date; status: string }>
): {
  runCount: number;
  weeklyTotalUsd: number;
  avgPerRunUsd: number;
  medianPerRunUsd: number;
  maxPerRunUsd: number;
} {
  const costs = runs
    .map((r) => r.costUsd)
    .filter((c): c is number => typeof c === 'number' && c >= 0);
  if (costs.length === 0) {
    return {
      runCount: runs.length,
      weeklyTotalUsd: 0,
      avgPerRunUsd: 0,
      medianPerRunUsd: 0,
      maxPerRunUsd: 0,
    };
  }
  const total = costs.reduce((a, b) => a + b, 0);
  const sorted = [...costs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  return {
    runCount: runs.length,
    weeklyTotalUsd: Number(total.toFixed(4)),
    avgPerRunUsd: Number((total / costs.length).toFixed(4)),
    medianPerRunUsd: Number(median.toFixed(4)),
    maxPerRunUsd: Number(max.toFixed(4)),
  };
}

// Build a strategy-aware system prompt by injecting the cast's names
// + personalities into the base MEETING_SYSTEM_PROMPT. Claude then
// writes the transcript with these specific characters in mind.
function buildMeetingSystemPrompt(
  cast: CastBundle,
  guest: { role: 'michael_burrybot'; name: string; personality: string } | null
): string {
  const roster = Object.values(cast.characters)
    .map((c) => `  • role "${c.role}" → ${c.name}: ${c.personality}`)
    .join('\n');
  // Guest block — when Burrybot is on, add him as a 6th role with
  // tightly-scoped guest constraints. He speaks, but he does NOT drive
  // the meeting, he does NOT propose policy changes (no partner
  // authority), and he is capped at ≤3 turns. If he's absent the block
  // is empty.
  const guestBlock = guest
    ? `\n  • role "${guest.role}" → ${guest.name} (GUEST ANALYST): ${guest.personality}\n\nGUEST RULES (Burrybot):\n  • ≤3 transcript turns across the whole meeting. Every turn must cite a specific number, ticker, or filing detail.\n  • NOT the final decision-maker. The firm's principal decides; Burrybot's role is to inform and dissent productively.\n  • He does NOT propose policyChanges. He MAY suggest actionItems with kind='research' when he flags a name worth the firm's deep-read.\n  • Voice: deferential but direct ("you've been doing this longer, but the Q3 footnote says…"). Introverted, narrow, data-driven. Never schmoozes. Never cheerleads.`
    : '';
  return `${MEETING_SYSTEM_PROMPT}

The current meeting's cast is:
${roster}${guestBlock}

When writing transcript turns, use the \`role\` keys above in the role field, but refer to characters by their names inside dialogue (e.g. "I think Mung-bot raised a fair point…"). Stay in character for each role's personality; these are satirical -bot variants, not real people.`;
}

// Minimal snapshot of the cast to persist on the Meeting row so the
// display + comic generator can reconstruct which characters were
// active, even years later. When a guest was present, his sheet is
// folded in under the guest role key so the comic generator can reuse
// the same visual when rendering.
function castSnapshot(
  cast: CastBundle,
  guest?: { role: 'michael_burrybot'; name: string; personality: string; visual: string } | null
): MeetingOutput['cast'] {
  const characters = Object.fromEntries(
    Object.entries(cast.characters).map(([role, c]) => [
      role,
      { name: c.name, personality: c.personality, visual: c.visual },
    ])
  ) as NonNullable<MeetingOutput['cast']>['characters'];
  if (guest) {
    (characters as Record<string, { name: string; personality: string; visual: string }>)[
      guest.role
    ] = { name: guest.name, personality: guest.personality, visual: guest.visual };
  }
  return {
    strategyKey: String(cast.strategyKey),
    characters,
  };
}
