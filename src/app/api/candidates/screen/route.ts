// POST /api/candidates/screen — user-triggered manual screen.
//
// Unlike the agent path (which enforces the 7-day cooldown inside the
// screener itself), the user path BYPASSES the cooldown. Rationale: if
// you're tapping the button, you're paying attention for a reason — we
// shouldn't second-guess you. The rate-limit exists to stop the agent
// from burning Perplexity credits every wake-up, not to gate you.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { apiError, requireUser } from '@/lib/api';
import { runScreen } from '@/lib/data/screener';

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z
  .object({
    minRoePct: z.number().finite().min(0).max(200).optional(),
    maxPeRatio: z.number().finite().positive().max(200).optional(),
    minDividendYieldPct: z.number().finite().min(0).max(50).optional(),
    preferredSectors: z.array(z.string().max(64)).max(12).optional(),
    thesisHint: z.string().max(500).optional(),
  })
  .optional();

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const raw = await req.json().catch(() => ({}));
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const result = await runScreen(parsed.data ?? {}, { bypassCooldown: true });
    revalidatePath('/candidates');
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err, 500, 'manual screen failed', 'candidates.screen');
  }
}
