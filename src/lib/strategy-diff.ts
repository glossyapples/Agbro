// Side-by-side diff of two Strategy.rules blobs.
// Strategy.rules is a free-form Json column; we just flatten to top-level
// key/value pairs and sort keys so the UI can render a predictable table.

export type DiffRow = {
  key: string;
  a: unknown;
  b: unknown;
  changed: boolean;
};

function pretty(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Deep-equality good enough for rule diffs (JSON round-trip).
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function diffRules(
  rulesA: Record<string, unknown> | null | undefined,
  rulesB: Record<string, unknown> | null | undefined
): DiffRow[] {
  const a = rulesA ?? {};
  const b = rulesB ?? {};
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  return keys.map((key) => {
    const av = (a as Record<string, unknown>)[key];
    const bv = (b as Record<string, unknown>)[key];
    return {
      key,
      a: av,
      b: bv,
      changed: !equal(av, bv),
    };
  });
}

export function formatRuleValue(v: unknown): string {
  return pretty(v);
}
