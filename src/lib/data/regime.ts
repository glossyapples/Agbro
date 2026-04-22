// Market regime detector. Cheap, deterministic, runs every cron tick.
// Reads SPY daily bars from Alpaca's free IEX feed, classifies the market
// into one of four regimes, and persists a new MarketRegime row only when
// the regime transitions. The cron uses transitions to force-wake every
// user agent regardless of cadence.
//
// Why SPY-only and not VIX / breadth / news?
//   - Alpaca paper doesn't expose VIX directly.
//   - News headlines are noisy and lagging — a real geopolitical shock
//     shows up in the index within minutes regardless of the headline.
//   - SPY's daily move + consecutive down days catches every historical
//     "SHTF" event we care about (1987, 2000, 2008, 2020, 2022) with
//     near-zero false positives. Adding more signals would add edge
//     cases without meaningfully better detection.
//
// Why ~15 min lag (IEX feed) is acceptable:
//   - 1987 Black Monday unfolded over hours.
//   - COVID-March 2020 cascaded over weeks.
//   - 15 min of lag on the wake-up trigger doesn't change the bot's
//     ability to act on a multi-day regime.

import { prisma } from '@/lib/db';
import { getBars } from '@/lib/alpaca';
import { log } from '@/lib/logger';

export type Regime = 'calm' | 'elevated' | 'crisis' | 'recovery';

export type RegimeAssessment = {
  regime: Regime;
  spyDailyMovePct: number | null;
  spyConsecutiveDownDays: number | null;
  triggers: string[];
};

export async function computeRegime(): Promise<RegimeAssessment> {
  // 32 days of bars gives us a healthy buffer for "consecutive down days"
  // counting across weekends + holidays. Back the end off 20 min for IEX
  // feed delay (same trick as the performance route).
  const startMs = Date.now() - 32 * 86_400_000;
  const endMs = Date.now() - 20 * 60_000;
  const bars = await getBars('SPY', '1Day', startMs, endMs).catch((err) => {
    log.warn('regime.spy_bars_failed', undefined, err);
    return [];
  });
  if (bars.length < 5) {
    return {
      regime: 'calm',
      spyDailyMovePct: null,
      spyConsecutiveDownDays: null,
      triggers: ['insufficient_data'],
    };
  }

  const today = bars[bars.length - 1];
  const yesterday = bars[bars.length - 2];
  const dailyMovePct = ((today.close - yesterday.close) / yesterday.close) * 100;

  // Count consecutive down days walking backwards from today.
  let consecutiveDown = 0;
  for (let i = bars.length - 1; i > 0; i--) {
    if (bars[i].close < bars[i - 1].close) consecutiveDown++;
    else break;
  }

  let cumulativeDownPct = 0;
  if (consecutiveDown > 0) {
    const startBar = bars[bars.length - 1 - consecutiveDown];
    cumulativeDownPct = ((today.close - startBar.close) / startBar.close) * 100;
  }

  const triggers: string[] = [];
  let regime: Regime = 'calm';

  // CRISIS thresholds — tuned to fire on COVID-March-2020 (-9.5% in a day),
  // Black Monday 1987 (-22%), and the GFC's worst weeks. Multi-day
  // cumulative trigger catches grinding declines (2008, 2022) that didn't
  // have any single big down day.
  if (dailyMovePct <= -7) {
    regime = 'crisis';
    triggers.push(`SPY ${dailyMovePct.toFixed(1)}% today`);
  } else if (consecutiveDown >= 4 && cumulativeDownPct <= -10) {
    regime = 'crisis';
    triggers.push(
      `${consecutiveDown} consecutive down days, ${cumulativeDownPct.toFixed(1)}% cumulative`
    );
  } else if (dailyMovePct <= -4) {
    // ELEVATED — single significant down day, the kind a value investor
    // shouldn't sleep through but isn't yet a generational opportunity.
    regime = 'elevated';
    triggers.push(`SPY ${dailyMovePct.toFixed(1)}% today`);
  } else if (consecutiveDown >= 3) {
    regime = 'elevated';
    triggers.push(`${consecutiveDown} consecutive down days`);
  }

  // RECOVERY: only fires when previously elevated/crisis AND today is a
  // meaningful up day. Lets the agent know to switch from "defensive
  // playbook" mode back to normal — and gives a clean log line when
  // the storm passes.
  if (regime === 'calm') {
    const lastRegime = await prisma.marketRegime.findFirst({
      orderBy: { enteredAt: 'desc' },
      select: { regime: true },
    });
    if (
      lastRegime &&
      (lastRegime.regime === 'elevated' || lastRegime.regime === 'crisis') &&
      dailyMovePct >= 3
    ) {
      regime = 'recovery';
      triggers.push(`SPY +${dailyMovePct.toFixed(1)}% bounce`);
    }
  }

  return { regime, spyDailyMovePct: dailyMovePct, spyConsecutiveDownDays: consecutiveDown, triggers };
}

// Detect regime + persist a new row ONLY on transition. Returns the
// assessment + a flag indicating whether this call introduced a new
// regime (cron uses the flag to decide whether to force-wake users).
export async function detectAndPersistRegime(): Promise<{
  assessment: RegimeAssessment;
  changed: boolean;
  previousRegime: Regime | null;
}> {
  const assessment = await computeRegime();
  const last = await prisma.marketRegime.findFirst({
    orderBy: { enteredAt: 'desc' },
    select: { regime: true },
  });
  const previousRegime = (last?.regime ?? null) as Regime | null;
  const changed = previousRegime !== assessment.regime;

  if (changed) {
    await prisma.marketRegime.create({
      data: {
        regime: assessment.regime,
        spyDailyMovePct: assessment.spyDailyMovePct,
        spyConsecutiveDownDays: assessment.spyConsecutiveDownDays,
        triggers: assessment.triggers,
      },
    });
    log.info('regime.transition', {
      from: previousRegime,
      to: assessment.regime,
      triggers: assessment.triggers,
    });
  }

  return { assessment, changed, previousRegime };
}

// Latest regime for the agent's get_account_state output. Returns 'calm'
// when no rows exist yet (fresh deploy).
export async function getCurrentRegime(): Promise<{
  regime: Regime;
  enteredAt: string | null;
  triggers: string[];
}> {
  const last = await prisma.marketRegime.findFirst({
    orderBy: { enteredAt: 'desc' },
  });
  if (!last) return { regime: 'calm', enteredAt: null, triggers: [] };
  return {
    regime: last.regime as Regime,
    enteredAt: last.enteredAt.toISOString(),
    triggers: Array.isArray(last.triggers) ? (last.triggers as string[]) : [],
  };
}
