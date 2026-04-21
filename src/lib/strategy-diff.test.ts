import { describe, it, expect } from 'vitest';
import { diffRules, formatRuleValue } from './strategy-diff';

describe('diffRules', () => {
  it('returns rows sorted by key', () => {
    const rows = diffRules({ b: 1, a: 2, c: 3 }, { a: 2, b: 1, c: 3 });
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('marks rows unchanged when values are strictly equal', () => {
    const rows = diffRules({ x: 1, y: 'foo' }, { x: 1, y: 'foo' });
    expect(rows.every((r) => !r.changed)).toBe(true);
  });

  it('marks rows changed when values differ', () => {
    const rows = diffRules({ x: 1 }, { x: 2 });
    expect(rows[0].changed).toBe(true);
  });

  it('treats deep-equal nested values as unchanged', () => {
    const rows = diffRules(
      { arr: [1, 2, 3], obj: { a: 1 } },
      { arr: [1, 2, 3], obj: { a: 1 } }
    );
    expect(rows.every((r) => !r.changed)).toBe(true);
  });

  it('marks keys present in only one side as changed', () => {
    const rows = diffRules({ a: 1 }, { b: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.key === 'a')?.changed).toBe(true);
    expect(rows.find((r) => r.key === 'b')?.changed).toBe(true);
  });

  it('accepts null/undefined rule blobs', () => {
    expect(diffRules(null, null)).toEqual([]);
    expect(diffRules(undefined, { x: 1 })).toHaveLength(1);
    expect(diffRules({ x: 1 }, undefined)).toHaveLength(1);
  });

  it('does not confuse null with missing', () => {
    const rows = diffRules({ x: null }, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].changed).toBe(true);
  });
});

describe('formatRuleValue', () => {
  it('formats primitives and objects', () => {
    expect(formatRuleValue(42)).toBe('42');
    expect(formatRuleValue('hi')).toBe('hi');
    expect(formatRuleValue(true)).toBe('true');
    expect(formatRuleValue(null)).toBe('null');
    expect(formatRuleValue(undefined)).toBe('—');
    expect(formatRuleValue({ a: 1 })).toBe('{"a":1}');
    expect(formatRuleValue([1, 2])).toBe('[1,2]');
  });
});
