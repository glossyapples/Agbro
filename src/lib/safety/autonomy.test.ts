import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  AUTONOMY_LEVELS,
  AUTONOMY_LABEL,
  AUTONOMY_DESCRIPTION,
  isAutonomyLevel,
  parseAutonomyLevel,
} from './autonomy';

describe('autonomy levels', () => {
  it('exposes exactly three levels in ladder order', () => {
    expect([...AUTONOMY_LEVELS]).toEqual(['observe', 'propose', 'auto']);
  });

  it('isAutonomyLevel accepts declared values only', () => {
    for (const lvl of AUTONOMY_LEVELS) expect(isAutonomyLevel(lvl)).toBe(true);
  });

  it('isAutonomyLevel rejects everything else (property)', () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        if (typeof x === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(x)) return;
        expect(isAutonomyLevel(x)).toBe(false);
      })
    );
  });

  it('parseAutonomyLevel falls back to "auto" on garbage', () => {
    expect(parseAutonomyLevel('')).toBe('auto');
    expect(parseAutonomyLevel(null)).toBe('auto');
    expect(parseAutonomyLevel(undefined)).toBe('auto');
    expect(parseAutonomyLevel(123)).toBe('auto');
    expect(parseAutonomyLevel('AUTO')).toBe('auto'); // case-sensitive — "AUTO" ≠ "auto"
    expect(parseAutonomyLevel('full')).toBe('auto');
  });

  it('parseAutonomyLevel round-trips every declared level (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...AUTONOMY_LEVELS), (lvl) => {
        expect(parseAutonomyLevel(lvl)).toBe(lvl);
      })
    );
  });

  it('label + description tables cover every level (no drift)', () => {
    for (const lvl of AUTONOMY_LEVELS) {
      expect(AUTONOMY_LABEL[lvl]).toBeTruthy();
      expect(AUTONOMY_DESCRIPTION[lvl]).toBeTruthy();
      expect(AUTONOMY_DESCRIPTION[lvl].length).toBeGreaterThan(20);
    }
    // And no extras — Object.keys matches the ladder exactly.
    expect(Object.keys(AUTONOMY_LABEL).sort()).toEqual([...AUTONOMY_LEVELS].sort());
    expect(Object.keys(AUTONOMY_DESCRIPTION).sort()).toEqual([...AUTONOMY_LEVELS].sort());
  });
});
