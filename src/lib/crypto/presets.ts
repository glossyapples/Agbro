// Crypto strategy presets. Each preset is a named snapshot of the raw
// CryptoConfig fields: allowlist, target allocations, rebalance band,
// rebalance cadence. The engine reads those fields directly and doesn't
// know about preset names — presetKey is purely a UI label so users can
// reason about the strategy they're running without staring at a pile
// of raw config.
//
// We deliberately kept this to four options. Crypto doesn't have as many
// genuinely distinct schools of thought as equities, and every preset
// beyond these four either requires LLM reasoning (against our "rule-
// based crypto only" constraint) or adds complexity that doesn't pay off
// in actionable alpha.

export type CryptoPresetKey =
  | 'btc_only'
  | 'top3_core'
  | 'equal_weight_top3'
  | 'custom';

export type CryptoPreset = {
  key: CryptoPresetKey;
  label: string;
  oneLiner: string;
  description: string;
  allowlist: string[];
  targetAllocations: Record<string, number>;
  rebalanceBandPct: number;
  rebalanceCadenceDays: number;
  // Whether the preset locks the raw fields in the UI (true) or exposes
  // them for free editing (Custom only).
  locked: boolean;
};

export const CRYPTO_PRESETS: Record<CryptoPresetKey, CryptoPreset> = {
  btc_only: {
    key: 'btc_only',
    label: 'Bitcoin Only',
    oneLiner: 'One asset, one thesis. Maximum conviction.',
    description:
      'Pure BTC accumulation. No altcoins, no rebalancing (nothing to rebalance between). The simplest possible crypto strategy — a single-asset long-term hold fed by recurring DCA.',
    allowlist: ['BTC/USD'],
    targetAllocations: { 'BTC/USD': 100 },
    // With one asset there is no drift to rebalance; these are moot but
    // kept for shape consistency. The engine will short-circuit with
    // maxDrift = 0.
    rebalanceBandPct: 100,
    rebalanceCadenceDays: 365,
    locked: true,
  },
  top3_core: {
    key: 'top3_core',
    label: 'Top-3 Core',
    oneLiner: 'Blue-chip weighted, quarterly rebalance.',
    description:
      'Market-cap-style weighting across the three most-liquid Alpaca pairs: 60% BTC, 30% ETH, 10% SOL. Rebalances quarterly if any position drifts more than 10pt from target. The crypto equivalent of a cap-weighted core holding.',
    allowlist: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
    targetAllocations: { 'BTC/USD': 60, 'ETH/USD': 30, 'SOL/USD': 10 },
    rebalanceBandPct: 10,
    rebalanceCadenceDays: 90,
    locked: true,
  },
  equal_weight_top3: {
    key: 'equal_weight_top3',
    label: 'Equal Weight Top-3',
    oneLiner: "Don't pick winners — hold the index.",
    description:
      'Equal-weight across BTC/ETH/SOL (33.3% each). Tighter 5pt rebalance band, monthly cadence. Produces more rebalance activity than Top-3 Core because equal weights drift faster; benefits from the "buy low, sell high" mechanical signal of frequent band breaches.',
    allowlist: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
    targetAllocations: { 'BTC/USD': 33.4, 'ETH/USD': 33.3, 'SOL/USD': 33.3 },
    rebalanceBandPct: 5,
    rebalanceCadenceDays: 30,
    locked: true,
  },
  custom: {
    key: 'custom',
    label: 'Custom',
    oneLiner: 'Pick everything yourself.',
    description:
      'Expert mode. Pick any combination of supported coins, any target percentages, any rebalance band and cadence. Use this only if you have a specific thesis — otherwise a preset is usually better because it removes decisions you don\'t have a strong opinion on.',
    allowlist: [],
    targetAllocations: {},
    rebalanceBandPct: 10,
    rebalanceCadenceDays: 90,
    locked: false,
  },
};

export function getPreset(key: string | null | undefined): CryptoPreset {
  if (key && key in CRYPTO_PRESETS) return CRYPTO_PRESETS[key as CryptoPresetKey];
  return CRYPTO_PRESETS.custom;
}

export const CRYPTO_PRESET_KEYS = Object.keys(CRYPTO_PRESETS) as CryptoPresetKey[];
