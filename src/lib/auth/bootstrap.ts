// First-sign-in bootstrap: called by both Auth.js events.createUser (magic
// link flow) and the owner-key endpoint so every brand-new User row gets
// their trading Account, default Strategy, and Day-0 brain charter created
// exactly once. Idempotent: re-runs are no-ops.

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { seedBrainForUser } from '@/lib/brain/seed-brain';

export async function bootstrapNewUser(userId: string): Promise<void> {
  await prisma.account.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      expectedAnnualPct: 12.0,
      riskTolerance: 'moderate',
      maxPositionPct: Number(process.env.MAX_POSITION_PCT ?? 15),
      maxDailyTrades: Number(process.env.MAX_DAILY_TRADES ?? 3),
      minCashReservePct: Number(process.env.MIN_CASH_RESERVE_PCT ?? 10),
    },
  });

  const existingStrategy = await prisma.strategy.findFirst({ where: { userId } });
  if (!existingStrategy) {
    await prisma.strategy.create({
      data: {
        userId,
        name: 'Buffett-style Value + Dividend Core',
        isActive: true,
        version: 1,
        buffettScore: 85,
        summary:
          'Buy durable-moat businesses trading below intrinsic value with a 20%+ margin of safety. ' +
          'Prefer dividend payers with ROE > 15% and manageable debt. Ballast with broad-market ETFs. ' +
          'Hold for years. Only sell on thesis break or materially better opportunity.',
        rules: {
          minMarginOfSafetyPct: 20,
          minMoatSignal: 'narrow',
          minROEPct: 15,
          maxDebtToEquity: 1.5,
          preferDividend: true,
          maxPosition: 15,
          minCashReserve: 10,
          maxDailyTrades: 3,
          allowDayTrades: false,
          targetAnnualReturnPct: 12,
        },
      },
    });
  }

  const hasCharter = await prisma.brainEntry.findFirst({
    where: { userId, kind: 'principle', title: 'Day 0 — The Charter' },
  });
  if (!hasCharter) {
    await prisma.brainEntry.create({
      data: {
        userId,
        kind: 'principle',
        category: 'principle',
        confidence: 'canonical',
        seedKey: 'principle:day-0-charter',
        title: 'Day 0 — The Charter',
        body:
          'AgBro exists to preserve principal first, and grow it second. ' +
          'No options. No shorting. No margin. Minimal day trading. ' +
          'Every trade must pass the internal analyzer AND carry a written Bull/Bear case. ' +
          'Margin of safety is non-negotiable. We learn in public: every closed position gets a post-mortem.',
        tags: ['charter', 'principles'],
      },
    });
  }

  // Load the full starter brain (principles, checklists, pitfalls, sector
  // primers, case studies) + archived alternative strategies. Fire-and-forget
  // so a transient Postgres hiccup doesn't stall the magic-link flow. If it
  // fails, the user can still use the in-app "Load starter brain" button
  // on /brain as a fallback.
  void seedBrainForUser(userId)
    .then((r) =>
      log.info('bootstrap.brain_seeded', {
        userId,
        brainInserted: r.brainEntries.inserted,
        strategiesInserted: r.strategies.inserted,
      })
    )
    .catch((err) => {
      log.error('bootstrap.brain_seed_failed', err, { userId });
    });
}
