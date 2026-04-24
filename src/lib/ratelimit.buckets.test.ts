// Meta-test: every checkLimit() call site in the app must pass a bucket name
// that is declared in the Bucket union (and therefore has a limit/window in
// LIMITS). A typo would compile — 'agents.run' vs 'agent.run' — but silently
// fall through to runtime; this test catches it.
//
// Implementation: walk src/, grep for `checkLimit(`, extract the 2nd argument,
// assert it's in the allowed set. Keeps the meta-test a single static scan —
// no route imports / no Next runtime needed.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Keep in sync with the Bucket union in src/lib/ratelimit.ts. A missed update
// here breaks this test, which is the whole point — it forces reviewers to
// notice new buckets land at call sites AND in LIMITS.
const DECLARED_BUCKETS = new Set([
  'agents.run',
  'analyzer',
  'strategy.wizard',
  'candidates.wizard',
  'burry.hypothesis',
  'burry.chat',
  'meetings.comic',
  'auth',
  'default',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('checkLimit bucket enumeration (meta)', () => {
  const srcRoot = path.resolve(__dirname, '..');
  const files = walk(srcRoot);

  it('scans a non-empty set of source files (sanity)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('DECLARED_BUCKETS matches the runtime Bucket type at the value level', async () => {
    // Import the module and assert every declared bucket above is a valid
    // key into LIMITS (via a round-trip call). If someone removes a bucket
    // from ratelimit.ts but forgets to update this test's whitelist, a
    // stale entry here stays "declared" — this guard catches that.
    const { checkLimit } = await import('./ratelimit');
    for (const b of DECLARED_BUCKETS) {
      const r = await checkLimit(`meta-${b}-${Math.random()}`, b as Parameters<typeof checkLimit>[1]);
      // If the bucket wasn't in LIMITS, checkLimit would throw when reading spec.
      expect(typeof r.success).toBe('boolean');
    }
  });

  it('every checkLimit() call in the app passes a bucket from the declared set', () => {
    const callPattern = /checkLimit\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]\s*\)/g;
    const offenders: { file: string; bucket: string }[] = [];
    for (const file of files) {
      if (file.endsWith(path.sep + 'ratelimit.ts')) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(callPattern)) {
        const bucket = m[1];
        if (!DECLARED_BUCKETS.has(bucket)) {
          offenders.push({ file: path.relative(srcRoot, file), bucket });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every checkLimit() call uses a string literal, not a variable', () => {
    // Variables would pass the literal-match regex above by default (no
    // match) and silently opt out of the bucket check. Guard against that
    // by asserting the second argument, when present, is a quoted string.
    // Tolerates calls with a single argument (default bucket).
    const anyCall = /checkLimit\s*\(([^)]*)\)/g;
    const violations: { file: string; snippet: string }[] = [];
    for (const file of files) {
      if (file.endsWith(path.sep + 'ratelimit.ts')) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(anyCall)) {
        const args = m[1].trim();
        if (!args) continue;
        const parts = args.split(',').map((s) => s.trim());
        if (parts.length < 2) continue; // single-arg form → 'default' bucket
        const second = parts[1];
        // Accept only a single-quoted or double-quoted string literal.
        if (!/^(['"])[a-z.]+\1$/i.test(second)) {
          violations.push({ file: path.relative(srcRoot, file), snippet: m[0] });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
