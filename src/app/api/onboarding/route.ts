// Save the onboarding wizard answers. Stamps onboardingCompletedAt
// so the middleware stops redirecting. Every field is additive on
// top of the defaults laid down by bootstrapNewUser — the wizard
// captures the per-user refinements.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { isAutonomyLevel } from '@/lib/safety/autonomy';

export const runtime = 'nodejs';

const Body = z.object({
  planningAssumption: z.number().nonnegative().max(60),
  timeHorizonYears: z.number().int().min(1).max(60),
  maxPositionPct: z.number().min(1).max(40),
  drawdownPauseThresholdPct: z.number().min(-80).max(0),
  autonomyLevel: z.string().refine(isAutonomyLevel, { message: 'invalid autonomy level' }),
  forbiddenSectors: z.array(z.string().max(64)).max(20).default([]),
  forbiddenSymbols: z.array(z.string().max(12)).max(50).default([]),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const v = parsed.data;
    await prisma.account.update({
      where: { userId: user.id },
      data: {
        planningAssumption: v.planningAssumption,
        timeHorizonYears: v.timeHorizonYears,
        maxPositionPct: v.maxPositionPct,
        drawdownPauseThresholdPct: v.drawdownPauseThresholdPct,
        autonomyLevel: v.autonomyLevel,
        // Store both lists as upper-case / trimmed to keep matching
        // case-insensitive at check time without repeating the work.
        forbiddenSectors: Array.from(
          new Set(v.forbiddenSectors.map((s) => s.trim()).filter((s) => s.length > 0))
        ),
        forbiddenSymbols: Array.from(
          new Set(v.forbiddenSymbols.map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0))
        ),
        onboardingCompletedAt: new Date(),
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err, 500, 'onboarding save failed', 'onboarding.save');
  }
}
