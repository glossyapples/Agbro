import { describe, it, expect } from 'vitest';
import { formatPct, formatUsd, fromCents, toCents } from './money';

describe('toCents', () => {
  it('rounds dollars to integer cents as BigInt', () => {
    expect(toCents(1.23)).toBe(123n);
    expect(toCents(0)).toBe(0n);
    expect(toCents(1_000_000)).toBe(100_000_000n);
  });

  it('handles floating point correctly (rounds, does not truncate)', () => {
    // 0.1 + 0.2 → 0.30000000000000004 * 100 → 30.000000000000004 → round to 30.
    expect(toCents(0.1 + 0.2)).toBe(30n);
  });

  it('rounds half-cent values', () => {
    expect(toCents(0.005)).toBe(1n); // Math.round(0.5) = 1
    expect(toCents(0.004)).toBe(0n);
  });
});

describe('fromCents', () => {
  it('converts BigInt cents back to dollars', () => {
    expect(fromCents(123n)).toBe(1.23);
    expect(fromCents(0n)).toBe(0);
  });

  it('accepts a number input', () => {
    expect(fromCents(123)).toBe(1.23);
  });
});

describe('formatUsd', () => {
  it('formats BigInt cents as US currency', () => {
    expect(formatUsd(123_456n)).toBe('$1,234.56');
  });

  it('returns em-dash for null/undefined', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(undefined)).toBe('—');
  });
});

describe('formatPct', () => {
  it('formats a number with two decimals + % by default', () => {
    expect(formatPct(12.345)).toBe('12.35%');
  });

  it('respects a custom digits arg', () => {
    expect(formatPct(12.345, 0)).toBe('12%');
  });

  it('returns em-dash for null, undefined, or NaN', () => {
    expect(formatPct(null)).toBe('—');
    expect(formatPct(undefined)).toBe('—');
    expect(formatPct(Number.NaN)).toBe('—');
  });
});
