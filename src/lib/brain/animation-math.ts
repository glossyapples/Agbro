// Math for the brain animation. Pure functions, no DOM. Drives how
// many synapses are visible / firing on the brain at any given
// moment.
//
// The headline equation:
//
//   intensity = (idle + activityBurst) × synapseMultiplier
//
//   - idle: a constant ambient floor (~1.0). Without this, an empty
//     account with no agent runs would render a dead-looking brain.
//   - activityBurst: 0..2.0, decays over ~5 minutes after the most
//     recent agent run. Means the brain literally lights up when
//     the agent has just done something.
//   - synapseMultiplier: 0.4..2.0 on a log curve over the user's
//     total brain entry count. A user with 10 entries renders ~0.6,
//     a user with 200 renders ~1.6. Caps so a maxed-out brain can't
//     dominate the canvas with so many synapses the page chugs.
//
// Concrete consumers:
//   - active synapse count = round(BASE_COUNT × intensity)
//     where BASE_COUNT = 30 → range ~12 to ~120
//   - firing arc rate    = baseHz × intensity
//
// All exports are pure; the canvas component just calls them with
// the latest props and re-derives.

export const BASE_SYNAPSE_COUNT = 30;
export const MIN_SYNAPSES = 12;
export const MAX_SYNAPSES = 120;

// Idle floor. With zero agent activity in the last 5 min, the brain
// should still feel alive — not dead. Tuned by eye; 1.0 means "the
// synapseMultiplier alone determines how busy the canvas looks."
export const IDLE_LEVEL = 1.0;

// How long after an agent run the burst decays to zero. 5 min lines
// up with the user's typical "just kicked off a wake, now I'm
// looking at the brain page" window.
export const BURST_DURATION_MS = 5 * 60_000;

// Peak burst on the instant of an agent run completing. Adds 2.0 to
// the (idle + multiplier) base so an active brain at peak renders
// roughly 3× the synapses of a completely calm one.
export const BURST_PEAK = 2.0;

// Translate brain entry count to a multiplier. Log curve so adding
// the 11th entry feels meaningful but adding the 201st doesn't blow
// the canvas budget.
//
// Curve points (verified by node REPL; pinned by animation-math.test.ts —
// any tweak to the constants below should update the test deliberately):
//   0    entries → 0.40 (bare seed; the floor)
//   10   entries → 0.97
//   50   entries → 1.34
//   100  entries → 1.50
//   200  entries → 1.67
//   500  entries → 1.89
//   1000 entries → 2.00 (capped)
export function synapseMultiplier(entryCount: number): number {
  if (entryCount <= 0) return 0.4;
  // log10(entryCount + 1) maps 0→0, 9→1, 99→2, 999→3.
  // Scale so 0 entries → 0.4, 100 entries → ~1.26, 1000+ → ~2.0.
  const raw = 0.4 + 0.55 * Math.log10(entryCount + 1);
  return Math.max(0.4, Math.min(2.0, raw));
}

// Burst function: cosine-ease decay from BURST_PEAK at t=0 to 0 at
// t=BURST_DURATION_MS. Returns 0 if no recent run or run is older
// than the window.
export function activityBurst(
  lastRunAt: Date | null,
  now: Date = new Date()
): number {
  if (!lastRunAt) return 0;
  const elapsedMs = now.getTime() - lastRunAt.getTime();
  if (elapsedMs < 0 || elapsedMs >= BURST_DURATION_MS) return 0;
  // Cosine ease-out: starts at peak, decelerates smoothly to 0.
  // (1 + cos(π × t / duration)) / 2 maps 0→1, duration→0.
  const t = elapsedMs / BURST_DURATION_MS;
  const ease = (1 + Math.cos(Math.PI * t)) / 2;
  return BURST_PEAK * ease;
}

// The headline equation. Applied at every animation tick.
export function brainIntensity(args: {
  entryCount: number;
  lastRunAt: Date | null;
  now?: Date;
}): number {
  const m = synapseMultiplier(args.entryCount);
  const b = activityBurst(args.lastRunAt, args.now);
  return (IDLE_LEVEL + b) * m;
}

// Active-synapse count derived from intensity. Clamped so even a
// fresh account renders something visible and a maxed brain can't
// melt the GPU.
export function activeSynapseCount(intensity: number): number {
  const raw = Math.round(BASE_SYNAPSE_COUNT * intensity);
  return Math.max(MIN_SYNAPSES, Math.min(MAX_SYNAPSES, raw));
}

// Firing-arc rate (per second). Higher intensity = more frequent
// firing arcs. Tuned so an idle brain fires ~1/sec and a burst-
// peaked maxed-out brain fires ~6/sec.
export function firingArcRate(intensity: number): number {
  return Math.max(0.5, intensity * 1.2);
}
