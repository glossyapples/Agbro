// Sweep expired pending approvals. Runs on every scheduler tick
// alongside the crypto + regime checks. Cheap because it's a single
// UPDATE keyed off the expiresAt index.
//
// An expired approval transitions to status='expired' with
// resolvedBy='timeout'. The agent reads this back on the next run
// as signal to stop waiting on that proposal.

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';

export async function sweepExpiredApprovals(nowMs: number = Date.now()): Promise<number> {
  const now = new Date(nowMs);
  try {
    const res = await prisma.pendingApproval.updateMany({
      where: {
        status: 'pending',
        expiresAt: { lte: now },
      },
      data: {
        status: 'expired',
        resolvedAt: now,
        resolvedBy: 'timeout',
      },
    });
    if (res.count > 0) {
      log.info('approvals.sweep_expired', { count: res.count });
    }
    return res.count;
  } catch (err) {
    log.error('approvals.sweep_failed', err);
    return 0;
  }
}
