// The wake-up loop. On every tick (or manual trigger), we:
//   1. Sync local positions from Alpaca (keeps the UI honest)
//   2. Create an AgentRun row (atomically — refuses if another run is in flight
//      for this user, so two overlapping cron ticks or a manual trigger during
//      a cron run can't spawn parallel orchestrators)
//   3. Spin up a Claude Opus 4.7 session with the trade-decision tools
//   4. Let it run until it calls `finalize_run` (or hits MAX_TURNS)
//   5. Persist every tool use as an AgentDecision
//   6. Sum Anthropic token usage → cost USD on the AgentRun row
//
// On EVERY exit path — finalize_run, end_turn, exception, MAX_TURNS fall-through
// — AgentRun.status is moved off 'running' so an inflight check is authoritative.
//
// Trade decisions are HARDCODED to Opus 4.7. See models.ts.

import Anthropic from '@anthropic-ai/sdk';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { TRADE_DECISION_MODEL, assertTradeModel } from './models';
import { AGBRO_PRINCIPLES } from './prompts';
import { TOOL_DEFS, runTool } from './tools';
import { child } from '@/lib/logger';
import { estimateCostUsd, type TokenUsage } from '@/lib/pricing';
import {
  loadMeetingPriorities,
  renderPrioritiesForWakePrompt,
  markPrioritiesSeen,
} from './meeting-priorities';
import { getPositions } from '@/lib/alpaca';
import { toCents } from '@/lib/money';
import { refreshEarningsDate } from '@/lib/data/earnings';

const MAX_TURNS = 16;
const MAX_TOOL_OUTPUT_BYTES = 60_000;
const TRUNCATION_MARKER = '\n…[truncated by orchestrator]';

// Soft-lock window. A run that hasn't terminated within this window is treated
// as orphaned (process crash mid-run) and ignored by the inflight check. Must
// be >= the longest we'd expect the orchestrator to take, with headroom.
const INFLIGHT_STALE_MS = 10 * 60_000; // 10 minutes

export class AgentRunInflightError extends Error {
  readonly inflightRunId: string;
  constructor(inflightRunId: string) {
    super(`agent run already in flight: ${inflightRunId}`);
    this.name = 'AgentRunInflightError';
    this.inflightRunId = inflightRunId;
  }
}

export type RunAgentArgs = {
  userId: string;
  trigger: 'schedule' | 'manual' | 'user_deposit' | 'market_event';
};

export type RunAgentResult = {
  agentRunId: string;
  decision: string | null;
  summary: string | null;
  status: string;
  costUsd?: number;
};

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  assertTradeModel(TRADE_DECISION_MODEL);

  const account = await prisma.account.findUnique({ where: { userId: args.userId } });
  if (!account) throw new Error('account not found');
  if (account.isStopped) {
    return skipRun(args.userId, args.trigger, 'account_stopped');
  }
  if (account.isPaused) {
    return skipRun(args.userId, args.trigger, 'account_paused');
  }
  // Kill-switch gate — the cron path already runs checkKillSwitches
  // before dispatching, but the manual /api/agents/run path previously
  // skipped it, letting a user "Run now" click through to a halted
  // account whose isPaused flag hadn't been re-set. Checking the
  // persisted trigger fields here means every run-start honours the
  // halt, regardless of how it was invoked.
  if (account.killSwitchTriggeredAt != null) {
    return skipRun(
      args.userId,
      args.trigger,
      `kill_switch_active: ${account.killSwitchReason ?? 'unspecified'}`.slice(0, 200)
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');

  const client = new Anthropic({ apiKey });

  // Atomic create with inflight check. Locks the Account row for this user so
  // two concurrent callers serialize; whichever runs second sees the first's
  // 'running' AgentRun and bails with AgentRunInflightError. A 'running' run
  // older than INFLIGHT_STALE_MS is treated as orphaned (process crash) and
  // is not a barrier — the old run gets swept to 'errored' inside the same
  // transaction so the new run has a clean slate.
  const run = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "Account" WHERE "userId" = ${args.userId} FOR UPDATE`;

    const staleCutoff = new Date(Date.now() - INFLIGHT_STALE_MS);
    await tx.agentRun.updateMany({
      where: { userId: args.userId, status: 'running', startedAt: { lt: staleCutoff } },
      data: { status: 'errored', endedAt: new Date(), errorMessage: 'orphaned run swept on next start' },
    });

    const inflight = await tx.agentRun.findFirst({
      where: { userId: args.userId, status: 'running' },
      select: { id: true },
    });
    if (inflight) throw new AgentRunInflightError(inflight.id);

    return tx.agentRun.create({
      data: {
        userId: args.userId,
        trigger: args.trigger,
        model: TRADE_DECISION_MODEL,
        status: 'running',
      },
    });
  });

  const log = child({ agentRunId: run.id, userId: args.userId });
  log.info('agent.run.start', { trigger: args.trigger, model: TRADE_DECISION_MODEL });

  // Best-effort: sync local positions from the broker before the agent runs
  // so `get_positions` reflects reality. Failures here don't block the run —
  // the agent's own `get_positions` tool hits Alpaca directly anyway.
  await syncPositions(args.userId).catch((err) => {
    log.warn('agent.position_sync_failed', undefined, err);
  });

  // Refresh earnings dates for every stock position the user currently
  // holds. The earnings-blackout rule gates new buys on nextEarningsAt, but
  // that field goes stale for long-held positions (a 6-month-held stock
  // has gone through 2 earnings cycles). refreshEarningsDate is itself
  // rate-limited to 30d per symbol, so this is a no-op most of the time.
  // Failures are per-symbol and never block the run.
  try {
    const held = await prisma.position.findMany({
      where: { userId: args.userId, assetClass: 'stock' },
      select: { symbol: true },
    });
    for (const p of held) {
      await refreshEarningsDate(p.symbol).catch((err) => {
        log.warn('agent.earnings_refresh_failed', { symbol: p.symbol }, err);
      });
    }
  } catch (err) {
    log.warn('agent.earnings_refresh_phase_failed', undefined, err);
  }

  const ctx = { agentRunId: run.id, userId: args.userId };

  // Meeting → orchestrator handoff. Open research / review items from
  // the most recent executive meeting become explicit priorities in
  // the wake prompt. Graduated trust: auto-queue research and review
  // items (low blast radius — they only affect what the agent *looks
  // at*, not what it trades), but NEVER auto-apply policy changes
  // (those surface as accept/reject PolicyChange cards in the UI).
  const meetingPriorities = await loadMeetingPriorities(args.userId).catch(
    () => [] as Awaited<ReturnType<typeof loadMeetingPriorities>>
  );
  const prioritiesBlock = renderPrioritiesForWakePrompt(meetingPriorities);
  // Stamp executedBy now rather than on completion — audit trail
  // captures "which run saw this item", regardless of whether the
  // agent ends up doing anything with it. The next meeting reviews
  // and marks completed.
  await markPrioritiesSeen(meetingPriorities, run.id).catch((err) => {
    log.warn('agent.meeting_priorities_stamp_failed', undefined, err);
  });

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        `Wake up. Trigger: ${args.trigger}. Start by reading the brain and the current account state. ` +
        `End with finalize_run when you're done. Remember your two goals: preserve principal, then grow it.` +
        prioritiesBlock,
    },
  ];

  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const resp = await client.messages.create({
        model: TRADE_DECISION_MODEL,
        max_tokens: 4096,
        system: AGBRO_PRINCIPLES,
        tools: TOOL_DEFS,
        messages,
      });

      // Accumulate token usage across every turn so AgentRun.costUsd reflects
      // the full run, not just the final turn. The cache fields are present
      // on the wire but not typed in @anthropic-ai/sdk@0.30.1; index-access
      // keeps us forward-compatible when the SDK adds them.
      const u = resp.usage as unknown as Record<string, number | undefined> | undefined;
      if (u) {
        totalUsage.inputTokens += u.input_tokens ?? 0;
        totalUsage.outputTokens += u.output_tokens ?? 0;
        totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        totalUsage.cacheWriteTokens = (totalUsage.cacheWriteTokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }

      messages.push({ role: 'assistant', content: resp.content });

      const toolUses = resp.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );
      const textBlocks = resp.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text'
      );
      for (const t of textBlocks) {
        await prisma.agentDecision.create({
          data: { agentRunId: run.id, kind: 'thought', payload: { text: t.text } },
        });
      }

      if (toolUses.length === 0 || resp.stop_reason === 'end_turn') {
        await prisma.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'completed',
            endedAt: new Date(),
            summary:
              textBlocks.map((t) => t.text).join('\n').slice(0, 4000) ||
              'Run ended without explicit finalize_run.',
          },
        });
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let finalized = false;

      for (const use of toolUses) {
        let result: unknown;
        let isError = false;
        // One log line per tool invocation so a month of runs can be
        // surveyed for "which tools did the agent actually use?" without
        // parsing the full transcript. Cheap at the scale we run (dozens
        // of tool calls per run, a few runs per day).
        const toolStart = Date.now();
        log.info('agent.tool_called', { tool: use.name });
        try {
          result = await runTool(use.name, use.input as Record<string, unknown>, ctx);
        } catch (err) {
          isError = true;
          result = { error: (err as Error).message };
          log.warn('agent.tool_error', { tool: use.name, durationMs: Date.now() - toolStart }, err);
        }
        const serialized = JSON.stringify(result, bigintReplacer);
        const truncated = serialized.length > MAX_TOOL_OUTPUT_BYTES;
        const content = truncated
          ? serialized.slice(0, MAX_TOOL_OUTPUT_BYTES - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
          : serialized;
        if (truncated) {
          log.warn('agent.tool_output_truncated', { tool: use.name, bytes: serialized.length });
        }
        // Deep-convert bigints in the output before Prisma sees it.
        // Previously `output: result` went into InputJsonValue raw, and
        // any nested bigint (e.g. evaluate_exits' unrealizedLossCents)
        // crashed the agentDecision insert. Re-parsing the already-
        // bigint-safe serialized form guarantees a JSON-clean object.
        const safeResultForStorage = JSON.parse(serialized);
        const decisionPayload = {
          name: use.name,
          input: use.input,
          output: safeResultForStorage,
          isError,
          truncated,
          outputBytes: serialized.length,
        } as unknown as Prisma.InputJsonValue;
        await prisma.agentDecision.create({
          data: {
            agentRunId: run.id,
            kind: 'tool_call',
            payload: decisionPayload,
          },
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content,
          is_error: isError,
        });
        if (use.name === 'finalize_run') finalized = true;
      }

      messages.push({ role: 'user', content: toolResults });

      if (finalized) break;
    }
  } catch (err) {
    const costUsd = estimateCostUsd(TRADE_DECISION_MODEL, totalUsage);
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'errored',
        endedAt: new Date(),
        errorMessage: (err as Error).message,
        costUsd,
      },
    });
    log.error('agent.run.errored', err, { costUsd, usage: totalUsage });
    throw err;
  }

  const costUsd = estimateCostUsd(TRADE_DECISION_MODEL, totalUsage);

  // Belt-and-suspenders: if the loop fell through MAX_TURNS without the agent
  // ever calling finalize_run and without stop_reason='end_turn' (which both
  // set status='completed' above), move it off 'running' so the inflight check
  // on the next tick doesn't treat this run as still live. Use updateMany with
  // a status='running' guard so we never clobber an already-terminal row.
  await prisma.agentRun.updateMany({
    where: { id: run.id, status: 'running' },
    data: {
      status: 'exhausted_turns',
      endedAt: new Date(),
      summary:
        `Hit MAX_TURNS (${MAX_TURNS}) without calling finalize_run. ` +
        `The agent ran out of turns — likely too much research or looping tool calls.`,
      costUsd,
    },
  });

  // Separately, always persist costUsd (the updateMany above only fires on the
  // MAX_TURNS path; the completed/finalize paths set costUsd here).
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { costUsd },
  });

  const final = await prisma.agentRun.findUnique({ where: { id: run.id } });
  log.info('agent.run.end', {
    status: final?.status,
    decision: final?.decision,
    costUsd,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
  });
  return {
    agentRunId: run.id,
    decision: final?.decision ?? null,
    summary: final?.summary ?? null,
    status: final?.status ?? 'unknown',
    costUsd,
  };
}

async function skipRun(userId: string, trigger: string, reason: string): Promise<RunAgentResult> {
  const run = await prisma.agentRun.create({
    data: {
      userId,
      trigger,
      model: TRADE_DECISION_MODEL,
      status: 'skipped',
      summary: `Skipped: ${reason}`,
      endedAt: new Date(),
    },
  });
  return { agentRunId: run.id, decision: null, summary: run.summary, status: 'skipped' };
}

// Pull Alpaca positions and upsert the local Position table so the UI and
// downstream analytics reflect broker truth. Positions no longer held at the
// broker are deleted from the local table.
async function syncPositions(userId: string): Promise<void> {
  const raw = await getPositions();
  if (!Array.isArray(raw)) return;
  type RawPosition = { symbol?: string; qty?: string | number; avg_entry_price?: string | number };
  const broker = (raw as RawPosition[])
    .map((p) => ({
      symbol: String(p.symbol ?? '').toUpperCase(),
      qty: Number(p.qty ?? 0),
      avgCostCents: toCents(Number(p.avg_entry_price ?? 0)),
    }))
    .filter((p) => p.symbol && Number.isFinite(p.qty));

  const brokerSymbols = Array.from(new Set(broker.map((p) => p.symbol)));

  await prisma.$transaction([
    // Upsert everything the broker is reporting.
    ...broker.map((p) =>
      prisma.position.upsert({
        where: { userId_symbol: { userId, symbol: p.symbol } },
        update: { qty: p.qty, avgCostCents: p.avgCostCents, lastSyncedAt: new Date() },
        create: {
          userId,
          symbol: p.symbol,
          qty: p.qty,
          avgCostCents: p.avgCostCents,
        },
      })
    ),
    // Remove local rows the broker no longer reports (closed positions).
    // When brokerSymbols is empty, `notIn: []` would match everything — safe,
    // since it means the broker has zero positions for this user.
    prisma.position.deleteMany({
      where: { userId, symbol: { notIn: brokerSymbols } },
    }),
  ]);
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}
