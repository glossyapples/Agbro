import { describe, it, expect } from 'vitest';
import {
  STARTER_BRAIN,
  STARTER_STRATEGIES,
  STARTER_BRAIN_SUMMARY,
  STARTER_BRAIN_VERSION,
  STARTER_BRAIN_MARKER_SLUG,
} from './index';
import { BRAIN_KIND_TAXONOMY } from '../taxonomy';

// Seed-library integrity tests. Every regression here would either
// produce duplicate DB rows on sync, break the marker check that
// gates /brain's "Load starter brain" button, or produce brain entries
// the UI can't label.

describe('STARTER_BRAIN integrity', () => {
  it('has at least one entry per seeded kind', () => {
    const kinds = new Set(STARTER_BRAIN.map((e) => e.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(5);
  });

  it('every entry has a non-empty slug, title, body, tags array', () => {
    for (const e of STARTER_BRAIN) {
      expect(e.slug.length).toBeGreaterThan(0);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.body.length).toBeGreaterThan(0);
      expect(Array.isArray(e.tags)).toBe(true);
    }
  });

  it('has no duplicate (kind, slug) pairs — would cause upsert collisions', () => {
    const seen = new Map<string, string>();
    for (const e of STARTER_BRAIN) {
      const key = `${e.kind}::${e.slug}`;
      if (seen.has(key)) {
        throw new Error(
          `duplicate kind+slug: ${e.kind} / ${e.slug} (titles: "${seen.get(key)}" vs "${e.title}")`
        );
      }
      seen.set(key, e.title);
    }
  });

  it('every kind is known to the taxonomy (no orphan kinds)', () => {
    for (const e of STARTER_BRAIN) {
      expect(BRAIN_KIND_TAXONOMY[e.kind]).toBeDefined();
    }
  });

  it('slugs are URL-safe (lowercase alphanumeric + hyphens)', () => {
    for (const e of STARTER_BRAIN) {
      expect(e.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('bodies are non-trivial (at least 40 chars — filters out placeholder stubs)', () => {
    for (const e of STARTER_BRAIN) {
      expect(e.body.length).toBeGreaterThan(40);
    }
  });

  it('contains the MARKER slug — seedBrainForUser.isBrainSeeded depends on it', () => {
    // isBrainSeeded checks for this exact (kind='principle', slug=MARKER).
    // Renaming the entry without updating STARTER_BRAIN_MARKER_SLUG
    // would silently make every existing user appear "not seeded".
    const marker = STARTER_BRAIN.find(
      (e) => e.kind === 'principle' && e.slug === STARTER_BRAIN_MARKER_SLUG
    );
    expect(marker).toBeDefined();
  });

  it('override category (when set) is valid', () => {
    for (const e of STARTER_BRAIN) {
      if (e.category != null) {
        expect([
          'principle',
          'playbook',
          'reference',
          'memory',
          'hypothesis',
          'note',
        ]).toContain(e.category);
      }
    }
  });

  it('override confidence (when set) is valid', () => {
    for (const e of STARTER_BRAIN) {
      if (e.confidence != null) {
        expect(['canonical', 'high', 'medium', 'low']).toContain(e.confidence);
      }
    }
  });

  it('at least a few entries tagged "burry" exist (Burrybot seeded doctrine)', () => {
    const burry = STARTER_BRAIN.filter((e) => e.tags.includes('burry'));
    expect(burry.length).toBeGreaterThan(0);
  });
});

describe('STARTER_STRATEGIES integrity', () => {
  it('has at least the 5 canonical alt presets', () => {
    expect(STARTER_STRATEGIES.length).toBeGreaterThanOrEqual(5);
  });

  it('every strategy has a stable presetKey', () => {
    for (const s of STARTER_STRATEGIES) {
      expect(s.presetKey).toBeTypeOf('string');
      expect(s.presetKey.length).toBeGreaterThan(0);
    }
  });

  it('presetKeys are unique — downstream uses them as stable identifiers', () => {
    const keys = STARTER_STRATEGIES.map((s) => s.presetKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('slugs are unique — seed-brain uses them to build deterministic row ids', () => {
    const slugs = STARTER_STRATEGIES.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every strategy has a non-empty name + summary + rules', () => {
    for (const s of STARTER_STRATEGIES) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.summary.length).toBeGreaterThan(20);
      expect(typeof s.rules).toBe('object');
      expect(Object.keys(s.rules).length).toBeGreaterThan(0);
    }
  });

  it('buffettScore is 0..100', () => {
    for (const s of STARTER_STRATEGIES) {
      expect(s.buffettScore).toBeGreaterThanOrEqual(0);
      expect(s.buffettScore).toBeLessThanOrEqual(100);
    }
  });
});

describe('STARTER_BRAIN_SUMMARY', () => {
  it('total equals the sum of individual category counts in STARTER_BRAIN', () => {
    expect(STARTER_BRAIN_SUMMARY.total).toBe(STARTER_BRAIN.length);
  });

  it('version follows semver', () => {
    expect(STARTER_BRAIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(STARTER_BRAIN_SUMMARY.version).toBe(STARTER_BRAIN_VERSION);
  });

  it('individual category counts are non-negative integers', () => {
    const { principles, checklists, pitfalls, sector_primers, case_studies, crisis_playbooks, alternative_strategies } =
      STARTER_BRAIN_SUMMARY;
    for (const n of [principles, checklists, pitfalls, sector_primers, case_studies, alternative_strategies]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    // crisis_playbooks is optional in the Summary shape but always populated today
    expect(Number.isInteger(crisis_playbooks)).toBe(true);
  });

  it('alternative_strategies count matches STARTER_STRATEGIES.length', () => {
    expect(STARTER_BRAIN_SUMMARY.alternative_strategies).toBe(STARTER_STRATEGIES.length);
  });
});
