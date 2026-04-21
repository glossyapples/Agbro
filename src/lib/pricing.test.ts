import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { estimateCostUsd } from './pricing';

describe('estimateCostUsd', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('AGBRO_PRICE_')) delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prices Opus-tier input + output tokens using tier defaults', () => {
    // Opus defaults: $15 in / $75 out per Mtok.
    // 1M in = $15, 1M out = $75 → $90 total for 1M in + 1M out.
    const cost = estimateCostUsd('claude-opus-4-7', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(90, 6);
  });

  it('includes cache-read and cache-write tokens', () => {
    // 1M cache-read @ $1.5, 1M cache-write @ $18.75 → $20.25.
    const cost = estimateCostUsd('claude-opus-4-7', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1.5 + 18.75, 6);
  });

  it('uses Sonnet defaults for a sonnet model id', () => {
    // Sonnet defaults: $3 in / $15 out.
    const cost = estimateCostUsd('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18, 6);
  });

  it('uses Haiku defaults for a haiku model id', () => {
    const cost = estimateCostUsd('claude-haiku-4-5-20251001', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6, 6);
  });

  it('returns 0 for an unknown model rather than guessing', () => {
    const cost = estimateCostUsd('claude-weird-new-thing', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(0);
  });

  it('returns 0 for zero usage', () => {
    expect(estimateCostUsd('claude-opus-4-7', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('respects per-model env overrides', () => {
    process.env.AGBRO_PRICE_IN_PER_MTOK_CLAUDE_OPUS_4_7 = '20';
    process.env.AGBRO_PRICE_OUT_PER_MTOK_CLAUDE_OPUS_4_7 = '100';
    const cost = estimateCostUsd('claude-opus-4-7', {
      inputTokens: 500_000,
      outputTokens: 500_000,
    });
    // 0.5M * 20 + 0.5M * 100 = 10 + 50 = 60.
    expect(cost).toBeCloseTo(60, 6);
  });

  it('rounds to 6 decimal places', () => {
    // 1 token in @ $15/Mtok = 0.000015 — exact. Tiny fractions get truncated.
    const cost = estimateCostUsd('claude-opus-4-7', { inputTokens: 1, outputTokens: 0 });
    expect(cost).toBe(0.000015);
  });
});
