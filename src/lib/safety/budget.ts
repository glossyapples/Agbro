// BYOK cost-governor. Watches month-to-date Claude API spend against
// the per-user monthlyApiBudgetUsd. Two thresholds:
//   • alarm  (default 80%) — home banner appears, email goes out
//   • exceed (100%)         — account is paused via the kill-switch
//                             mechanism with reason BUDGET_EXCEEDED.
//                             User clears the kill switch (and/or
//                             raises the budget) manually; no
//                             auto-resume.
//
// Rationale: BYOK means every token costs the user. A runaway agent
// loop or a spammy wizard can rack up real dollars in hours. The
// alarm is the surprise-bill prevention — by the time the user
// notices a $200 line on their Anthropic invoice, the window to
// intervene has long closed.

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { applyKillSwitch } from './rails';
import { renderReason } from './reason-codes';

export type BudgetStatus = {
  enabled: boolean;
  mtdUsd: number;
  budgetUsd: number | null;
  alarmThresholdPct: number;
  // 'disabled' — no budget configured
  // 'ok'       — under the alarm threshold
  // 'warning'  — between alarm and 100%
  // 'exceeded' — ≥ 100% of budget
  state: 'disabled' | 'ok' | 'warning' | 'exceeded';
};

// Start of the current UTC month. We deliberately use UTC (not ET)
// because API cost invoices from Anthropic roll at UTC midnight on
// the 1st; aligning the MTD aggregate with the invoice window keeps
// the user's in-app number reconcilable with their provider bill.
export function startOfMonthUtc(nowMs: number = Date.now()): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// Sum the user's MTD Anthropic API spend across every cost-bearing
// surface. Audit C15: previously this only counted AgentRun.costUsd,
// silently underestimating true spend by the cost of weekly meetings,
// comic generation, deep-research clicks, and post-mortem nested
// calls. The undercount made the kill-switch trip late, after the
// user had already bled past their declared budget.
//
// Currently summed:
//   - AgentRun.costUsd  (orchestrator-level Claude calls; includes
//                        post-mortem nested costs because they are
//                        tool-output that the orchestrator folds back
//                        into its own usage accumulator)
//   - Meeting.costUsd   (weekly meeting LLM + comic script LLM +
//                        image generation, all combined)
//
// Known undercounts pending a follow-up schema change (an ApiSpendLog
// table or costUsd columns on ResearchNote + BrainEntry):
//   - User-triggered /research/deep streaming runs
//   - Weekly cron brain writeups (currently logged-only)
// These typically run $1-3 per click / per week, so the undercount
// is bounded but real. Will be addressed in the high-priority sprint.
export async function getMtdApiSpend(
  userId: string,
  nowMs: number = Date.now()
): Promise<number> {
  const since = startOfMonthUtc(nowMs);
  const [agentAgg, meetingAgg] = await Promise.all([
    prisma.agentRun.aggregate({
      where: { userId, startedAt: { gte: since }, costUsd: { not: null } },
      _sum: { costUsd: true },
    }),
    prisma.meeting.aggregate({
      where: { userId, startedAt: { gte: since }, costUsd: { not: null } },
      _sum: { costUsd: true },
    }),
  ]);
  return (agentAgg._sum.costUsd ?? 0) + (meetingAgg._sum.costUsd ?? 0);
}

// Pure classifier — split from the DB call so the threshold logic
// can be unit-tested without mocking Prisma.
export function classifyBudgetState(input: {
  mtdUsd: number;
  budgetUsd: number | null;
  alarmThresholdPct: number;
}): BudgetStatus['state'] {
  if (input.budgetUsd == null || input.budgetUsd <= 0) return 'disabled';
  if (input.mtdUsd >= input.budgetUsd) return 'exceeded';
  const alarmLine = input.budgetUsd * (input.alarmThresholdPct / 100);
  if (input.mtdUsd >= alarmLine) return 'warning';
  return 'ok';
}

export async function checkApiBudget(
  userId: string,
  nowMs: number = Date.now()
): Promise<BudgetStatus> {
  const account = await prisma.account.findUnique({
    where: { userId },
    select: { monthlyApiBudgetUsd: true, budgetAlarmThresholdPct: true },
  });
  const budgetUsd = account?.monthlyApiBudgetUsd ?? null;
  const alarmThresholdPct = account?.budgetAlarmThresholdPct ?? 80;
  const mtdUsd = await getMtdApiSpend(userId, nowMs);
  const state = classifyBudgetState({ mtdUsd, budgetUsd, alarmThresholdPct });
  return {
    enabled: budgetUsd != null && budgetUsd > 0,
    mtdUsd,
    budgetUsd,
    alarmThresholdPct,
    state,
  };
}

// Called from the scheduler tick BEFORE runAgent. If the account is
// already kill-switch'd for any reason, we don't double-stamp —
// existing rails own the pause state. If not and we're exceeded,
// we set the kill switch with the BUDGET_EXCEEDED reason.
export async function enforceApiBudget(
  userId: string,
  nowMs: number = Date.now()
): Promise<BudgetStatus> {
  const status = await checkApiBudget(userId, nowMs);
  if (status.state !== 'exceeded') return status;

  const account = await prisma.account.findUnique({
    where: { userId },
    select: { killSwitchTriggeredAt: true },
  });
  if (account?.killSwitchTriggeredAt) return status; // already halted; don't overwrite

  const reason = renderReason('BUDGET_EXCEEDED', {
    mtdSpendUsd: status.mtdUsd,
    budgetUsd: status.budgetUsd ?? 0,
  });
  await applyKillSwitch(userId, reason);
  log.warn('budget.kill_switch_triggered', {
    userId,
    mtdUsd: status.mtdUsd,
    budgetUsd: status.budgetUsd,
  });
  return status;
}
