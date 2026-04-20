// Model policy. Trade decisions MUST use Claude Opus 4.7.
// This is enforced here and referenced everywhere instead of hard-coding
// model strings at the call sites.

export const TRADE_DECISION_MODEL = 'claude-opus-4-7' as const;
export const BRAIN_WRITEUP_MODEL =
  process.env.AGBRO_MODEL || 'claude-opus-4-7';
export const FAST_MODEL =
  process.env.AGBRO_FAST_MODEL || 'claude-haiku-4-5-20251001';

// Guard: if someone tries to pass a non-Opus-4.7 model to a trade decision,
// we refuse. The user explicitly required Opus 4.7 for trade decisions.
export function assertTradeModel(model: string): asserts model is typeof TRADE_DECISION_MODEL {
  if (model !== TRADE_DECISION_MODEL) {
    throw new Error(
      `Trade decisions must use ${TRADE_DECISION_MODEL}. Got: ${model}. This is a hard safety rail.`
    );
  }
}
