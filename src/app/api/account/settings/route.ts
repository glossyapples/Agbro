import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export const runtime = 'nodejs';

const Patch = z.object({
  expectedAnnualPct: z.number().min(0).max(100).optional(),
  riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).optional(),
  maxPositionPct: z.number().min(1).max(100).optional(),
  maxDailyTrades: z.number().int().min(0).max(20).optional(),
  minCashReservePct: z.number().min(0).max(100).optional(),
  tradingHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  tradingHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  agentCadenceMinutes: z.number().int().min(5).max(1440).optional(),
  allowDayTrades: z.boolean().optional(),
});

export async function POST(req: Request) {
  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const user = await getCurrentUser();
  await prisma.account.update({ where: { userId: user.id }, data: parsed.data });
  return NextResponse.json({ ok: true });
}
