import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Force the in-memory path: clear Upstash creds BEFORE importing the module.
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { checkLimit, rateLimited, __resetMemStoreForTests } = await import('./ratelimit');

afterEach(() => {
  __resetMemStoreForTests();
});

afterEach(() => {
  if (originalUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = originalUrl;
  if (originalToken !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
});

describe('checkLimit (in-memory fallback)', () => {
  it('succeeds up to the bucket limit, then fails', async () => {
    // auth bucket: 5/min. Using a unique identifier so prior tests don't bleed in.
    const id = `test-auth-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      const r = await checkLimit(id, 'auth');
      expect(r.success).toBe(true);
    }
    const blocked = await checkLimit(id, 'auth');
    expect(blocked.success).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('exposes limit / remaining / reset fields', async () => {
    const r = await checkLimit(`ident-${Math.random()}`, 'analyzer');
    expect(r).toMatchObject({
      limit: 60,
      success: true,
    });
    expect(typeof r.remaining).toBe('number');
    expect(typeof r.reset).toBe('number');
    expect(r.reset).toBeGreaterThan(Date.now());
  });

  it('isolates buckets per identifier', async () => {
    const a = `user-a-${Math.random()}`;
    const b = `user-b-${Math.random()}`;
    // Exhaust user A on auth (5/min).
    for (let i = 0; i < 5; i++) await checkLimit(a, 'auth');
    const aBlocked = await checkLimit(a, 'auth');
    expect(aBlocked.success).toBe(false);
    // User B still has full budget.
    const bOk = await checkLimit(b, 'auth');
    expect(bOk.success).toBe(true);
    expect(bOk.remaining).toBe(4);
  });

  it('allows traffic again once the window has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const id = `window-${Math.random()}`;
      // auth bucket: 5/min.
      for (let i = 0; i < 5; i++) await checkLimit(id, 'auth');
      expect((await checkLimit(id, 'auth')).success).toBe(false);
      // Advance past 1 minute.
      await vi.advanceTimersByTimeAsync(61_000);
      const again = await checkLimit(id, 'auth');
      expect(again.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rateLimited response shape', () => {
  it('returns a 429 with Retry-After + X-RateLimit headers', async () => {
    const res = rateLimited({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 30_000,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeDefined();
    expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    const body = await res.json();
    expect(body.error).toBe('rate_limited');
    expect(typeof body.retryAfter).toBe('number');
  });
});
