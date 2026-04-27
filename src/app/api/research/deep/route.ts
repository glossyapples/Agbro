// POST /api/research/deep — runs the deep-research agent for a single
// symbol on demand. Triggered by the "Research" button on each holding.
//
// Cost per call is bounded by the agent's max-tokens cap (~$0.50-1.50
// with Opus 4.7). Rate-limited via the default bucket so a user
// can't accidentally burn $50 by spam-clicking the button.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';
import { runDeepResearch } from '@/lib/agents/deep-research';

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
    return apiError(err, 500, 'deep research failed', 'research.deep.post');
  }
}
