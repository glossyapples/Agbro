// POST /api/settings/safety — update the kill-switch thresholds.
// Bounded so a user can't accidentally disable their own safety net
// by typing a wild number.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

const Body = z.object({
  // -50% is the floor — we don't let the user disable daily-loss
  // protection via a wildly permissive value. 0 disables the check.
  dailyLossKillPct: z.number().min(-50).max(0),
  drawdownPauseThresholdPct: z.number().min(-80).max(0),
  // $100 minimum keeps the rail meaningful; $5M upper bound is sanity.
  maxTradeNotionalCents: z.number().int().min(10_000).max(500_000_000),
  allowAgentPolicyProposals: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    await prisma.account.update({
      where: { userId: user.id },
      data: {
        dailyLossKillPct: parsed.data.dailyLossKillPct,
        drawdownPauseThresholdPct: parsed.data.drawdownPauseThresholdPct,
        maxTradeNotionalCents: BigInt(parsed.data.maxTradeNotionalCents),
        ...(parsed.data.allowAgentPolicyProposals !== undefined
          ? { allowAgentPolicyProposals: parsed.data.allowAgentPolicyProposals }
          : {}),
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err, 500, 'failed to save safety rails', 'settings.safety');
  }
}
