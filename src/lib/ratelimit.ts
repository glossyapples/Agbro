// Token-bucket rate limiting. Uses Upstash Redis when UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN are set; falls back to a per-process in-memory
// counter in dev. The in-memory fallback is NOT safe for multi-instance
// deployments — set Upstash creds in prod.
//
// Usage:
//   const gate = await checkLimit(user.id, 'agents.run');
//   if (!gate.success) return rateLimited(gate);

import { NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

type Duration = `${number} ${'s' | 'm' | 'h'}`;

export type Bucket = 'agents.run' | 'analyzer' | 'strategy.wizard' | 'auth' | 'default';

const LIMITS: Record<Bucket, { limit: number; window: Duration }> = {
  'agents.run': { limit: 10, window: '1 h' },
  analyzer: { limit: 60, window: '1 m' },
  'strategy.wizard': { limit: 20, window: '1 m' },
  auth: { limit: 5, window: '1 m' },
  default: { limit: 120, window: '1 m' },
};

// Shared Upstash client (null when creds missing).
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;

if (!redis && process.env.NODE_ENV === 'production') {
  // Loud warning on boot: the in-memory fallback is per-instance and can be
  // trivially bypassed by any deployment running more than one container.
  // Using console.warn directly to avoid a circular import with logger.ts.
  console.warn(
    '{"level":"warn","event":"ratelimit.fallback_in_memory",' +
      '"message":"UPSTASH_REDIS_REST_URL/TOKEN not set; multi-instance deployments can bypass limits"}'
  );
}

const limiters = new Map<Bucket, Ratelimit>();
function upstashLimiter(bucket: Bucket): Ratelimit | null {
  if (!redis) return null;
  const cached = limiters.get(bucket);
  if (cached) return cached;
  const spec = LIMITS[bucket];
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(spec.limit, spec.window),
    analytics: false,
    prefix: `agbro:rl:${bucket}`,
  });
  limiters.set(bucket, rl);
  return rl;
}

// In-memory fallback (dev / single-instance only). LRU-bounded Map to prevent
// unbounded growth from adversarial or long-running traffic: Map preserves
// insertion order, so we can evict the oldest entry when over capacity.
const MEM_MAX_ENTRIES = 10_000;
type MemEntry = { windowStartMs: number; count: number; lastTouchedMs: number };
const memStore = new Map<string, MemEntry>();

function windowMs(spec: { limit: number; window: Duration }): number {
  const [n, unit] = spec.window.split(' ');
  const mult = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  return Number(n) * mult;
}

function memCheck(
  bucket: Bucket,
  identifier: string
): { success: boolean; limit: number; remaining: number; reset: number } {
  const spec = LIMITS[bucket];
  const win = windowMs(spec);
  const now = Date.now();
  const key = `${bucket}:${identifier}`;
  const entry = memStore.get(key);
  if (!entry || now - entry.windowStartMs >= win) {
    // Evict oldest entries if we're over cap. Check before insert so we never
    // allocate past the limit.
    while (memStore.size >= MEM_MAX_ENTRIES) {
      const oldest = memStore.keys().next().value;
      if (oldest === undefined) break;
      memStore.delete(oldest);
    }
    // Re-insert in LRU position by deleting first.
    memStore.delete(key);
    memStore.set(key, { windowStartMs: now, count: 1, lastTouchedMs: now });
    return { success: true, limit: spec.limit, remaining: spec.limit - 1, reset: now + win };
  }
  entry.count += 1;
  entry.lastTouchedMs = now;
  const remaining = Math.max(0, spec.limit - entry.count);
  return {
    success: entry.count <= spec.limit,
    limit: spec.limit,
    remaining,
    reset: entry.windowStartMs + win,
  };
}

// Exposed for tests to reset state between runs.
export function __resetMemStoreForTests() {
  memStore.clear();
}

export type LimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
};

export async function checkLimit(identifier: string, bucket: Bucket = 'default'): Promise<LimitResult> {
  const rl = upstashLimiter(bucket);
  if (rl) {
    const res = await rl.limit(identifier);
    return {
      success: res.success,
      limit: res.limit,
      remaining: res.remaining,
      reset: res.reset,
    };
  }
  return memCheck(bucket, identifier);
}

export function rateLimited(result: LimitResult): NextResponse {
  const retryAfter = Math.max(0, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    { error: 'rate_limited', retryAfter },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    }
  );
}

// Get a stable identifier for the request. For authed routes, pass the user id;
// for anonymous routes, fall back to IP or a dummy.
export function ipFromRequest(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'anonymous';
}
