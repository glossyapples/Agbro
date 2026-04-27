import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24h)');

const Patch = z
  .object({
    // A planning input only — not a forecast. Uncapped because this
    // is what the user *assumes*; the safety rails that actually
    // bound risk (maxPositionPct, minCashReservePct, maxDailyTrades)
    // stay strict. 'expectedAnnualPct' is accepted as a legacy alias
    // so older clients continue to work during the rename rollout.
    planningAssumption: z.number().nonnegative().finite().optional(),
    expectedAnnualPct: z.number().nonnegative().finite().optional(),
    riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).optional(),
    maxPositionPct: z.number().min(1).max(100).optional(),
    maxDailyTrades: z.number().int().min(0).max(20).optional(),
    maxDailyCryptoTrades: z.number().int().min(0).max(50).optional(),
    minCashReservePct: z.number().min(0).max(100).optional(),
    tradingHoursStart: HHMM.optional(),
    tradingHoursEnd: HHMM.optional(),
    agentCadenceMinutes: z.number().int().min(5).max(1440).optional(),
    allowDayTrades: z.boolean().optional(),
    autoPromoteCandidates: z.boolean().optional(),
    optionsEnabled: z.boolean().optional(),
    cryptoEnabled: z.boolean().optional(),
    maxCryptoAllocationPct: z.number().min(0).max(100).optional(),
    // Autonomy ladder for agent trade execution. Editable post-onboarding
    // via the AutonomyForm on /settings. The home-page Plan card shows
    // this value but didn't expose an edit path before — users had to
    // re-run onboarding to flip it.
    autonomyLevel: z.enum(['observe', 'propose', 'auto']).optional(),
  })
  .refine(
    (v) =>
      v.tradingHoursStart == null ||
      v.tradingHoursEnd == null ||
      v.tradingHoursStart < v.tradingHoursEnd,
    { message: 'tradingHoursStart must be before tradingHoursEnd', path: ['tradingHoursEnd'] }
  );

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const parsed = Patch.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    // Legacy-alias mapping: if the client sent the old key, route it
    // to the new column. If both are supplied (shouldn't happen), the
    // new key wins.
    const { expectedAnnualPct: legacyAlias, ...rest } = parsed.data;
    const data =
      legacyAlias != null && rest.planningAssumption == null
        ? { ...rest, planningAssumption: legacyAlias }
        : rest;
    await prisma.account.update({ where: { userId: user.id }, data });
    // Settings affect what the home, settings, and analytics pages render.
    // Invalidate them so the next visit re-renders against fresh DB state
    // instead of serving the previous server-render from cache.
    revalidatePath('/');
    revalidatePath('/settings');
    revalidatePath('/analytics');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err, 500, 'settings update failed', 'account.settings');
  }
}
