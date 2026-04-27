// Tests for the pure parts of brain blurb generation. The Haiku
// network call is exercised live by viewing the home page on a real
// brain entry — much cheaper validation than mocking the SDK at this
// stage.

import { describe, it, expect } from 'vitest';
import { bodyExcerpt } from './blurb';

describe('bodyExcerpt', () => {
  it('returns the body unchanged when shorter than the cap', () => {
    expect(bodyExcerpt('Sold UEC.')).toBe('Sold UEC.');
  });

  it('breaks at the last full sentence within the cap when there is one', () => {
    const long =
      'Sold UEC because it failed Quality Compounders. The thesis was wrong from day one. ' +
      'We should have caught the leverage problem earlier.';
    const out = bodyExcerpt(long, 80);
    expect(out.endsWith('.')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).toMatch(/Sold UEC/);
  });

  it('falls back to character cap + ellipsis when there is no clean sentence break', () => {
    // No periods in the first half — has to truncate mid-thought.
    const dense = 'A'.repeat(200);
    const out = bodyExcerpt(dense, 100);
    expect(out.length).toBeLessThanOrEqual(101); // 100 + ellipsis
    expect(out.endsWith('…')).toBe(true);
  });

  it('trims leading/trailing whitespace before measuring', () => {
    expect(bodyExcerpt('   short  ')).toBe('short');
  });

  it('handles empty / whitespace-only input', () => {
    expect(bodyExcerpt('')).toBe('');
    expect(bodyExcerpt('   ')).toBe('');
  });

  it('does NOT break at a period that is too early (avoids "S." kind of truncations)', () => {
    // First period is at position 1. We require the break to be past
    // half the cap, otherwise we just cap + ellipsize.
    const tricky = 'A. ' + 'X'.repeat(200);
    const out = bodyExcerpt(tricky, 100);
    // Should NOT be just "A." — that would be a useless excerpt.
    expect(out).not.toBe('A.');
    expect(out.length).toBeGreaterThan(50);
  });
});
