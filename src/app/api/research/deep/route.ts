// POST /api/research/deep — runs the deep-research agent for a single
// symbol on demand. Triggered by the "Research" button on each holding.
//
// Cost per call is bounded by the agent's max-tokens cap (~$0.50-1.50
// with Opus 4.7). Rate-limited via the default bucket so a user
// can't accidentally burn $50 by spam-clicking the button.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';
import { runDeepResearch } from '@/lib/agents/deep-research';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
// Extended thinking + the network round-trip can take 30-60s for a
// dense response. 120s gives headroom without letting a hung call
// pile up.
export const maxDuration = 120;

const Body = z.object({
  symbol: z.string().min(1).max(12),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const gate = await checkLimit(user.id, 'default');
  if (!gate.success) return rateLimited(gate);

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', detail: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const result = await runDeepResearch({
      userId: user.id,
      symbol: parsed.data.symbol,
    });
    return NextResponse.json({
      ok: true,
      symbol: result.symbol,
      output: result.output,
      costUsd: result.costUsd,
      noteId: result.noteId,
      createdAtISO: result.createdAtISO,
    });
  } catch (err) {
    // Plumb the actual error message back to the modal — the user is
    // the audience-tester and a generic "deep research failed" string
    // gives them no path to diagnose. The full stack is still in the
    // server log via apiError -> log.error; we just also surface the
    // .message on the wire for the UI to render.
    const message = err instanceof Error ? err.message : 'deep research failed';
    log.error('research.deep.post', err, { symbol: parsed.data.symbol });
    return NextResponse.json(
      {
        error: message.slice(0, 500),
        // Keep a stable shape so the modal can decide whether to show
        // the message verbatim or wrap it in a friendlier label.
        kind: classifyError(err),
      },
      { status: 500 }
    );
  }
}

function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  if (msg.includes('anthropic') || msg.includes('api key') || msg.includes('api_key')) return 'anthropic_auth';
  if (msg.includes('rate') && msg.includes('limit')) return 'rate_limit';
  if (msg.includes('unparseable') || msg.includes('parse')) return 'model_output_parse';
  if (msg.includes('invalid symbol')) return 'invalid_symbol';
  if (msg.includes('timeout') || msg.includes('aborted')) return 'timeout';
  return 'unknown';
}
