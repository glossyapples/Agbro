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

// Sum the user's MTD Anthropic API spend from ApiSpendLog — the
// single source of truth for cost-bearing calls across the system.
// Every Anthropic surface (orchestrator, deep-research, post-mortem,
// meetings, comic, weekly-cron, brain-blurb) writes one row to
// ApiSpendLog at the moment of charge; this aggregator simply sums
// the current month.
//
// Audit C15: previously aggregated AgentRun.costUsd ± Meeting.costUsd
// directly, which silently missed deep-research user-clicks, weekly-
// cron brain writeups, post-mortem nested calls, and comic
// generation. ApiSpendLog closes that gap permanently — the budget
// enforcer now has visibility into every Anthropic spend regardless
// of which entity persisted the per-row cost.
//
// Backwards-compat: AgentRun.costUsd and Meeting.costUsd columns are
// still set at write time for per-row UI display (e.g.
// /api/debug/last-agent-run). They're mirrors, not authoritative.
export async function getMtdApiSpend(
  userId: string,
  nowMs: number = Date.now()
): Promise<number> {
  const since = startOfMonthUtc(nowMs);
  const agg = await prisma.apiSpendLog.aggregate({
    where: { userId, createdAt: { gte: since } },
    _sum: { costUsd: true },
  });
  return agg._sum.costUsd ?? 0;
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
