// PATCH /api/meetings/policy-changes/[id] — accept or reject a policy
// change proposed by a meeting. Accept applies the `after` value to
// the target (Account / Strategy / CryptoConfig), with bounds
// validation so the user can't accidentally disable their safety net
// via a meeting-proposed edit.
//
// Body: { action: 'accept' | 'reject' }

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';

const Body = z.object({ action: z.enum(['accept', 'reject']) });

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const change = await prisma.policyChange.findUnique({
      where: { id: params.id },
    });
    if (!change || change.userId !== user.id) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (change.status !== 'proposed') {
      return NextResponse.json(
        { error: `already ${change.status}` },
        { status: 400 }
      );
    }

    if (parsed.data.action === 'accept') {
      // Respect the user-level toggle — when off, proposals can be
      // rejected but not applied. Rejections are always allowed so
      // the user can clear noise.
      const account = await prisma.account.findUnique({
        where: { userId: user.id },
        select: { allowAgentPolicyProposals: true },
      });
      if (account && !account.allowAgentPolicyProposals) {
        return NextResponse.json(
          {
            error:
              'Agent policy proposals are disabled in Settings → Safety rails. Enable the toggle first if you want to apply this change.',
          },
          { status: 403 }
        );
      }
    }

    if (parsed.data.action === 'reject') {
      await prisma.policyChange.update({
        where: { id: params.id },
        data: { status: 'rejected', decidedAt: new Date() },
      });
      return NextResponse.json({ ok: true, action: 'rejected' });
    }

    // Accept: validate bounds, apply the change, record applied.
    const bounded = validateBounds(change.kind, change.targetKey, change.after);
    if (!bounded.ok) {
      return NextResponse.json({ error: bounded.reason }, { status: 400 });
    }
    await applyChange(user.id, change.kind, change.targetKey, change.after);
    await prisma.policyChange.update({
      where: { id: params.id },
      data: { status: 'applied', decidedAt: new Date() },
    });
    log.info('meeting.policy_change.applied', {
      userId: user.id,
      changeId: change.id,
      kind: change.kind,
      targetKey: change.targetKey,
    });
    return NextResponse.json({ ok: true, action: 'applied' });
  } catch (err) {
    return apiError(err, 500, 'failed to update policy change', 'meetings.policy_change');
  }
}

// Hard caps on values a meeting can propose. Prevents a hallucinated
// policyChange from nuking safety rails. Rejects rather than clamps —
// user sees the rejection and the next meeting proposes something
// reasonable.
//
// We also REJECT kinds that aren't wired to any apply surface. Previously
// `crypto_config` / `strategy_param` / `universe` passed bounds, then
// threw at `applyChange`, then surfaced as a 500. That meant a proposal
// the prompt shouldn't have emitted sat in 'proposed' forever with no
// user recourse. Now bounds rejects these with a clear 400, and the
// meeting prompt's allowlist has been tightened in schema.ts so they
// shouldn't be emitted at all.
const APPLIABLE_KINDS = new Set(['account', 'cadence']);
const CADENCE_ALLOWED_KEYS = new Set(['agentCadenceMinutes']);
const ACCOUNT_ALLOWED_KEYS = new Set([
  'maxPositionPct',
  'maxDailyTrades',
  'minCashReservePct',
  'maxCryptoAllocationPct',
  'dailyLossKillPct',
  'drawdownPauseThresholdPct',
  'expectedAnnualPct',
]);

function validateBounds(
  kind: string,
  targetKey: string,
  after: unknown
): { ok: true } | { ok: false; reason: string } {
  if (!APPLIABLE_KINDS.has(kind)) {
    return {
      ok: false,
      reason: `policy-change kind '${kind}' isn't applyable. Strategy rules go through the Strategy Wizard; crypto config lives on /crypto; watchlist changes are user-managed. Reject this proposal — the meeting prompt shouldn't have emitted it.`,
    };
  }
  if (kind === 'cadence' && !CADENCE_ALLOWED_KEYS.has(targetKey)) {
    return {
      ok: false,
      reason: `cadence kind only accepts targetKey=agentCadenceMinutes (got '${targetKey}').`,
    };
  }
  if (kind === 'account' && !ACCOUNT_ALLOWED_KEYS.has(targetKey)) {
    return {
      ok: false,
      reason: `account kind doesn't accept targetKey '${targetKey}'. Allowed: ${[...ACCOUNT_ALLOWED_KEYS].join(', ')}.`,
    };
  }
  if (kind === 'cadence' && targetKey === 'agentCadenceMinutes') {
    const v = Number(after);
    if (!Number.isFinite(v) || v < 15 || v > 1440) {
      return { ok: false, reason: 'agentCadenceMinutes must be 15–1440' };
    }
  }
  if (kind === 'account' && targetKey === 'maxPositionPct') {
    const v = Number(after);
    if (!Number.isFinite(v) || v < 1 || v > 40) {
      return { ok: false, reason: 'maxPositionPct must be 1–40' };
    }
  }
  if (kind === 'account' && targetKey === 'maxDailyTrades') {
    const v = Number(after);
    if (!Number.isFinite(v) || v < 0 || v > 50) {
      return { ok: false, reason: 'maxDailyTrades must be 0–50' };
    }
  }
  if (kind === 'account' && targetKey === 'minCashReservePct') {
    const v = Number(after);
    if (!Number.isFinite(v) || v < 0 || v > 80) {
      return { ok: false, reason: 'minCashReservePct must be 0–80' };
    }
  }
  if (kind === 'account' && targetKey === 'maxCryptoAllocationPct') {
    const v = Number(after);
    if (!Number.isFinite(v) || v < 0 || v > 50) {
      return { ok: false, reason: 'maxCryptoAllocationPct must be 0–50' };
    }
  }
  if (kind === 'account' && targetKey === 'dailyLossKillPct') {
    const v = Number(after);
    if (!Number.isFinite(v) || v > 0 || v < -50) {
      return { ok: false, reason: 'dailyLossKillPct must be -50..0' };
    }
  }
  return { ok: true };
}

async function applyChange(
  userId: string,
  kind: string,
  targetKey: string,
  after: unknown
): Promise<void> {
  // validateBounds already rejected every non-appliable kind and every
  // targetKey outside the allowed set, so we only need to handle the
  // two wired paths. A future second edit surface (crypto / strategy
  // rules / universe) should grow here plus in validateBounds +
  // schema.ts's allowlist in lockstep.
  if (kind === 'cadence' || kind === 'account') {
    await prisma.account.update({
      where: { userId },
      data: { [targetKey]: Number(after) } as Record<string, unknown>,
    });
    return;
  }
  throw new Error(`unknown policy-change kind: ${kind}`);
}
