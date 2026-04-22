// POST /api/candidates/wizard — user-triggered candidate review wizard.
//
// Unlike auto-promote (which bypasses the user for high-conviction names)
// or pure manual review (no LLM help), this is the middle path: the user
// clicks "Ask the wizard," Opus 4.7 reads all pending candidates + active
// strategy + brain principles, and returns ranked recommendations. The
// user still clicks Approve/Reject themselves — wizard output is advisory.
//
// Rate-limited to 6/hour per user (~$3/hr ceiling at Opus pricing).

import { NextResponse } from 'next/server';
import { apiError, requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';
import { runCandidateWizard } from '@/lib/agents/wizard';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const gate = await checkLimit(user.id, 'candidates.wizard');
  if (!gate.success) return rateLimited(gate);

  try {
    const result = await runCandidateWizard(user.id);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err, 500, 'candidate wizard failed', 'candidates.wizard');
  }
}
