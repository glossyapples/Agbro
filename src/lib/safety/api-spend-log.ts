// Single-source-of-truth recorder for all Anthropic-billable calls
// across the system. Audit C15 follow-up: getMtdApiSpend now reads
// from ApiSpendLog instead of unioning AgentRun.costUsd +
// Meeting.costUsd, so previously-invisible surfaces (deep-research,
// post-mortem, weekly-cron) are now caught by the budget enforcer.
//
// Every code path that calls Anthropic should call recordApiSpend
// with the appropriate kind. Failures here are logged but never
// thrown — accounting is best-effort by design (we'd rather miss
// one spend row than fail a user's run for an audit-trail issue).

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';

export type ApiSpendKind =
  | 'agent_run'
  | 'deep_research'
  | 'post_mortem'
  | 'meeting'
  | 'comic_script'
  | 'comic_image'
  | 'weekly_brain'
  | 'brain_blurb';

export type RecordApiSpendInput = {
  userId: string;
  kind: ApiSpendKind;
  model: string;
  costUsd: number;
  // Free-form per-kind context. Keep small; this is for debugging,
  // not aggregation.
  metadata?: Record<string, unknown>;
};

export async function recordApiSpend(input: RecordApiSpendInput): Promise<void> {
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) {
    log.warn('api_spend_log.invalid_cost', {
      userId: input.userId,
      kind: input.kind,
      costUsd: input.costUsd,
    });
    return;
  }
  // $0 spend is legitimate (errored runs, free-tier calls) and worth
  // recording for audit completeness; suppress only the "negative or
  // NaN" pathologies above.
  try {
    await prisma.apiSpendLog.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        model: input.model,
        costUsd: input.costUsd,
        metadata: input.metadata
          ? (input.metadata as unknown as object)
          : undefined,
      },
    });
  } catch (err) {
    log.warn('api_spend_log.write_failed', {
      userId: input.userId,
      kind: input.kind,
      costUsd: input.costUsd,
      err: (err as Error).message,
    });
  }
}
