import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { ApprovalCard } from '@/components/ApprovalCard';
import { parseAutonomyLevel, AUTONOMY_LABEL, AUTONOMY_DESCRIPTION } from '@/lib/safety/autonomy';

export const runtime = 'nodejs';

export default async function ApprovalsPage() {
  const user = await requirePageUser('/approvals');

  const [account, pending] = await Promise.all([
    prisma.account.findUnique({
      where: { userId: user.id },
      select: { autonomyLevel: true },
    }),
    prisma.pendingApproval.findMany({
      where: {
        userId: user.id,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  const autonomyLevel = parseAutonomyLevel(account?.autonomyLevel);

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Approvals</h1>
          <p className="mt-1 text-xs text-ink-400">
            The agent proposes, you dispose. Each trade below is
            waiting for your sign-off before it reaches the broker.
          </p>
        </div>
        <Link href="/" className="text-xs text-brand-400">
          ← Home
        </Link>
      </header>

      <section className="rounded-md border border-ink-800 bg-ink-900 p-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-ink-400">Autonomy</span>
          <span className="font-semibold text-brand-400">
            {AUTONOMY_LABEL[autonomyLevel]}
          </span>
        </div>
        <p className="mt-1 text-ink-400">{AUTONOMY_DESCRIPTION[autonomyLevel]}</p>
      </section>

      {pending.length === 0 ? (
        <div className="rounded-md border border-ink-800 bg-ink-900 p-6 text-center text-sm text-ink-400">
          Nothing waiting.
          {autonomyLevel === 'auto' ? (
            <p className="mt-2 text-xs">
              You're on <strong>Auto</strong> — trades that pass every
              safety check execute without queueing here. Approvals
              only appear for proposals that hit a Mandate rule that
              escalates to user review.
            </p>
          ) : null}
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {pending.map((a) => (
            <li key={a.id}>
              <ApprovalCard
                approval={{
                  id: a.id,
                  symbol: a.symbol,
                  side: a.side as 'buy' | 'sell',
                  qty: a.qty,
                  orderType: a.orderType,
                  limitPriceCents: a.limitPriceCents?.toString() ?? null,
                  bullCase: a.bullCase,
                  bearCase: a.bearCase,
                  thesis: a.thesis,
                  confidence: a.confidence,
                  marginOfSafetyPct: a.marginOfSafetyPct,
                  intrinsicValuePerShareCents:
                    a.intrinsicValuePerShareCents?.toString() ?? null,
                  expiresAt: a.expiresAt.toISOString(),
                  createdAt: a.createdAt.toISOString(),
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
