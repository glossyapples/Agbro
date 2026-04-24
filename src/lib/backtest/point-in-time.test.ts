// Phase 2 property tests on the point-in-time fundamentals cache key.
// Pins down the scope-isolation guarantee — the fix that unblocked
// parallel grid cells from racing each other's cached entries.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { cacheKey } from './point-in-time';

const scope = fc.string({ minLength: 1, maxLength: 32 });
const symbol = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((s) => /^[A-Z]+$/i.test(s))
  .map((s) => s.toUpperCase());
const ymd = fc
  .integer({ min: new Date('2015-01-01').getTime(), max: new Date('2035-12-31').getTime() })
  .map((ms) => new Date(ms).toISOString().slice(0, 10));
const price = fc.float({ min: Math.fround(0.01), max: Math.fround(100_000), noNaN: true });

describe('cacheKey (property)', () => {
  it('same inputs → same key (deterministic)', () => {
    fc.assert(
      fc.property(scope, symbol, ymd, price, (s, sym, d, p) => {
        expect(cacheKey(s, sym, d, p)).toBe(cacheKey(s, sym, d, p));
      })
    );
  });

  it('different scope → different key (scope isolation — pins the grid-race fix)', () => {
    fc.assert(
      fc.property(
        scope,
        scope,
        symbol,
        ymd,
        price,
        (scopeA, scopeB, sym, d, p) => {
          fc.pre(scopeA !== scopeB);
          expect(cacheKey(scopeA, sym, d, p)).not.toBe(cacheKey(scopeB, sym, d, p));
        }
      )
    );
  });

  it('different symbol → different key', () => {
    fc.assert(
      fc.property(
        scope,
        symbol,
        symbol,
        ymd,
        price,
        (s, symA, symB, d, p) => {
          fc.pre(symA !== symB);
          expect(cacheKey(s, symA, d, p)).not.toBe(cacheKey(s, symB, d, p));
        }
      )
    );
  });

  it('different date → different key', () => {
    fc.assert(
      fc.property(
        scope,
        symbol,
        ymd,
        ymd,
        price,
        (s, sym, dA, dB, p) => {
          fc.pre(dA !== dB);
          expect(cacheKey(s, sym, dA, p)).not.toBe(cacheKey(s, sym, dB, p));
        }
      )
    );
  });

  it('price rounding: prices within the same cent bucket share a key', () => {
    // Implementation rounds price × 100 → integer cents. Tests should pin
    // this so a future "don't round" refactor doesn't silently blow up
    // cache hit rate.
    fc.assert(
      fc.property(scope, symbol, ymd, (s, sym, d) => {
        // 100.001 and 100.004 both round to 10000 cents.
        expect(cacheKey(s, sym, d, 100.001)).toBe(cacheKey(s, sym, d, 100.004));
      })
    );
  });

  it('returns a non-empty string for any valid input', () => {
    fc.assert(
      fc.property(scope, symbol, ymd, price, (s, sym, d, p) => {
        const k = cacheKey(s, sym, d, p);
        expect(typeof k).toBe('string');
        expect(k.length).toBeGreaterThan(0);
      })
    );
  });
});
