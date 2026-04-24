// POST /api/settings/budget — update the BYOK API cost-governor.
// Caps are deliberately generous (null = disabled, $5 floor, $5k
// ceiling) — this is a BYOK-protection feature, not a paywall.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

const Body = z.object({
  // Null disables the alarm + auto-pause entirely.
  monthlyApiBudgetUsd: z.number().min(5).max(5_000).nullable(),
  budgetAlarmThresholdPct: z.number().min(10).max(99),
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
        monthlyApiBudgetUsd: parsed.data.monthlyApiBudgetUsd,
        budgetAlarmThresholdPct: parsed.data.budgetAlarmThresholdPct,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err, 500, 'failed to save budget settings', 'settings.budget');
  }
}
