// Anthropic pricing lookup for per-run cost accounting.
//
// Prices are USD per 1 million tokens and are best-effort estimates for the
// Opus / Sonnet / Haiku tiers — Anthropic's published prices are the source
// of truth, so override via env vars if a model's rate changes:
//   AGBRO_PRICE_IN_PER_MTOK_<MODEL>  (e.g. AGBRO_PRICE_IN_PER_MTOK_CLAUDE_OPUS_4_7)
//   AGBRO_PRICE_OUT_PER_MTOK_<MODEL>
// Unknown models fall back to $0 (no cost recorded) rather than guessing.

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

type PriceRow = {
  inPerMtok: number;
  outPerMtok: number;
  cacheReadPerMtok?: number;
  cacheWritePerMtok?: number;
};

// Tier-based defaults. Match by prefix so future minor revisions (4.7 → 4.8)
// don't silently lose cost tracking. Anthropic models OR OpenAI GPT-5 family.
const TIER_DEFAULTS: Array<{ match: (m: string) => boolean; price: PriceRow }> = [
  {
    match: (m) => m.includes('opus'),
    price: { inPerMtok: 15, outPerMtok: 75, cacheReadPerMtok: 1.5, cacheWritePerMtok: 18.75 },
  },
  {
    match: (m) => m.includes('sonnet'),
    price: { inPerMtok: 3, outPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75 },
  },
  {
    match: (m) => m.includes('haiku'),
    price: { inPerMtok: 1, outPerMtok: 5, cacheReadPerMtok: 0.1, cacheWritePerMtok: 1.25 },
  },
  // ── OpenAI GPT-5 family (best-effort estimates as of Jan 2026) ───────────
  // Override via AGBRO_PRICE_IN_PER_MTOK_GPT_5 / _GPT_5_PRO / etc. env vars.
  // Order matters: more-specific match before less-specific.
  {
    match: (m) => m.includes('gpt-5-pro') || m.includes('gpt5-pro') || m.includes('gpt-5.5'),
    price: { inPerMtok: 15, outPerMtok: 60 },
  },
  {
    match: (m) => m.includes('gpt-5-mini') || m.includes('gpt5-mini'),
    price: { inPerMtok: 0.1, outPerMtok: 0.4 },
  },
  {
    match: (m) => m.includes('gpt-5') || m.includes('gpt5'),
    price: { inPerMtok: 1.25, outPerMtok: 10 },
  },
  {
    match: (m) => m.includes('gpt-4o'),
    price: { inPerMtok: 2.5, outPerMtok: 10 },
  },
  {
    match: (m) => m.includes('o1-pro') || m.includes('o3-pro'),
    price: { inPerMtok: 15, outPerMtok: 60 },
  },
  {
    match: (m) => /\bo[13]\b/.test(m),
    price: { inPerMtok: 1.25, outPerMtok: 10 },
  },
];

function envKey(model: string): string {
  return model.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function priceFor(model: string): PriceRow {
  const key = envKey(model);
  const envIn = process.env[`AGBRO_PRICE_IN_PER_MTOK_${key}`];
  const envOut = process.env[`AGBRO_PRICE_OUT_PER_MTOK_${key}`];
  if (envIn && envOut) {
    return {
      inPerMtok: Number(envIn) || 0,
      outPerMtok: Number(envOut) || 0,
    };
  }
  const m = model.toLowerCase();
  const tier = TIER_DEFAULTS.find((t) => t.match(m));
  return tier?.price ?? { inPerMtok: 0, outPerMtok: 0 };
}

// Returns USD cost (not cents). Caller rounds for persistence.
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const p = priceFor(model);
  const cost =
    (usage.inputTokens / 1_000_000) * p.inPerMtok +
    (usage.outputTokens / 1_000_000) * p.outPerMtok +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * (p.cacheReadPerMtok ?? 0) +
    ((usage.cacheWriteTokens ?? 0) / 1_000_000) * (p.cacheWritePerMtok ?? 0);
  return Number.isFinite(cost) && cost > 0 ? Number(cost.toFixed(6)) : 0;
}

export const __pricingInternal = { priceFor, TIER_DEFAULTS };
