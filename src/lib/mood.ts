// Market + Agent mood classification — pure functions so the UI stays
// dumb and the logic is testable. The moods are the classic trader
// vernacular (greedy / fearful / patient / etc.) so experienced users
// recognise them instantly, and new users learn the vocabulary by
// osmosis.
//
// No external APIs, no "Fear & Greed Index" fetches — everything is
// derived from data the app already computes: the MarketRegime
// tripwire's latest row and the last ~N AgentRun decision fields.

import type { Regime } from '@/lib/data/regime';

export type Mood = {
  // One-word label for the mood ring.
  label: string;
  // Tailwind classes for the ring gradient. Two-color gradient from
  // the mood's primary to a darker shade gives the mood-ring look.
  ringClass: string;
  // Tailwind text color for the label + mood accent.
  textClass: string;
  // Emoji inside the ring. Picked to reinforce the word, not replace it.
  emoji: string;
  // One-line description for the card itself.
  description: string;
  // Plain-English explanation for the "Why this mood?" tooltip. Longer.
  detail: string;
};

// ─── Market mood ────────────────────────────────────────────────────────
// Driven by the regime tripwire plus 5-day SPY drift, so the label
// reflects both "what's happening right now" (crisis / elevated /
// recovery) and "what direction is this drifting" (up vs. down vs. flat).

export type MarketMoodInput = {
  regime: Regime;
  spyDailyMovePct: number | null;
  spy5dPct: number | null;
};

export function classifyMarketMood(input: MarketMoodInput): Mood {
  const { regime, spyDailyMovePct, spy5dPct } = input;

  if (regime === 'crisis') {
    return {
      label: 'Panicked',
      ringClass: 'from-red-400 to-red-700',
      textClass: 'text-red-300',
      emoji: '😱',
      description: 'Major selloff underway.',
      detail:
        `The market regime tripwire is flagging a crisis — typically a single-day SPY drop of 7%+ or ` +
        `a grinding multi-day cumulative decline of 10%+. Your agent switches to its crisis playbooks: ` +
        `no new buys on leverage, review held positions, raise cash only if the thesis is broken.`,
    };
  }

  if (regime === 'recovery') {
    return {
      label: 'Hopeful',
      ringClass: 'from-emerald-400 to-teal-600',
      textClass: 'text-emerald-300',
      emoji: '🌱',
      description: 'Bouncing after a selloff.',
      detail:
        `SPY bounced 3%+ on the day and the prior regime was elevated or crisis. ` +
        `Often the best time to deploy capital — but the agent stays selective, not euphoric.`,
    };
  }

  if (regime === 'elevated') {
    if (spyDailyMovePct != null && spyDailyMovePct <= -2) {
      return {
        label: 'Fearful',
        ringClass: 'from-amber-400 to-red-500',
        textClass: 'text-amber-300',
        emoji: '😰',
        description: 'Broader market has the wobbles.',
        detail:
          `SPY is down ${spyDailyMovePct.toFixed(1)}% today and the regime is elevated — multiple ` +
          `consecutive down days or a significant single-day drop. Agent is more cautious than normal ` +
          `but not yet in full crisis mode.`,
      };
    }
    return {
      label: 'Cautious',
      ringClass: 'from-yellow-400 to-amber-600',
      textClass: 'text-amber-200',
      emoji: '🤨',
      description: 'Small signs of stress.',
      detail:
        `The regime tripwire is elevated — probably 3+ consecutive down days. Agent is alert but ` +
        `the market hasn't crossed into crisis territory yet.`,
    };
  }

  // regime === 'calm' — differentiate by 5-day drift
  if (spy5dPct != null && spy5dPct >= 3) {
    return {
      label: 'Greedy',
      ringClass: 'from-brand-400 to-emerald-600',
      textClass: 'text-brand-300',
      emoji: '🤑',
      description: `Strong uptrend — SPY +${spy5dPct.toFixed(1)}% over 5 days.`,
      detail:
        `Markets are calm and climbing. Classically the time to be fully invested, but also when ` +
        `exuberance builds — watch for unusually high P/Es across the broader market.`,
    };
  }
  if (spy5dPct != null && spy5dPct > 0.5) {
    return {
      label: 'Content',
      ringClass: 'from-brand-500 to-teal-700',
      textClass: 'text-brand-300',
      emoji: '😌',
      description: 'Calm and drifting up.',
      detail:
        `SPY is up modestly (+${spy5dPct.toFixed(1)}% over 5 days) with no regime stress. The boring ` +
        `version of a bull market — often what "normal" looks like.`,
    };
  }
  if (spy5dPct != null && spy5dPct < -0.5) {
    return {
      label: 'Moody',
      ringClass: 'from-ink-500 to-amber-700',
      textClass: 'text-ink-200',
      emoji: '😕',
      description: 'Drifting down but no alarms.',
      detail:
        `SPY down ${spy5dPct.toFixed(1)}% over 5 days but the regime hasn't flipped. Normal chop — ` +
        `no action needed from the agent.`,
    };
  }
  return {
    label: 'Quiet',
    ringClass: 'from-ink-500 to-ink-700',
    textClass: 'text-ink-200',
    emoji: '😐',
    description: 'Flat and boring.',
    detail:
      `Markets are calm and barely moving (5d change ${spy5dPct == null ? 'n/a' : spy5dPct.toFixed(1) + '%'}). ` +
      `Often the best backdrop for value investing — less noise, more signal.`,
  };
}

// ─── Agent mood ─────────────────────────────────────────────────────────
// Inferred from the pattern of recent decisions. A single run's
// outcome isn't enough to form a mood, so we look at the last 3-5
// and categorize by the pattern.

export type AgentMoodInput = {
  recentDecisions: Array<{
    decision: string | null;
    startedAt: Date;
    status: string;
  }>;
  isMarketOpen: boolean;
  // The agent's mood is coloured by the market it's operating in —
  // e.g. "holding" in a crisis reads as defensive, not patient.
  currentRegime: Regime;
};

function decisionKind(d: string | null): 'buy' | 'sell' | 'hold' | 'other' {
  if (!d) return 'other';
  const lower = d.toLowerCase();
  if (lower.startsWith('buy')) return 'buy';
  if (lower.startsWith('sell') || lower.startsWith('trim') || lower.startsWith('exit')) return 'sell';
  if (lower.startsWith('hold') || lower.includes('no trades')) return 'hold';
  return 'other';
}

export function classifyAgentMood(input: AgentMoodInput): Mood {
  const { recentDecisions, isMarketOpen, currentRegime } = input;

  // No runs in the last day AND market is closed → off duty.
  const now = Date.now();
  const latest = recentDecisions[0];
  const hoursSinceLatest = latest
    ? (now - new Date(latest.startedAt).getTime()) / 3_600_000
    : Infinity;

  if (!latest || (hoursSinceLatest > 12 && !isMarketOpen)) {
    return {
      label: 'Off duty',
      ringClass: 'from-ink-500 to-ink-800',
      textClass: 'text-ink-300',
      emoji: '💤',
      description: isMarketOpen ? 'Waking up soon.' : 'Markets closed.',
      detail:
        `Your agent isn't running right now${
          !isMarketOpen ? ' because US stock markets are closed' : ' — check back in a few minutes'
        }. ` +
        `Crypto runs 24/7 so your crypto book is still being managed; this mood reflects the stock agent.`,
    };
  }

  // Market in crisis or elevated regime → defensive, regardless of the
  // specific buy/sell pattern. "Holding through a crisis" reads as
  // defensive, not patient.
  const defensive = currentRegime === 'crisis' || currentRegime === 'elevated';
  if (defensive) {
    return {
      label: 'Defensive',
      ringClass: 'from-red-400 to-red-700',
      textClass: 'text-red-300',
      emoji: '🛡',
      description: 'Market event — in protection mode.',
      detail:
        `A regime change (elevated or crisis) woke the agent outside its normal cadence. It's ` +
        `re-evaluating held positions against the new risk picture — prioritising not-losing over ` +
        `finding new names.`,
    };
  }

  // Classify the pattern of the last 3 decisions.
  const recent3 = recentDecisions.slice(0, 3).map((r) => decisionKind(r.decision));
  const buys = recent3.filter((k) => k === 'buy').length;
  const sells = recent3.filter((k) => k === 'sell').length;
  const holds = recent3.filter((k) => k === 'hold').length;

  if (buys >= 2 && sells === 0) {
    return {
      label: 'Bullish',
      ringClass: 'from-brand-400 to-emerald-600',
      textClass: 'text-brand-300',
      emoji: '🚀',
      description: 'Finding opportunities and buying.',
      detail:
        `Most recent decisions were purchases. The agent sees value worth deploying capital into — ` +
        `either the universe got cheaper, or cash built up and it's putting it to work.`,
    };
  }
  if (sells >= 2 && buys === 0) {
    return {
      label: 'Bearish',
      ringClass: 'from-red-400 to-orange-600',
      textClass: 'text-red-300',
      emoji: '🐻',
      description: 'Raising cash — trimming positions.',
      detail:
        `Most recent decisions were sells. The agent is taking profits, exiting broken theses, or ` +
        `reducing exposure. Cash building up for later redeployment.`,
    };
  }
  if (buys >= 1 && sells >= 1) {
    return {
      label: 'Rebalancing',
      ringClass: 'from-brand-500 to-sky-600',
      textClass: 'text-brand-300',
      emoji: '🎯',
      description: 'Some in, some out.',
      detail:
        `Mixed pattern — buying some names, selling others. Classic rebalance: rotating capital ` +
        `from expensive names to cheaper ones without changing overall exposure much.`,
    };
  }
  if (holds >= 2) {
    return {
      label: 'Patient',
      ringClass: 'from-ink-400 to-brand-700',
      textClass: 'text-brand-300',
      emoji: '🧘',
      description: 'Watching — nothing worth doing.',
      detail:
        `Most recent decisions were holds. "No trade" is often the right answer for a value ` +
        `strategy. The agent reviewed the portfolio and saw no reason to act.`,
    };
  }
  return {
    label: 'Watching',
    ringClass: 'from-ink-500 to-ink-700',
    textClass: 'text-ink-200',
    emoji: '👀',
    description: 'Monitoring — no strong signal.',
    detail:
      `Mixed or unclear recent pattern. Agent is running its normal cycle but no dominant theme ` +
      `has emerged yet — check the runs log for the decision detail.`,
  };
}
