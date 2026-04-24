// Typed helpers for the agent autonomy ladder. The field lives on
// Account as a string (Prisma string-enum pattern) but every consumer
// should route through these helpers so a typo fails at compile time
// rather than silently degrading to the default branch.
//
// Ladder semantics:
//   observe — agent analyzes, meets, writes brain, but every buy is
//             intercepted before reaching the trade gate and logged
//             as an action item for user review. Zero autonomous
//             execution; zero Governor-approved fills.
//   propose — Governor runs normally; any 'approved' verdict is
//             downgraded to 'requires_approval' and queued. Real
//             rail trips still reject. The user signs off on every
//             fill before it happens.
//   auto    — today's behaviour. Governor's native approve/reject
//             stands; only requires_approval verdicts queue.
//
// Defaults:
//   - Account.autonomyLevel has DB default 'auto' so schema upgrades
//     preserve existing behaviour.
//   - Onboarding wizard seeds 'propose' for new users (safer default
//     for people who just filled out a Mandate; they should see the
//     first few trades go through them before autopilot kicks in).

export const AUTONOMY_LEVELS = ['observe', 'propose', 'auto'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export function isAutonomyLevel(x: unknown): x is AutonomyLevel {
  return typeof x === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(x);
}

// Parse a value coming off the DB / wire. Falls back to 'auto' —
// the behaviour-preserving default — rather than throwing, because
// a bad value in the DB should not take down the scheduler. Loud
// log at call sites when the fallback fires.
export function parseAutonomyLevel(x: unknown): AutonomyLevel {
  return isAutonomyLevel(x) ? x : 'auto';
}

// User-facing label. Deliberately short; long-form explanations
// live in the onboarding wizard copy and the /settings tooltip.
export const AUTONOMY_LABEL: Record<AutonomyLevel, string> = {
  observe: 'Observe',
  propose: 'Propose',
  auto: 'Auto',
};

export const AUTONOMY_DESCRIPTION: Record<AutonomyLevel, string> = {
  observe:
    'Agent analyzes, holds meetings, and logs ideas — but never places trades without your approval.',
  propose:
    "Agent proposes trades one at a time. Every fill needs your sign-off from the approval queue.",
  auto:
    "Agent executes trades that pass every safety check automatically. You review what it did after the fact.",
};
