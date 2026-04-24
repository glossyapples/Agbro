// POST /api/strategy/[id]/form-hypothesis — one-shot "first research
// session" for Burrybot on a strategy. Writes 5-10 hypothesis brain
// entries tagged with the strategy id so the UI can hide the button
// once done. Only allowed when Burrybot is enabled on the strategy
// (either guest mode or the Burry firm itself).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';
import {
  burryHypothesesFormed,
  formBurryHypotheses,
} from '@/lib/brain/burry-hypotheses';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  // Burrybot hypothesis formation is an LLM call that costs real money
  // — cap at 3/hour per user so a stuck button or automated clicker
  // can't run a meaningful bill.
  const gate = await checkLimit(user.id, 'burry.hypothesis');
  if (!gate.success) return rateLimited(gate);

  try {
    const strategy = await prisma.strategy.findFirst({
      where: { id: params.id, userId: user.id },
      select: {
        id: true,
        name: true,
        allowBurryGuest: true,
      },
    });
    if (!strategy) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const isBurryFirm = strategy.name.toLowerCase().includes('burry');
    if (!isBurryFirm && !strategy.allowBurryGuest) {
      return NextResponse.json(
        {
          error:
            'Burrybot is not enabled on this strategy. Toggle him on first.',
        },
        { status: 400 }
      );
    }
    const already = await burryHypothesesFormed(user.id, strategy.id);
    if (already) {
      return NextResponse.json(
        {
          error:
            'Burrybot already ran his first-research session for this strategy.',
        },
        { status: 409 }
      );
    }
    const result = await formBurryHypotheses({
      userId: user.id,
      strategyId: strategy.id,
    });
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    return apiError(
      err,
      500,
      'failed to form hypotheses',
      'strategy.form_hypothesis'
    );
  }
}
