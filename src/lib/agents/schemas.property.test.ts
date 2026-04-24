// Phase 2 property tests on PlaceTradeInput. Complements the example-based
// tests in schemas.test.ts with generative coverage of the superRefine gate
// (buys require intrinsicValuePerShare + marginOfSafetyPct; sells don't).
//
// Pins the specific regression the MOS gate exists to prevent: a buy
// getting through without a documented fair value. The schema is the
// last line of defense before place_trade dispatches to Alpaca.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PlaceTradeInput } from './schemas';

// Arbitraries for each field. Kept as primitives so tests compose them
// into valid / adversarial shapes without repeating the schema.
const symbol = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => s.trim().length > 0);
const qtyValid = fc.float({ min: Math.fround(0.0001), max: Math.fround(1_000_000), noNaN: true });
const confidence = fc.float({ min: 0, max: 1, noNaN: true });
const longishString = fc.string({ minLength: 1, maxLength: 200 });
const ivPos = fc.float({ min: Math.fround(0.01), max: Math.fround(100_000), noNaN: true });
const mosAny = fc.float({ min: Math.fround(-100), max: Math.fround(100), noNaN: true });

const buyBase = fc.record({
  symbol,
  side: fc.constant('buy' as const),
  qty: qtyValid,
  orderType: fc.option(fc.constantFrom('market' as const, 'limit' as const)),
  limitPrice: fc.option(fc.float({ min: Math.fround(0.01), max: Math.fround(100_000), noNaN: true })),
  bullCase: longishString,
  bearCase: longishString,
  thesis: longishString,
  confidence,
});

const sellBase = fc.record({
  symbol,
  side: fc.constant('sell' as const),
  qty: qtyValid,
  orderType: fc.option(fc.constantFrom('market' as const, 'limit' as const)),
  limitPrice: fc.option(fc.float({ min: Math.fround(0.01), max: Math.fround(100_000), noNaN: true })),
  bullCase: longishString,
  bearCase: longishString,
  thesis: longishString,
  confidence,
});

function stripNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in obj) if (obj[k] !== null && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

describe('PlaceTradeInput — superRefine property coverage', () => {
  it('any well-formed BUY with positive IV + numeric MOS is accepted', () => {
    fc.assert(
      fc.property(buyBase, ivPos, mosAny, (base, iv, mos) => {
        const input = { ...stripNulls(base), intrinsicValuePerShare: iv, marginOfSafetyPct: mos };
        const r = PlaceTradeInput.safeParse(input);
        expect(r.success).toBe(true);
      })
    );
  });

  it('any BUY missing intrinsicValuePerShare is rejected', () => {
    fc.assert(
      fc.property(buyBase, mosAny, (base, mos) => {
        const input = { ...stripNulls(base), marginOfSafetyPct: mos };
        const r = PlaceTradeInput.safeParse(input);
        expect(r.success).toBe(false);
        if (!r.success) {
          const msgs = r.error.issues.map((i) => i.message).join(' ');
          expect(msgs).toMatch(/intrinsicValuePerShare|fair value/i);
        }
      })
    );
  });

  it('any BUY missing marginOfSafetyPct is rejected', () => {
    fc.assert(
      fc.property(buyBase, ivPos, (base, iv) => {
        const input = { ...stripNulls(base), intrinsicValuePerShare: iv };
        const r = PlaceTradeInput.safeParse(input);
        expect(r.success).toBe(false);
        if (!r.success) {
          const msgs = r.error.issues.map((i) => i.message).join(' ');
          expect(msgs).toMatch(/marginOfSafetyPct|margin of safety|MOS/i);
        }
      })
    );
  });

  it('BUY with IV ≤ 0 is rejected even if marginOfSafetyPct is present', () => {
    fc.assert(
      fc.property(
        buyBase,
        fc.float({ min: Math.fround(-1_000), max: 0, noNaN: true }),
        mosAny,
        (base, iv, mos) => {
          const input = { ...stripNulls(base), intrinsicValuePerShare: iv, marginOfSafetyPct: mos };
          const r = PlaceTradeInput.safeParse(input);
          expect(r.success).toBe(false);
        }
      )
    );
  });

  it('any well-formed SELL is accepted regardless of IV/MOS presence', () => {
    fc.assert(
      fc.property(sellBase, fc.option(ivPos), fc.option(mosAny), (base, iv, mos) => {
        const input: Record<string, unknown> = stripNulls(base);
        if (iv != null) input.intrinsicValuePerShare = iv;
        if (mos != null) input.marginOfSafetyPct = mos;
        const r = PlaceTradeInput.safeParse(input);
        expect(r.success).toBe(true);
      })
    );
  });

  it('qty outside (0, 1_000_000] is always rejected (buys and sells)', () => {
    fc.assert(
      fc.property(
        fc.oneof(buyBase, sellBase),
        ivPos,
        mosAny,
        fc.oneof(
          fc.constant(0),
          fc.float({ min: Math.fround(-1_000_000), max: Math.fround(-0.0001), noNaN: true }),
          fc.float({ min: Math.fround(1_000_001), max: Math.fround(10_000_000), noNaN: true })
        ),
        (base, iv, mos, badQty) => {
          const input = {
            ...stripNulls(base),
            qty: badQty,
            intrinsicValuePerShare: iv,
            marginOfSafetyPct: mos,
          };
          const r = PlaceTradeInput.safeParse(input);
          expect(r.success).toBe(false);
        }
      )
    );
  });

  it('non-finite qty/confidence is always rejected', () => {
    fc.assert(
      fc.property(
        buyBase,
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        fc.boolean(),
        (base, bad, swapConfidence) => {
          const input = {
            ...stripNulls(base),
            intrinsicValuePerShare: 100,
            marginOfSafetyPct: 25,
            ...(swapConfidence ? { confidence: bad } : { qty: bad }),
          };
          const r = PlaceTradeInput.safeParse(input);
          expect(r.success).toBe(false);
        }
      )
    );
  });

  it('confidence outside [0,1] is always rejected', () => {
    fc.assert(
      fc.property(
        buyBase,
        ivPos,
        mosAny,
        fc.oneof(
          fc.float({ min: Math.fround(-10), max: Math.fround(-0.0001), noNaN: true }),
          fc.float({ min: Math.fround(1.0001), max: Math.fround(10), noNaN: true })
        ),
        (base, iv, mos, badConf) => {
          const input = {
            ...stripNulls(base),
            confidence: badConf,
            intrinsicValuePerShare: iv,
            marginOfSafetyPct: mos,
          };
          const r = PlaceTradeInput.safeParse(input);
          expect(r.success).toBe(false);
        }
      )
    );
  });

  it('marginOfSafetyPct outside [-100, 100] is always rejected on buys', () => {
    fc.assert(
      fc.property(
        buyBase,
        ivPos,
        fc.oneof(
          fc.float({ min: Math.fround(-1_000), max: Math.fround(-100.01), noNaN: true }),
          fc.float({ min: Math.fround(100.01), max: Math.fround(1_000), noNaN: true })
        ),
        (base, iv, badMos) => {
          const input = {
            ...stripNulls(base),
            intrinsicValuePerShare: iv,
            marginOfSafetyPct: badMos,
          };
          const r = PlaceTradeInput.safeParse(input);
          expect(r.success).toBe(false);
        }
      )
    );
  });

  it('deterministic: safeParse on the same input always yields the same verdict', () => {
    fc.assert(
      fc.property(buyBase, fc.option(ivPos), fc.option(mosAny), (base, iv, mos) => {
        const input: Record<string, unknown> = stripNulls(base);
        if (iv != null) input.intrinsicValuePerShare = iv;
        if (mos != null) input.marginOfSafetyPct = mos;
        const a = PlaceTradeInput.safeParse(input);
        const b = PlaceTradeInput.safeParse(input);
        expect(a.success).toBe(b.success);
      })
    );
  });
});
