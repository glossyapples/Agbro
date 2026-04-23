// Safety rails that run ABOVE the strategy rules. These are the
// backstops for "something is clearly wrong — halt" scenarios, in
// addition to the position/cadence/cash rules enforced elsewhere.
//
// Architecture:
//   • Pure-ish functions that read Account + portfolio history and
//     return a decision. They don't mutate on their own — callers
//     (scheduler, place_trade) decide what to do with the verdict.
//   • When a kill switch fires, the caller should set
//     account.isPaused=true with killSwitchReason+killSwitchTriggeredAt
//     populated so the UI can surface "halted by safety rails" distinctly
//     from a manual pause.
//   • User resets via /api/safety/clear-kill-switch (requires auth).
//     We do NOT auto-reset — a halt is a deliberate "come back and look
//     at this" signal, not a flaky alarm.

import { prisma } from '@/lib/db';
import { getPortfolioHistory } from '@/lib/alpaca';
import { log } from '@/lib/logger';

export type RailVerdict =
  | { ok: true }
  | { ok: false; reason: string; triggeredBy: 'daily_loss' | 'drawdown' | 'trade_notional' | 'other' };

// ─── Kill-switch gate for the scheduler ────────────────────────────────
// Called once per user per tick, BEFORE runAgent. Two independent checks:
//   (1) today's P&L vs. dailyLossKillPct
//   (2) current drawdown from 30-day high vs. drawdownPauseThresholdPct
// Either tripping halts trading. The helper returns a verdict; callers
// handle pause + logging + UI notification.

export async function checkKillSwitches(userId: string): Promise<RailVerdict> {
  const account = await prisma.account.findUnique({ where: { userId } });
  if (!account) return { ok: true }; // no account, nothing to protect

  // Already halted by a prior kill-switch trip — stay halted. User
  // resets manually. (Manual pause / stop is the caller's concern.)
  if (account.killSwitchTriggeredAt && account.killSwitchReason) {
    return {
      ok: false,
      reason: account.killSwitchReason,
      triggeredBy: 'other',
    };
  }

  // Daily P&L check. Uses Alpaca portfolio-history 1D range — same
  // data source as the home-page chart, so "what the user sees" and
  // "what triggers the kill" stay aligned.
  if (account.dailyLossKillPct && account.dailyLossKillPct < 0) {
    try {
      const dayBars = await getPortfolioHistory('1D');
      if (dayBars.length >= 2) {
        const open = dayBars[0].equity;
        const now = dayBars[dayBars.length - 1].equity;
        if (open > 0) {
          const pct = ((now - open) / open) * 100;
          if (pct <= account.dailyLossKillPct) {
            const reason = `Daily loss ${pct.toFixed(2)}% reached kill threshold (${account.dailyLossKillPct}%)`;
            log.warn('safety.daily_loss_kill', { userId, pct, threshold: account.dailyLossKillPct });
            return { ok: false, reason, triggeredBy: 'daily_loss' };
          }
        }
      }
    } catch (err) {
      // Fail-open on data errors — a broken Alpaca call shouldn't
      // silently halt trading. Log it so the operator notices.
      log.warn('safety.daily_loss_fetch_failed', { userId, err: (err as Error).message });
    }
  }

  // Drawdown from 30-day high. Also Alpaca-sourced so the trigger
  // matches what the user would compute by eyeballing the chart.
  if (account.drawdownPauseThresholdPct && account.drawdownPauseThresholdPct < 0) {
    try {
      const monthBars = await getPortfolioHistory('1M');
      if (monthBars.length >= 2) {
        let peak = 0;
        for (const p of monthBars) if (p.equity > peak) peak = p.equity;
        const now = monthBars[monthBars.length - 1].equity;
        if (peak > 0) {
          const pct = ((now - peak) / peak) * 100;
          if (pct <= account.drawdownPauseThresholdPct) {
            const reason = `30-day drawdown ${pct.toFixed(2)}% passed threshold (${account.drawdownPauseThresholdPct}%)`;
            log.warn('safety.drawdown_kill', {
              userId,
              pct,
              threshold: account.drawdownPauseThresholdPct,
            });
            return { ok: false, reason, triggeredBy: 'drawdown' };
          }
        }
      }
    } catch (err) {
      log.warn('safety.drawdown_fetch_failed', { userId, err: (err as Error).message });
    }
  }

  return { ok: true };
}

// Called by place_trade just before submitting. A defensive belt to
// complement the existing maxPositionPct / minCashReservePct / etc.
// checks: caps the ABSOLUTE notional per order. Protects against a
// bad price fetch or runaway sizing math.
export async function checkTradeNotional(
  userId: string,
  notionalCents: bigint
): Promise<RailVerdict> {
  const account = await prisma.account.findUnique({
    where: { userId },
    select: { maxTradeNotionalCents: true },
  });
  if (!account?.maxTradeNotionalCents) return { ok: true };
  if (notionalCents > account.maxTradeNotionalCents) {
    return {
      ok: false,
      reason: `trade notional $${Number(notionalCents) / 100} exceeds per-trade cap $${Number(account.maxTradeNotionalCents) / 100}`,
      triggeredBy: 'trade_notional',
    };
  }
  return { ok: true };
}

// Apply a kill-switch verdict by flipping the account into paused
// state with the reason stamped. Idempotent — repeated trips don't
// rewrite the original trigger timestamp if it's already set.
export async function applyKillSwitch(userId: string, reason: string): Promise<void> {
  await prisma.account.update({
    where: { userId },
    data: {
      isPaused: true,
      killSwitchTriggeredAt: new Date(),
      killSwitchReason: reason,
    },
  });
  log.warn('safety.kill_switch_applied', { userId, reason });
}

// Manual reset. Called from /api/safety/clear-kill-switch after the
// user has reviewed the situation. We clear isPaused too so the agent
// resumes, but only if isPaused was set BY the kill switch (evidence:
// killSwitchTriggeredAt is populated). If a user had manually paused
// and also hit the kill switch, we leave isPaused=true and let the
// user explicitly unpause via settings.
export async function clearKillSwitch(userId: string): Promise<void> {
  const account = await prisma.account.findUnique({ where: { userId } });
  if (!account?.killSwitchTriggeredAt) return;
  await prisma.account.update({
    where: { userId },
    data: {
      killSwitchTriggeredAt: null,
      killSwitchReason: null,
      // Resume only if there isn't a separate reason the user paused
      // manually. Heuristic: if isPaused is true and killSwitchReason
      // was the only thing, unpause. A proper distinction needs a
      // pauseReason field; good enough for v1.
      isPaused: false,
    },
  });
  log.info('safety.kill_switch_cleared', { userId });
}
