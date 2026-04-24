// Thin recorder helper for the Governor audit trail. The existing
// place_trade gate throws plain-string errors on rejection; this
// helper writes a structured row to GovernorDecision alongside each
// decision so the approval queue + future behavior-alpha dashboard
// have data to work from.
//
// Design rules:
//   • Audit write is best-effort. If Prisma fails, we log the error
//     and return — we never block the trade-gate decision on audit
//     write success.
//   • The helper does NOT throw. Callers throw their own errors to
//     preserve existing agent-visible behaviour.
//   • Caller passes the input they already parsed (symbol/side/qty
//     etc.) so we don't re-derive them. Keeps the helper pure over
//     its args.
//   • governorVersion bumps when ordering/invariants change. Start at
//     v1.0.0 (captures the current defense-in-depth sequence). Do NOT
//     bump for cosmetic refactors; this is semantic-version-by-rules.

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import {
  type CodedReason,
  type Decision,
  renderCodedReason,
} from './reason-codes';
import { parseAutonomyLevel, type AutonomyLevel } from './autonomy';

export const GOVERNOR_VERSION = 'v1.0.0';

export type GovernorRecordInput = {
  userId: string;
  agentRunId?: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  orderType: 'market' | 'limit';
  limitPriceCents?: bigint | null;
  estimatedCostCents?: bigint | null;
  decision: Decision;
  reasons: CodedReason[];
  autonomyLevel: AutonomyLevel;
};

export async function recordGovernorDecision(
  input: GovernorRecordInput
): Promise<void> {
  try {
    const userExplanation =
      input.reasons.length > 0
        ? renderCodedReason(input.reasons[0])
        : 'Approved.';
    await prisma.governorDecision.create({
      data: {
        userId: input.userId,
        agentRunId: input.agentRunId ?? null,
        symbol: input.symbol,
        side: input.side,
        qty: input.qty,
        orderType: input.orderType,
        limitPriceCents: input.limitPriceCents ?? null,
        estimatedCostCents: input.estimatedCostCents ?? null,
        decision: input.decision,
        reasonCodes: input.reasons.map((r) => r.code),
        userExplanation,
        autonomyLevel: parseAutonomyLevel(input.autonomyLevel),
        governorVersion: GOVERNOR_VERSION,
      },
    });
  } catch (err) {
    log.error('governor.audit_write_failed', err, {
      userId: input.userId,
      symbol: input.symbol,
      decision: input.decision,
      reasonCodes: input.reasons.map((r) => r.code),
    });
  }
}
