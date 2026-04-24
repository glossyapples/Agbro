// Pending approval lifecycle helpers. Pairs the immutable
// GovernorDecision audit row with the mutable PendingApproval
// state row in a single transaction so the queue can't drift from
// the audit trail.
//
// Called from placeTradeTool when the autonomy ladder diverts a
// proposal to the queue (observe short-circuits; propose queues
// after the gates pass).

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import {
  type CodedReason,
  renderCodedReason,
} from './reason-codes';
import { parseAutonomyLevel, type AutonomyLevel } from './autonomy';
import { GOVERNOR_VERSION } from './governor';

// Default TTL for a pending approval. User can adjust per Mandate
// later; v1 is a single 24h window.
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;

export type CreatePendingApprovalInput = {
  userId: string;
  agentRunId: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  orderType: 'market' | 'limit';
  limitPriceCents: bigint | null;
  bullCase: string;
  bearCase: string;
  thesis: string;
  confidence: number;
  intrinsicValuePerShareCents: bigint | null;
  marginOfSafetyPct: number | null;
  reasons: CodedReason[];
  autonomyLevel: AutonomyLevel;
  ttlMs?: number;
};

export type PendingApprovalCreated = {
  approvalId: string;
  governorDecisionId: string;
  expiresAt: Date;
};

export async function createPendingApproval(
  input: CreatePendingApprovalInput
): Promise<PendingApprovalCreated> {
  const ttl = input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);
  const userExplanation =
    input.reasons.length > 0
      ? renderCodedReason(input.reasons[0])
      : 'Queued for user approval.';
  const autonomyLevel = parseAutonomyLevel(input.autonomyLevel);

  const result = await prisma.$transaction(async (tx) => {
    const decision = await tx.governorDecision.create({
      data: {
        userId: input.userId,
        agentRunId: input.agentRunId,
        symbol: input.symbol,
        side: input.side,
        qty: input.qty,
        orderType: input.orderType,
        limitPriceCents: input.limitPriceCents,
        estimatedCostCents: null,
        decision: 'requires_approval',
        reasonCodes: input.reasons.map((r) => r.code),
        userExplanation,
        autonomyLevel,
        governorVersion: GOVERNOR_VERSION,
      },
    });
    const approval = await tx.pendingApproval.create({
      data: {
        userId: input.userId,
        agentRunId: input.agentRunId,
        governorDecisionId: decision.id,
        symbol: input.symbol,
        side: input.side,
        qty: input.qty,
        orderType: input.orderType,
        limitPriceCents: input.limitPriceCents,
        bullCase: input.bullCase,
        bearCase: input.bearCase,
        thesis: input.thesis,
        confidence: input.confidence,
        intrinsicValuePerShareCents: input.intrinsicValuePerShareCents,
        marginOfSafetyPct: input.marginOfSafetyPct,
        expiresAt,
      },
    });
    return { approvalId: approval.id, governorDecisionId: decision.id, expiresAt };
  });

  log.info('governor.pending_approval_created', {
    userId: input.userId,
    approvalId: result.approvalId,
    symbol: input.symbol,
    side: input.side,
    reasonCodes: input.reasons.map((r) => r.code),
    autonomyLevel,
  });
  return result;
}
