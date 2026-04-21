import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// api.ts transitively imports auth.ts → next-auth → next/server. The functions
// under test (apiError, assertCronSecret, timingSafeEqual) don't use any of
// that, so stub the auth module out to keep the test environment cheap.
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  maybeCurrentUser: vi.fn(),
  requirePageUser: vi.fn(),
}));

const { apiError, assertCronSecret, timingSafeEqual } = await import('./api');

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different strings of equal length', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
  });

  it('returns false for different lengths (without throwing)', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('abcd', 'abc')).toBe(false);
  });

  it('returns false when either side is empty / undefined', () => {
    expect(timingSafeEqual('', 'abc')).toBe(false);
    expect(timingSafeEqual('abc', '')).toBe(false);
    expect(timingSafeEqual(undefined, 'abc')).toBe(false);
    expect(timingSafeEqual('abc', undefined)).toBe(false);
    expect(timingSafeEqual(undefined, undefined)).toBe(false);
  });
});

describe('apiError', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('returns a generic message body and does not leak the original error text', async () => {
    const boom = new Error('DB password leaked: secret123');
    const res = apiError(boom, 500, 'internal server error', 'test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal server error');
    expect(JSON.stringify(body)).not.toContain('secret123');
  });

  it('logs the original error server-side with the context tag as the event name', () => {
    apiError(new Error('upstream timeout'), 500, 'failed', 'cron.weekly');
    expect(errSpy).toHaveBeenCalled();
    const joined = errSpy.mock.calls.flat().map(String).join(' ');
    // Logger emits `event: "cron.weekly"` (JSON) or pretty-printed line
    // containing the event name — either way, the tag is present.
    expect(joined).toContain('cron.weekly');
    expect(joined).toContain('upstream timeout');
  });

  it('honors the provided status code', async () => {
    const res = apiError(new Error('x'), 400, 'bad', 'test');
    expect(res.status).toBe(400);
  });
});

describe('assertCronSecret', () => {
  const originalSecret = process.env.AGBRO_CRON_SECRET;
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.AGBRO_CRON_SECRET;
    else process.env.AGBRO_CRON_SECRET = originalSecret;
  });

  function req(headers: Record<string, string>) {
    return new Request('http://localhost/api/cron/tick', { headers });
  }

  it('returns 401 when AGBRO_CRON_SECRET is unset', async () => {
    delete process.env.AGBRO_CRON_SECRET;
    const res = assertCronSecret(req({ 'x-agbro-cron-secret': 'anything' }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it('returns 401 when the header is missing', async () => {
    process.env.AGBRO_CRON_SECRET = 'correct-horse';
    const res = assertCronSecret(req({}));
    expect(res!.status).toBe(401);
  });

  it('returns 401 when the header does not match', async () => {
    process.env.AGBRO_CRON_SECRET = 'correct-horse';
    const res = assertCronSecret(req({ 'x-agbro-cron-secret': 'wrong-horse' }));
    expect(res!.status).toBe(401);
  });

  it('returns null (success) when the header matches', () => {
    process.env.AGBRO_CRON_SECRET = 'correct-horse';
    const res = assertCronSecret(req({ 'x-agbro-cron-secret': 'correct-horse' }));
    expect(res).toBeNull();
  });
});
