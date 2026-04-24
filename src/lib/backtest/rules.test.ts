import { describe, it, expect } from 'vitest';
import {
  resolveRuleset,
  STRATEGY_KEYS,
  STRATEGY_LABELS,
  DEFAULT_UNIVERSES,
  type StrategyKey,
} from './rules';

// resolveRuleset is the deterministic link between a strategy and its
// backtest filter spec. The Burry rotation regression lived here —
// this suite catches shape drift at commit time.

describe('STRATEGY_KEYS', () => {
  it('lists every preset exactly once', () => {
    expect(new Set(STRATEGY_KEYS).size).toBe(STRATEGY_KEYS.length);
    expect(STRATEGY_KEYS).toEqual(
      expect.arrayContaining([
        'buffett_core',
        'deep_value_graham',
        'quality_compounders',
        'dividend_growth',
        'boglehead_index',
        'burry_deep_research',
      ])
    );
  });

  it('has a label + default universe for every key', () => {
    for (const k of STRATEGY_KEYS) {
      expect(STRATEGY_LABELS[k]).toBeTypeOf('string');
      expect(STRATEGY_LABELS[k].length).toBeGreaterThan(0);
      expect(DEFAULT_UNIVERSES[k]).toBeInstanceOf(Array);
      expect(DEFAULT_UNIVERSES[k].length).toBeGreaterThan(0);
    }
  });

  it('default universes contain only uppercase tickers', () => {
    for (const k of STRATEGY_KEYS) {
      for (const sym of DEFAULT_UNIVERSES[k]) {
        expect(sym).toMatch(/^[A-Z][A-Z0-9.]{0,11}$/);
      }
    }
  });
});

describe('resolveRuleset', () => {
  it('returns a ruleset for every StrategyKey (no missing switch branches)', () => {
    for (const k of STRATEGY_KEYS) {
      const r = resolveRuleset(k);
      expect(r).toBeDefined();
      expect(typeof r).toBe('object');
    }
  });

  describe('buffett_core', () => {
    it('filters on ROE + P/E + D/E', () => {
      const r = resolveRuleset('buffett_core');
      expect(r.minROE).toBe(15);
      expect(r.maxPE).toBe(22);
      expect(r.maxDE).toBe(1.5);
    });
  });

  describe('quality_compounders', () => {
    it('demands higher ROE, accepts higher P/E than Buffett Core', () => {
      const r = resolveRuleset('quality_compounders');
      const buffett = resolveRuleset('buffett_core');
      expect(r.minROE).toBeGreaterThan(buffett.minROE ?? 0);
      expect(r.maxPE).toBeGreaterThan(buffett.maxPE ?? 0);
    });
  });

  describe('dividend_growth', () => {
    it('does NOT include minDividendYieldPct', () => {
      // Tier-3 fix — historical-fundamentals.ts stores dividendYield=null,
      // so a minDividendYieldPct filter in the backtest made every
      // symbol fail the filter. Live trading still enforces yield.
      // Leaving it back in would silently nuke every Dividend Growth
      // backtest.
      const r = resolveRuleset('dividend_growth');
      expect(r.minDividendYieldPct).toBeUndefined();
    });

    it('has ROE + P/E + D/E filters', () => {
      const r = resolveRuleset('dividend_growth');
      expect(r.minROE).toBeDefined();
      expect(r.maxPE).toBeDefined();
      expect(r.maxDE).toBeDefined();
    });
  });

  describe('deep_value_graham', () => {
    it('has target-sell + time-stop (mean-reversion exits)', () => {
      const r = resolveRuleset('deep_value_graham');
      expect(r.targetSellPct).toBe(30);
      expect(r.timeStopDays).toBe(730);
    });

    it('has cheap-screen filters (maxPE low, maxDE low)', () => {
      const r = resolveRuleset('deep_value_graham');
      expect(r.maxPE).toBeLessThan(20);
      expect(r.maxDE).toBeLessThanOrEqual(1);
    });
  });

  describe('boglehead_index', () => {
    it('has targetWeights + rebalance cadence', () => {
      const r = resolveRuleset('boglehead_index');
      expect(r.targetWeights).toBeDefined();
      expect(r.rebalanceBandPct).toBeDefined();
      expect(r.rebalanceCadenceDays).toBeDefined();
    });

    it('targetWeights sum to 1.0 (no leftover cash by default)', () => {
      const r = resolveRuleset('boglehead_index');
      const sum = Object.values(r.targetWeights ?? {}).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 6);
    });
  });

  describe('burry_deep_research', () => {
    it('returns an EMPTY ruleset — no filters, no rotation', () => {
      // The Tier-3 "rotation" regression: adding targetSellPct + timeStopDays
      // here caused exits to sell to cash with no redeploy path, silently
      // draining the book. P1.T1 reverted to {} with an honest
      // "buy-and-hold approximation" comment. This test nails that down.
      const r = resolveRuleset('burry_deep_research');
      expect(r.targetSellPct).toBeUndefined();
      expect(r.timeStopDays).toBeUndefined();
      expect(r.minROE).toBeUndefined();
      expect(r.maxPE).toBeUndefined();
      expect(r.maxDE).toBeUndefined();
      expect(r.targetWeights).toBeUndefined();
      expect(r.rebalanceCadenceDays).toBeUndefined();
      expect(r.minDividendYieldPct).toBeUndefined();
      expect(r.dcaAmountPerPeriod).toBeUndefined();
      expect(r.dcaCadenceDays).toBeUndefined();
      expect(r.minGrossMarginPct).toBeUndefined();
    });

    it('universe contains the seeded "ick" names', () => {
      const uni = DEFAULT_UNIVERSES.burry_deep_research;
      expect(uni.length).toBeGreaterThanOrEqual(5);
      // Guard against a silent rename / typo; these are the seeded
      // Burry-universe picks the /backtest UI defaults to.
      expect(uni).toEqual(
        expect.arrayContaining(['GEO', 'BMY', 'GILD', 'CVX'])
      );
    });
  });

  describe('ruleset shape invariants', () => {
    it('maxPE is strictly positive when present', () => {
      for (const k of STRATEGY_KEYS) {
        const r = resolveRuleset(k);
        if (r.maxPE != null) {
          expect(r.maxPE).toBeGreaterThan(0);
        }
      }
    });

    it('maxDE is non-negative when present', () => {
      for (const k of STRATEGY_KEYS) {
        const r = resolveRuleset(k);
        if (r.maxDE != null) {
          expect(r.maxDE).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('minROE is finite when present', () => {
      for (const k of STRATEGY_KEYS) {
        const r = resolveRuleset(k);
        if (r.minROE != null) {
          expect(Number.isFinite(r.minROE)).toBe(true);
        }
      }
    });

    it('rebalanceCadenceDays is positive when set', () => {
      for (const k of STRATEGY_KEYS) {
        const r = resolveRuleset(k);
        if (r.rebalanceCadenceDays != null) {
          expect(r.rebalanceCadenceDays).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('exhaustiveness', () => {
    it('every declared StrategyKey produces a distinct ruleset or explicit empty', () => {
      // Belt-and-suspenders against a copy-paste bug where two strategies
      // return byte-identical rulesets — subtle but a red flag.
      const seen = new Map<string, StrategyKey>();
      for (const k of STRATEGY_KEYS) {
        const serialised = JSON.stringify(resolveRuleset(k));
        // Empty object is legitimately shared (Burry intentionally empty);
        // anything else duplicating is suspicious.
        if (serialised !== '{}' && seen.has(serialised)) {
          throw new Error(
            `duplicate ruleset for ${k} and ${seen.get(k)!}: ${serialised}`
          );
        }
        seen.set(serialised, k);
      }
    });
  });
});
