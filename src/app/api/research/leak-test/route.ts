// POST /api/research/leak-test
//
// Mobile-friendly entry point for the W0 lookahead leak test. The CLI
// at scripts/lookahead-leak-test.ts is the source of truth for the
// experiment; this route wraps the same runLeakBatch + SSE-streams
// per-pair progress so a user without shell access can run W0 from
// the agbro app.
//
// Body: { model: 'haiku' | 'opus', costCapUsd: number, pairsName?: string }
// Stream events: 'progress' (per pair) → 'summary' (final) → end
//
// Auth: requireUser. The test calls Anthropic with the user's BYOK
// key; budget kill-switch and per-call recording flow through the
// usual ApiSpendLog path.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { apiError, requireUser } from '@/lib/api';
import {
  runLeakPair,
  type LeakPair,
  type LeakPairResult,
} from '@/lib/agents/lookahead/leak-test';
import { FAST_MODEL, TRADE_DECISION_MODEL } from '@/lib/agents/models';
import { recordApiSpend } from '@/lib/safety/api-spend-log';
import { getUserCredential } from '@/lib/credentials';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
// 600s ceiling. Haiku 61-pair takes ~5 min sequential. Opus would
// blow this; the UI gates Opus behind an explicit toggle and warns.
export const maxDuration = 600;

const Body = z.object({
  // Provider dispatch — 'anthropic' uses the Anthropic SDK + agbro's
  // own ANTHROPIC_API_KEY env; 'openai' fetches the user's OpenAI
  // BYOK key via getUserCredential.
  provider: z.enum(['anthropic', 'openai']).default('anthropic'),
  // Either the friendly preset names (haiku/opus) for Anthropic
  // backwards-compat, or a literal model ID for any provider.
  model: z.string().default('haiku'),
  // Soft cost cap — runner stops mid-batch if exceeded.
  costCapUsd: z.number().positive().max(50).default(1.0),
  // Default uses the bundled 61-pair fixture. UI doesn't expose
  // alternates yet but the route accepts a name for future flexibility.
  pairsName: z.string().default('pairs-2026-05.json'),
});

function resolveModel(provider: 'anthropic' | 'openai', input: string): string {
  if (provider === 'anthropic') {
    if (input === 'haiku') return FAST_MODEL;
    if (input === 'opus') return TRADE_DECISION_MODEL;
    return input; // already a literal model ID
  }
  // OpenAI: pass through whatever the user typed. Defaults the
  // ambiguous 'haiku'/'opus' inputs to gpt-5 so a user who didn't
  // change the field gets a sensible request.
  if (input === 'haiku' || input === 'opus' || !input) return 'gpt-5';
  return input;
}

function loadPairs(name: string): LeakPair[] {
  // Restrict to the canonical research dir to prevent path traversal.
  if (!/^[a-zA-Z0-9_.-]+\.json$/.test(name)) {
    throw new Error(`invalid pairs name: ${name}`);
  }
  const path = join(process.cwd(), 'research', 'leak-test', name);
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('pairs file must be an array');
  return parsed as LeakPair[];
}

function sseEncode(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const body = await req.json().catch(() => ({}));
    const args = Body.parse(body);
    const model = resolveModel(args.provider, args.model);
    const pairs = loadPairs(args.pairsName);

    // OpenAI dispatch needs the user's BYOK key. Fetch upfront so a
    // missing-key error is reported BEFORE we open the SSE stream
    // (cleaner UX than trickling a per-pair error 61 times).
    let openaiKey: string | null = null;
    if (args.provider === 'openai') {
      openaiKey = await getUserCredential(user.id, 'openai').catch(() => null);
      if (!openaiKey) {
        return NextResponse.json(
          {
            error:
              'No OpenAI API key on file. Add one in Settings → API keys, then retry.',
          },
          { status: 400 }
        );
      }
    }

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(sseEncode(event, data));
        };

        send('start', {
          provider: args.provider,
          model,
          pairCount: pairs.length,
          costCapUsd: args.costCapUsd,
          pairsName: args.pairsName,
        });

        const client = args.provider === 'anthropic' ? new Anthropic() : undefined;
        const results: LeakPairResult[] = [];
        let totalCostUsd = 0;
        let aborted = false;
        let abortReason: string | null = null;

        for (let i = 0; i < pairs.length; i++) {
          if (totalCostUsd >= args.costCapUsd) {
            aborted = true;
            abortReason = `cost cap $${args.costCapUsd} reached after ${i} pairs`;
            break;
          }
          try {
            const r = await runLeakPair({
              pair: pairs[i],
              model,
              provider: args.provider,
              client,
              openaiKey: openaiKey ?? undefined,
            });
            results.push(r);
            const pairCost = r.strict.costUsd + r.unrestricted.costUsd;
            totalCostUsd += pairCost;
            // Persist spend so MTD aggregation reflects it.
            await recordApiSpend({
              userId: user.id,
              kind: 'deep_research',
              model,
              costUsd: pairCost,
              metadata: {
                source: 'leak_test',
                provider: args.provider,
                symbol: pairs[i].symbol,
                decisionDate: pairs[i].decisionDateISO,
              },
            });
            send('progress', {
              i: i + 1,
              total: pairs.length,
              symbol: pairs[i].symbol,
              decisionDateISO: pairs[i].decisionDateISO,
              strictTarget: r.strict.parsed?.twelve_month_price_target_usd ?? null,
              unrestrictedTarget:
                r.unrestricted.parsed?.twelve_month_price_target_usd ?? null,
              actualReturnPct: r.actualReturnPct,
              unrestrictedCloserToActual: r.unrestrictedCloserToActual,
              pairCostUsd: pairCost,
              totalCostUsd,
            });
          } catch (err) {
            log.error('leak_test.pair_failed', err, {
              userId: user.id,
              symbol: pairs[i].symbol,
            });
            send('pair_error', {
              i: i + 1,
              symbol: pairs[i].symbol,
              error: (err as Error).message.slice(0, 200),
            });
          }
        }

        // Compute the same summary shape the CLI does.
        const valid = results.filter(
          (r) => r.unrestrictedCloserToActual != null
        );
        const winners = valid.filter((r) => r.unrestrictedCloserToActual);
        const unrestrictedWinRate =
          valid.length > 0 ? winners.length / valid.length : null;
        const targetDivergences = results
          .map((r) => {
            if (
              r.decisionPrice == null ||
              r.strict.parsed == null ||
              r.unrestricted.parsed == null
            )
              return null;
            return (
              Math.abs(
                r.strict.parsed.twelve_month_price_target_usd -
                  r.unrestricted.parsed.twelve_month_price_target_usd
              ) / r.decisionPrice
            );
          })
          .filter((v): v is number => v != null);
        const meanTargetDivergencePct =
          targetDivergences.length > 0
            ? targetDivergences.reduce((s, v) => s + v, 0) / targetDivergences.length
            : null;
        const convictions = results
          .map((r) => r.convictionDivergence)
          .filter((v): v is number => v != null);
        const meanConvictionDivergence =
          convictions.length > 0
            ? convictions.reduce((s, v) => s + v, 0) / convictions.length
            : null;

        send('summary', {
          model,
          pairCount: pairs.length,
          completed: results.length,
          parsedBoth: results.filter(
            (r) => r.strict.parsed != null && r.unrestricted.parsed != null
          ).length,
          withActualReturn: results.filter((r) => r.actualReturnPct != null)
            .length,
          unrestrictedWinRate,
          meanTargetDivergencePct,
          meanConvictionDivergence,
          totalCostUsd,
          aborted,
          abortReason,
        });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    return apiError(err, 500, 'leak test failed', 'research.leak_test');
  }
}
