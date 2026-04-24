// Governor activity aggregator — the reader side of the
// GovernorDecision / PendingApproval audit tables. Feeds the
// behavior-alpha card on /analytics.
//
// The goal is to make protective actions *visible*. Without this, a
// user never sees the governor do its job — trades that don't happen
// are silent. "Blocked 3 over-sized orders this week" is the
// one-liner that turns the Sprint 1 refactor from invisible plumbing
// into a product feature.

import { prisma } from '@/lib/db';
import type { ReasonCode } from './reason-codes';

// Reason codes grouped by "what the governor was protecting against".
// The UI renders per-bucket counts; totals are across buckets.
//
// Not every reason code lands here — input-shape rejections
// (INVALID_INPUT, LIMIT_PRICE_REQUIRED) are plumbing errors, not
// protective actions, so we don't surface them in the activity card.
// Autonomy-ladder escalations (OBSERVE_MODE_INTERCEPTED,
// PROPOSE_MODE_REQUIRES_APPROVAL) are tracked separately via
// PendingApproval counts.
export const PROTECTIVE_REASONS: ReasonCode[] = [
  'MOS_INSUFFICIENT',
  'EARNINGS_BLACKOUT',
  'WASH_SALE_VIOLATION',
  'WALLET_INSUFFICIENT',
  'NOTIONAL_CAP_EXCEEDED',
  'NO_PRICE_FOR_CAP',
  'DAILY_TRADE_CAP_EXCEEDED',
  'ACCOUNT_PAUSED',
  'ACCOUNT_STOPPED',
  'BUDGET_EXCEEDED',
  'MANDATE_CONCENTRATION_BREACH',
  'MANDATE_SECTOR_BREACH',
  'MANDATE_FORBIDDEN_SYMBOL',
  'MANDATE_FORBIDDEN_SECTOR',
  'MANDATE_CASH_RESERVE_BREACH',
];

// Group each protective reason into a human-readable bucket. Used
// when we want to collapse noise ("5 earnings + 2 wash-sale + 1
// IRS-rule" → "8 tax / event blocks") on small screens.
export const REASON_BUCKETS: Record<ReasonCode, string> = {
  INVALID_INPUT: 'input',
  LIMIT_PRICE_REQUIRED: 'input',
  ACCOUNT_STOPPED: 'state',
  ACCOUNT_PAUSED: 'state',
  BUDGET_EXCEEDED: 'state',
  MOS_INSUFFICIENT: 'strategy',
  EARNINGS_BLACKOUT: 'tax_event',
  WASH_SALE_VIOLATION: 'tax_event',
  WALLET_INSUFFICIENT: 'sizing',
  NOTIONAL_CAP_EXCEEDED: 'sizing',
  NO_PRICE_FOR_CAP: 'sizing',
  DAILY_TRADE_CAP_EXCEEDED: 'sizing',
  OBSERVE_MODE_INTERCEPTED: 'ladder',
  PROPOSE_MODE_REQUIRES_APPROVAL: 'ladder',
  MANDATE_CONCENTRATION_BREACH: 'mandate',
  MANDATE_SECTOR_BREACH: 'mandate',
  MANDATE_FORBIDDEN_SYMBOL: 'mandate',
  MANDATE_FORBIDDEN_SECTOR: 'mandate',
  MANDATE_CASH_RESERVE_BREACH: 'mandate',
};

export type GovernorStats = {
  windowDays: number;
  windowStart: Date;
  totals: {
    approved: number;
    rejected: number;
    requires_approval: number;
  };
  // Per-reason-code rejection counts. Only includes reasons that
  // actually fired in the window; reasons with zero count are absent.
  rejectionsByReason: Record<string, number>;
  // Sum of estimatedCostCents (when present) across rejections whose
  // reason would have blocked real dollars. Null estimates (e.g. on
  // NO_PRICE_FOR_CAP where we never had a price) fall out of this sum.
  protectedDollarsCents: bigint;
  // Approval-queue counts for the window.
  approvals: {
    pending: number;   // status='pending' AND expiresAt > now
    approvedByUser: number;
    rejectedByUser: number;
    expired: number;
  };
};

export function startOfWindow(days: number, nowMs: number = Date.now()): Date {
  return new Date(nowMs - days * 86_400_000);
}

// One aggregate call. Three Prisma queries, all index-covered by
// @@index([userId, decision, createdAt]) on GovernorDecision and
// @@index([userId, status]) on PendingApproval.
export async function getGovernorStats(
  userId: string,
  windowDays: number = 7,
  nowMs: number = Date.now()
): Promise<GovernorStats> {
  const windowStart = startOfWindow(windowDays, nowMs);

  const [groupedDecisions, rejectionRows, approvalCounts] = await Promise.all([
    prisma.governorDecision.groupBy({
      by: ['decision'],
      where: { userId, createdAt: { gte: windowStart } },
      _count: { _all: true },
    }),
    prisma.governorDecision.findMany({
      where: {
        userId,
        decision: 'rejected',
        createdAt: { gte: windowStart },
      },
      select: { reasonCodes: true, estimatedCostCents: true },
    }),
    prisma.pendingApproval.groupBy({
      by: ['status'],
      where: { userId, createdAt: { gte: windowStart } },
      _count: { _all: true },
    }),
  ]);

  const totals = { approved: 0, rejected: 0, requires_approval: 0 };
  for (const row of groupedDecisions) {
    if (row.decision === 'approved') totals.approved = row._count._all;
    else if (row.decision === 'rejected') totals.rejected = row._count._all;
    else if (row.decision === 'requires_approval')
      totals.requires_approval = row._count._all;
  }

  const rejectionsByReason: Record<string, number> = {};
  let protectedDollarsCents = 0n;
  for (const row of rejectionRows) {
    // A rejection can carry multiple codes (e.g. a future Mandate rule
    // stacking on top of a fundamental block). Count each code once
    // per rejection for attribution; sum the estimated dollar cost
    // exactly once per rejection to avoid double-counting.
    for (const code of row.reasonCodes) {
      rejectionsByReason[code] = (rejectionsByReason[code] ?? 0) + 1;
    }
    if (row.estimatedCostCents != null) {
      protectedDollarsCents += row.estimatedCostCents;
    }
  }

  const approvals = {
    pending: 0,
    approvedByUser: 0,
    rejectedByUser: 0,
    expired: 0,
  };
  for (const row of approvalCounts) {
    const n = row._count._all;
    if (row.status === 'pending') approvals.pending = n;
    else if (row.status === 'approved') approvals.approvedByUser = n;
    else if (row.status === 'rejected') approvals.rejectedByUser = n;
    else if (row.status === 'expired') approvals.expired = n;
  }

  return {
    windowDays,
    windowStart,
    totals,
    rejectionsByReason,
    protectedDollarsCents,
    approvals,
  };
}

// Headline string for the activity card. Picks the most informative
// framing given what actually fired — avoids "3 trades blocked" when
// the count is 0, and "no activity" when the governor approved things.
export function summarise(stats: GovernorStats): string {
  const blocked = stats.totals.rejected;
  const approved = stats.totals.approved;
  const queued = stats.totals.requires_approval;
  if (blocked === 0 && approved === 0 && queued === 0) {
    return 'No trade decisions this window. The agent may be paused, outside hours, or without proposals.';
  }
  if (blocked === 0) {
    return `${approved} trade${approved === 1 ? '' : 's'} passed every safety check.${queued > 0 ? ` ${queued} queued for your sign-off.` : ''}`;
  }
  return `Blocked ${blocked} trade${blocked === 1 ? '' : 's'} that would have broken your rules. ${approved} passed cleanly.${queued > 0 ? ` ${queued} queued.` : ''}`;
}
