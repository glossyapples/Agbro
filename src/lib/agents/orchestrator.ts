// The wake-up loop. On every tick (or manual trigger), we:
//   1. Create an AgentRun row
//   2. Spin up a Claude Opus 4.7 session with the trade-decision tools
//   3. Let it run until it calls `finalize_run`
//   4. Persist every tool use as an AgentDecision
//
// Trade decisions are HARDCODED to Opus 4.7. See models.ts.

import Anthropic from '@anthropic-ai/sdk';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { TRADE_DECISION_MODEL, assertTradeModel } from './models';
import { AGBRO_PRINCIPLES } from './prompts';
import { TOOL_DEFS, runTool } from './tools';

const MAX_TURNS = 16;
const MAX_TOOL_OUTPUT_BYTES = 60_000;
const TRUNCATION_MARKER = '\n…[truncated by orchestrator]';

export type RunAgentArgs = {
  userId: string;
  trigger: 'schedule' | 'manual' | 'user_deposit' | 'market_event';
};

export type RunAgentResult = {
  agentRunId: string;
  decision: string | null;
  summary: string | null;
  status: string;
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');

  const client = new Anthropic({ apiKey });
  const run = await prisma.agentRun.create({
    data: {
      trigger: args.trigger,
      model: TRADE_DECISION_MODEL,
      status: 'running',
    },
  });

  const ctx = { agentRunId: run.id, userId: args.userId };
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        `Wake up. Trigger: ${args.trigger}. Start by reading the brain and the current account state. ` +
        `End with finalize_run when you're done. Remember your two goals: preserve principal, then grow it.`,
    },
  ];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const resp = await client.messages.create({
        model: TRADE_DECISION_MODEL,
        max_tokens: 4096,
        system: AGBRO_PRINCIPLES,
        tools: TOOL_DEFS,
        messages,
      });

      messages.push({ role: 'assistant', content: resp.content });

      const toolUses = resp.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      // Record any text blocks as decisions (rationale traces).
      const textBlocks = resp.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text'
      );
      for (const t of textBlocks) {
        await prisma.agentDecision.create({
          data: { agentRunId: run.id, kind: 'thought', payload: { text: t.text } },
        });
      }

      if (toolUses.length === 0 || resp.stop_reason === 'end_turn') {
        // Agent stopped without finalising — capture and exit.
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
        try {
          result = await runTool(use.name, use.input as Record<string, unknown>, ctx);
        } catch (err) {
          isError = true;
          result = { error: (err as Error).message };
        }
        const serialized = JSON.stringify(result, bigintReplacer);
        const truncated = serialized.length > MAX_TOOL_OUTPUT_BYTES;
        const content = truncated
          ? serialized.slice(0, MAX_TOOL_OUTPUT_BYTES - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
          : serialized;
        if (truncated) {
          console.warn(
            `agent.tool_output_truncated name=${use.name} runId=${run.id} bytes=${serialized.length}`
          );
        }
        const decisionPayload = {
          name: use.name,
          input: use.input,
          output: result,
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
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'errored',
        endedAt: new Date(),
        errorMessage: (err as Error).message,
      },
    });
    throw err;
  }

  const final = await prisma.agentRun.findUnique({ where: { id: run.id } });
  return {
    agentRunId: run.id,
    decision: final?.decision ?? null,
    summary: final?.summary ?? null,
    status: final?.status ?? 'unknown',
  };
}

async function skipRun(userId: string, trigger: string, reason: string): Promise<RunAgentResult> {
  const run = await prisma.agentRun.create({
    data: {
      trigger,
      model: TRADE_DECISION_MODEL,
      status: 'skipped',
      summary: `Skipped: ${reason}`,
      endedAt: new Date(),
    },
  });
  return { agentRunId: run.id, decision: null, summary: run.summary, status: 'skipped' };
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}
