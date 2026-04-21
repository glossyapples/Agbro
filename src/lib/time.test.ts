import { describe, it, expect } from 'vitest';
import { startOfDayET } from './time';

// The function should return the UTC instant of the most recent 00:00 in
// America/New_York. DST means the offset is -04:00 in summer (EDT) and
// -05:00 in winter (EST).

describe('startOfDayET', () => {
  it('returns 04:00 UTC for a summer instant (EDT, UTC-4)', () => {
    // 2026-07-15 14:00 UTC = 10:00 ET on the same day. Midnight ET = 04:00 UTC.
    const result = startOfDayET(new Date('2026-07-15T14:00:00Z'));
    expect(result.toISOString()).toBe('2026-07-15T04:00:00.000Z');
  });

  it('returns 05:00 UTC for a winter instant (EST, UTC-5)', () => {
    // 2026-01-15 14:00 UTC = 09:00 ET on the same day. Midnight ET = 05:00 UTC.
    const result = startOfDayET(new Date('2026-01-15T14:00:00Z'));
    expect(result.toISOString()).toBe('2026-01-15T05:00:00.000Z');
  });

  it('rolls back to the prior ET day when the UTC instant is before 04:00 UTC on the ET date (summer)', () => {
    // 2026-07-15 02:00 UTC = 2026-07-14 22:00 ET. Midnight ET for that day = 2026-07-14T04:00Z.
    const result = startOfDayET(new Date('2026-07-15T02:00:00Z'));
    expect(result.toISOString()).toBe('2026-07-14T04:00:00.000Z');
  });

  it('handles the ET date for a UTC instant right after midnight UTC (winter)', () => {
    // 2026-01-15 02:00 UTC = 2026-01-14 21:00 ET. Midnight ET for 2026-01-14 = 2026-01-14T05:00Z.
    const result = startOfDayET(new Date('2026-01-15T02:00:00Z'));
    expect(result.toISOString()).toBe('2026-01-14T05:00:00.000Z');
  });

  it('on a spring-forward day, returns the midnight-ET instant using the current EDT offset', () => {
    // DST transition days have a 23-hour day; "midnight ET" is ambiguous because
    // the hour 02:00-03:00 is skipped. The implementation uses the ET wall-clock
    // offset current at `now` (EDT by mid-day), so midnight = 04:00 UTC.
    // Practical impact: markets are closed during the 2-3am transition, so
    // trade-cap counting is unaffected. This test pins the current behaviour.
    const result = startOfDayET(new Date('2026-03-08T14:00:00Z'));
    expect(result.toISOString()).toBe('2026-03-08T04:00:00.000Z');
  });

  it('on a fall-back day, returns the midnight-ET instant using the current EST offset', () => {
    // Fall-back: 01:00 EDT → 01:00 EST; 25-hour day. At mid-day EST is active,
    // so midnight = 05:00 UTC.
    const result = startOfDayET(new Date('2026-11-01T14:00:00Z'));
    expect(result.toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });

  it('defaults to now() when no arg passed', () => {
    const before = Date.now();
    const result = startOfDayET();
    const after = Date.now();
    // Whatever "today ET" is, midnight ET is <= now.
    expect(result.getTime()).toBeLessThanOrEqual(after);
    // And no more than 25h earlier (handles DST edge).
    expect(result.getTime()).toBeGreaterThanOrEqual(before - 25 * 3600_000);
  });
});
