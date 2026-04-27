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
import { TOOL_DEFS, runTool, isMutatingTool } from './tools';
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

// Extended thinking: lets Opus 4.7 reason in a private scratchpad
// before each tool call. Reasoning quality on multi-factor decisions
// (worth-buying vs MoS vs earnings vs sizing) materially improves at
// the cost of a few thousand thinking tokens per turn (billed at
// output rate). 8 000 tokens is the documented sweet spot for
// "complex tool decisions" in Anthropic's guidance — large enough
// for genuine deliberation, small enough that runaway costs are
// capped. Override via AGBRO_THINKING_BUDGET=N or disable entirely
// with AGBRO_THINKING_DISABLED=true if a regression appears in
// production.
const THINKING_BUDGET_TOKENS = (() => {
  const raw = process.env.AGBRO_THINKING_BUDGET;
  if (!raw) return 8_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1024 && n <= 32_000 ? n : 8_000;
})();
// max_tokens MUST exceed thinking budget per Anthropic's API. The
// non-thinking output (text + tool_use blocks) is small relative to
// the thinking trace, so 4 000 tokens of headroom is plenty.
const MAX_OUTPUT_TOKENS = THINKING_BUDGET_TOKENS + 4_096;

// Soft-lock window. A run that hasn't terminated within this window is treated
// as orphaned (process crash mid-run) and ignored by the inflight check. Must
// be >= the longest we'd expect the orchestrator to take, with headroom.
// 30 minutes. A healthy research-heavy run with 16 turns + multiple
// Perplexity/Google round-trips + fundamentals backfill can legitimately
// take 15-20 minutes; the previous 10-minute window risked sweeping a
// live run to 'errored' mid-flight, letting a concurrent trigger spawn
// a parallel run while the original was still working. 30 minutes is
// comfortably above observed worst-case without making a truly crashed
// run linger too long before the next cron can recover.
const INFLIGHT_STALE_MS = 30 * 60_000;

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
    // Re-assert isPaused without touching killSwitchTriggeredAt or the
    // reason — covers the case where isPaused was flipped back to
    // false out-of-band (manual DB edit, partial clear) while the
    // persisted trip is still live. Not using applyKillSwitch here
    // because that would overwrite the original trip timestamp, losing
    // the audit trail of when the safety rail actually fired.
    if (!account.isPaused) {
      await prisma.account
        .update({
          where: { userId: args.userId },
          data: { isPaused: true },
        })
        .catch(() => {
          // Best-effort re-pause; the skip below still halts this run
          // regardless of whether the write succeeded.
        });
    }
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

  // Prompt caching — the system prompt (~5k tokens) + tool definitions
  // (~1.2k tokens) are static across every turn of every run. Marking
  // the last tool with `cache_control: ephemeral` caches the entire
  // request prefix (system + all tools) so turns 2+ and subsequent
  // runs within the 5-min window read it at $1.50/MTok (Opus cache-
  // read) instead of $15/MTok (input). Typical calm run saves 60-70%
  // on input cost; first turn pays the one-time write premium
  // ($18.75/MTok) and breaks even after one cache hit.
  const cachedTools: Anthropic.Tool[] = TOOL_DEFS.map((t, i, arr) =>
    i === arr.length - 1
      ? ({ ...t, cache_control: { type: 'ephemeral' as const } } as Anthropic.Tool)
      : t
  );

  // Extended thinking is opt-out rather than opt-in — the sprint
  // assumption is "always on for the agent path". Operator escape
  // hatch via env var if a cost or latency regression shows up.
  //
  // Adaptive thinking (Opus 4.7's current API): the older
  // `thinking.type: 'enabled'` shape with budget_tokens is rejected
  // by the API (verified 2026-04-27 — broke the deep-research route
  // and the orchestrator). Switching to `adaptive` + an effort
  // knob. 'high' fits this use case (agent runs make real money
  // moves, reasoning depth matters). The SDK at 0.30.1 doesn't type
  // either field — conditional spread + cast keeps the call site
  // clean. See src/lib/agents/deep-research.ts for the same fix.
  const thinkingEnabled = process.env.AGBRO_THINKING_DISABLED !== 'true';
  const thinkingParam = thinkingEnabled
    ? ({
        thinking: { type: 'adaptive' as const },
        output_config: { effort: 'high' as const },
      } as unknown as Record<string, unknown>)
    : {};
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const resp = await client.messages.create({
        model: TRADE_DECISION_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: AGBRO_PRINCIPLES,
        tools: cachedTools,
        messages,
        // Adaptive thinking — see thinkingParam comment above.
        ...thinkingParam,
      });

      // Accumulate token usage across every turn so AgentRun.costUsd reflects
      // the full run, not just the final turn. The cache fields are present
      // on the wire but not typed in @anthropic-ai/sdk@0.30.1; index-access
      // keeps us forward-compatible when the SDK adds them.
      //
      // Extended-thinking tokens are bundled into `output_tokens` by the
      // Anthropic API (per their billing docs — thinking is billed at the
      // output rate). So the existing accounting captures them with no
      // pricing-module change. The cost-summary on /analytics will reflect
      // the bump automatically once a wake actually uses thinking.
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
      // Extended-thinking blocks. Persisting them as 'thought' rows
      // alongside text gives /decisions a full audit of how the agent
      // got to a decision — not just what it said externally. The
      // SDK's ContentBlock union in this version doesn't export the
      // 'thinking' variant explicitly, so we cast through `unknown`
      // and key off the `type` discriminator manually. Future SDK
      // upgrades that add the variant just narrow this for free.
      const thinkingBlocks = resp.content
        .filter((b) => (b as { type: string }).type === 'thinking')
        .map((b) => b as unknown as { type: 'thinking'; thinking: string });
      for (const t of textBlocks) {
        await prisma.agentDecision.create({
          data: { agentRunId: run.id, kind: 'thought', payload: { text: t.text } },
        });
      }
      for (const t of thinkingBlocks) {
        await prisma.agentDecision.create({
          data: {
            agentRunId: run.id,
            kind: 'thought',
            payload: { thinking: t.thinking, source: 'extended_thinking' },
          },
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

      // Decide whether this batch can run concurrently. Anthropic's
      // API has supported parallel tool_use blocks in a single
      // assistant turn; the orchestrator just hadn't been taking
      // advantage of it. If ANY tool in the batch is mutating, we
      // serialise the whole batch — strictly safer than interleaving
      // (no lost upserts, no out-of-order audit rows). Pure
      // read-only batches go parallel.
      const anyMutating = toolUses.some((u) => isMutatingTool(u.name));
      const batchMode = anyMutating ? 'serial' : 'parallel';
      log.debug('agent.tool_batch', {
        mode: batchMode,
        size: toolUses.length,
        names: toolUses.map((u) => u.name),
      });

      // Per-tool runner. Captures result-or-error in a structure so a
      // failing tool inside a parallel batch doesn't cancel its peers.
      // Keeps the existing logging + truncation + AgentDecision
      // persistence shape — only the dispatch loop changed.
      async function runOne(use: Anthropic.ToolUseBlock): Promise<{
        use: Anthropic.ToolUseBlock;
        content: string;
        isError: boolean;
      }> {
        let result: unknown;
        let isError = false;
        const toolStart = Date.now();
        log.debug('agent.tool_called', { tool: use.name });
        try {
          result = await runTool(use.name, use.input as Record<string, unknown>, ctx);
        } catch (err) {
          isError = true;
          result = { error: (err as Error).message };
          log.warn(
            'agent.tool_error',
            { tool: use.name, durationMs: Date.now() - toolStart },
            err
          );
        }
        const serialized = JSON.stringify(result, bigintReplacer);
        const truncated = serialized.length > MAX_TOOL_OUTPUT_BYTES;
        const content = truncated
          ? serialized.slice(0, MAX_TOOL_OUTPUT_BYTES - TRUNCATION_MARKER.length) +
            TRUNCATION_MARKER
          : serialized;
        if (truncated) {
          log.warn('agent.tool_output_truncated', {
            tool: use.name,
            bytes: serialized.length,
          });
        }
        // Deep-convert bigints in the output before Prisma sees it.
        // Previously `output: result` went into InputJsonValue raw,
        // and any nested bigint (e.g. evaluate_exits' unrealized
        // lossCents) crashed the agentDecision insert. Re-parsing the
        // already-bigint-safe serialized form guarantees a JSON-clean
        // object.
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
        return { use, content, isError };
      }

      const dispatched =
        batchMode === 'parallel'
          ? await Promise.all(toolUses.map(runOne))
          : await (async () => {
              const out: Awaited<ReturnType<typeof runOne>>[] = [];
              for (const u of toolUses) out.push(await runOne(u));
              return out;
            })();

      // Order tool_result blocks to match the order of tool_use blocks
      // the model emitted. Anthropic's API doesn't strictly require
      // this, but matching the input order keeps the per-turn audit
      // log readable.
      const byUseId = new Map(dispatched.map((d) => [d.use.id, d]));
      for (const use of toolUses) {
        const d = byUseId.get(use.id)!;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: d.content,
          is_error: d.isError,
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
