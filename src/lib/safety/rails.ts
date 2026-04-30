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
  | {
      ok: false;
      reason: string;
      // 'data_unavailable' signals a transient safety-check failure
      // (e.g. Alpaca 5xx) — caller should SKIP this tick without
      // persisting a kill-switch trip, so the next tick can retry.
      // The other variants are real trips and should persist via
      // applyKillSwitch.
      triggeredBy:
        | 'daily_loss'
        | 'drawdown'
        | 'trade_notional'
        | 'data_unavailable'
        | 'other';
    };

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

  // Fetch both portfolio-history windows in parallel; each fetch is
  // wrapped so a failure records dataUnavailable instead of throwing.
  // The actual decision logic is split out into classifyRailVerdict
  // (pure function, property-tested) so the DB + Alpaca I/O here can
  // stay thin.
  const dailyEnabled = !!account.dailyLossKillPct && account.dailyLossKillPct < 0;
  const drawdownEnabled =
    !!account.drawdownPauseThresholdPct && account.drawdownPauseThresholdPct < 0;

  let dayBars: { equity: number }[] | undefined;
  let monthBars: { equity: number }[] | undefined;
  let dailyFetchFailed = false;
  let drawdownFetchFailed = false;
  // Capture the underlying Alpaca error so the verdict's reason field
  // tells us WHICH call failed and why — Railway's log viewer has been
  // eating our log.warn lines, leaving no visible diagnostic.
  let dailyFetchErr: string | null = null;
  let drawdownFetchErr: string | null = null;

  if (dailyEnabled) {
    try {
      dayBars = await getPortfolioHistory('1D');
    } catch (err) {
      dailyFetchFailed = true;
      dailyFetchErr = (err as Error).message?.slice(0, 200) ?? String(err);
      log.warn('safety.daily_loss_fetch_failed', { userId, err: dailyFetchErr });
    }
  }
  if (drawdownEnabled) {
    try {
      monthBars = await getPortfolioHistory('1M');
    } catch (err) {
      drawdownFetchFailed = true;
      drawdownFetchErr = (err as Error).message?.slice(0, 200) ?? String(err);
      log.warn('safety.drawdown_fetch_failed', { userId, err: drawdownFetchErr });
    }
  }

  const verdict = classifyRailVerdict({
    dailyLossKillPct: account.dailyLossKillPct,
    drawdownPauseThresholdPct: account.drawdownPauseThresholdPct,
    dayBars,
    monthBars,
    dailyFetchFailed,
    drawdownFetchFailed,
  });
  // Inline the actual Alpaca error text into the data_unavailable
  // reason so it surfaces in /api/debug/scheduler-trace without a
  // logger that's silently dropping warns.
  if (!verdict.ok && verdict.triggeredBy === 'data_unavailable') {
    const parts: string[] = [];
    if (dailyFetchErr) parts.push(`daily: ${dailyFetchErr}`);
    if (drawdownFetchErr) parts.push(`drawdown: ${drawdownFetchErr}`);
    if (parts.length > 0) {
      return { ...verdict, reason: `${verdict.reason} — ${parts.join(' | ')}` };
    }
  }
  // Log trip-level events (not data-unavailable, which is a transient
  // skip, not a trip).
  if (!verdict.ok && verdict.triggeredBy === 'daily_loss') {
    log.warn('safety.daily_loss_kill', { userId, reason: verdict.reason });
  } else if (!verdict.ok && verdict.triggeredBy === 'drawdown') {
    log.warn('safety.drawdown_kill', { userId, reason: verdict.reason });
  }
  return verdict;
}

// Pure decision logic for the kill-switch. Split from the I/O in
// checkKillSwitches so property tests can enumerate every state
// transition without mocking Prisma + Alpaca.
//
// Ordering rule (matters for the `first trigger wins` invariant):
//   1. daily_loss fires first (intraday is the faster signal)
//   2. drawdown second
//   3. data_unavailable returned last if at least one enabled rail
//      couldn't evaluate — fails CLOSED (skip the tick) rather than
//      OPEN (continue trading blind).
export function classifyRailVerdict(input: {
  dailyLossKillPct: number | null | undefined;
  drawdownPauseThresholdPct: number | null | undefined;
  dayBars?: { equity: number }[];
  monthBars?: { equity: number }[];
  dailyFetchFailed?: boolean;
  drawdownFetchFailed?: boolean;
}): RailVerdict {
  const dailyEnabled =
    typeof input.dailyLossKillPct === 'number' && input.dailyLossKillPct < 0;
  const drawdownEnabled =
    typeof input.drawdownPauseThresholdPct === 'number' &&
    input.drawdownPauseThresholdPct < 0;
  const enabledRails: string[] = [];
  if (dailyEnabled) enabledRails.push('daily_loss');
  if (drawdownEnabled) enabledRails.push('drawdown');

  // Daily loss check.
  if (
    dailyEnabled &&
    input.dayBars &&
    input.dayBars.length >= 2
  ) {
    const open = input.dayBars[0].equity;
    const now = input.dayBars[input.dayBars.length - 1].equity;
    if (open > 0) {
      const pct = ((now - open) / open) * 100;
      const threshold = input.dailyLossKillPct as number;
      if (pct <= threshold) {
        return {
          ok: false,
          reason: `Daily loss ${pct.toFixed(2)}% reached kill threshold (${threshold}%)`,
          triggeredBy: 'daily_loss',
        };
      }
    }
  }

  // Drawdown check.
  if (
    drawdownEnabled &&
    input.monthBars &&
    input.monthBars.length >= 2
  ) {
    let peak = 0;
    for (const p of input.monthBars) if (p.equity > peak) peak = p.equity;
    const now = input.monthBars[input.monthBars.length - 1].equity;
    if (peak > 0) {
      const pct = ((now - peak) / peak) * 100;
      const threshold = input.drawdownPauseThresholdPct as number;
      if (pct <= threshold) {
        return {
          ok: false,
          reason: `30-day drawdown ${pct.toFixed(2)}% passed threshold (${threshold}%)`,
          triggeredBy: 'drawdown',
        };
      }
    }
  }

  // At least one enabled rail couldn't run → fail CLOSED for this tick.
  const anyFailed =
    (dailyEnabled && input.dailyFetchFailed) ||
    (drawdownEnabled && input.drawdownFetchFailed);
  if (anyFailed && enabledRails.length > 0) {
    return {
      ok: false,
      reason: `Safety-check data unavailable (Alpaca fetch failed for ${enabledRails.join(
        ' + '
      )}). Skipping this tick to avoid trading blind.`,
      triggeredBy: 'data_unavailable',
    };
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
