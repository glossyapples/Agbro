import { describe, it, expect } from 'vitest';
import {
  BRAIN_CATEGORIES,
  BRAIN_CONFIDENCES,
  BRAIN_KIND_TAXONOMY,
  BRAIN_KIND_VALUES,
  DEFAULT_AGENT_TAXONOMY,
  CATEGORY_LABEL,
  CATEGORY_DESCRIPTION,
  CONFIDENCE_LABEL,
  CONFIDENCE_DESCRIPTION,
  buildBrainTaxonomyForPrompt,
} from './taxonomy';

// Taxonomy is the single source of truth for valid brain entry shapes.
// Drift between the kind-taxonomy map and the derived values array is
// exactly the class of bug that motivated BRAIN_KIND_VALUES in the
// first place (pre-fix, three separate enum declarations drifted).

describe('BRAIN_CATEGORIES', () => {
  it('covers exactly the six documented categories', () => {
    expect(new Set(BRAIN_CATEGORIES)).toEqual(
      new Set(['principle', 'playbook', 'reference', 'memory', 'hypothesis', 'note'])
    );
  });

  it('has a label + description for every category', () => {
    for (const c of BRAIN_CATEGORIES) {
      expect(CATEGORY_LABEL[c]).toBeTypeOf('string');
      expect(CATEGORY_LABEL[c].length).toBeGreaterThan(0);
      expect(CATEGORY_DESCRIPTION[c]).toBeTypeOf('string');
      expect(CATEGORY_DESCRIPTION[c].length).toBeGreaterThan(10);
    }
  });
});

describe('BRAIN_CONFIDENCES', () => {
  it('covers exactly the four rungs canonical > high > medium > low', () => {
    expect(BRAIN_CONFIDENCES).toEqual(['canonical', 'high', 'medium', 'low']);
  });

  it('has a label + description for every confidence', () => {
    for (const c of BRAIN_CONFIDENCES) {
      expect(CONFIDENCE_LABEL[c]).toBeTypeOf('string');
      expect(CONFIDENCE_LABEL[c].length).toBeGreaterThan(0);
      expect(CONFIDENCE_DESCRIPTION[c]).toBeTypeOf('string');
      expect(CONFIDENCE_DESCRIPTION[c].length).toBeGreaterThan(10);
    }
  });
});

describe('BRAIN_KIND_TAXONOMY', () => {
  it('maps every kind to a valid category', () => {
    for (const [kind, { category }] of Object.entries(BRAIN_KIND_TAXONOMY)) {
      expect(BRAIN_CATEGORIES).toContain(category);
      // Sanity on kind shape — lowercase snake case in practice.
      expect(kind).toMatch(/^[a-z_]+$/);
    }
  });

  it('maps every kind to a valid confidence', () => {
    for (const { confidence } of Object.values(BRAIN_KIND_TAXONOMY)) {
      expect(BRAIN_CONFIDENCES).toContain(confidence);
    }
  });

  it('covers all the kinds we ship + seed, with the expected mapping', () => {
    // Canonical mappings the seed library + code rely on. If these
    // ever change, the sync + backfill paths break in subtle ways —
    // so any change must be deliberate.
    expect(BRAIN_KIND_TAXONOMY.principle).toEqual({
      category: 'principle',
      confidence: 'canonical',
    });
    expect(BRAIN_KIND_TAXONOMY.checklist).toEqual({
      category: 'playbook',
      confidence: 'high',
    });
    expect(BRAIN_KIND_TAXONOMY.pitfall).toEqual({
      category: 'playbook',
      confidence: 'high',
    });
    expect(BRAIN_KIND_TAXONOMY.crisis_playbook).toEqual({
      category: 'playbook',
      confidence: 'high',
    });
    expect(BRAIN_KIND_TAXONOMY.sector_primer).toEqual({
      category: 'reference',
      confidence: 'high',
    });
    expect(BRAIN_KIND_TAXONOMY.case_study).toEqual({
      category: 'reference',
      confidence: 'high',
    });
    expect(BRAIN_KIND_TAXONOMY.agent_run_summary).toEqual({
      category: 'memory',
      confidence: 'medium',
    });
    expect(BRAIN_KIND_TAXONOMY.research_note).toEqual({
      category: 'memory',
      confidence: 'medium',
    });
    expect(BRAIN_KIND_TAXONOMY.hypothesis).toEqual({
      category: 'hypothesis',
      confidence: 'low',
    });
    expect(BRAIN_KIND_TAXONOMY.note).toEqual({
      category: 'note',
      confidence: 'medium',
    });
  });
});

describe('BRAIN_KIND_VALUES', () => {
  it('is derived from the taxonomy map keys (single source of truth)', () => {
    expect([...BRAIN_KIND_VALUES].sort()).toEqual(
      Object.keys(BRAIN_KIND_TAXONOMY).sort()
    );
  });

  it('has no duplicates', () => {
    expect(new Set(BRAIN_KIND_VALUES).size).toBe(BRAIN_KIND_VALUES.length);
  });

  it('is non-empty (satisfies the z.enum([first, ...rest]) contract)', () => {
    expect(BRAIN_KIND_VALUES.length).toBeGreaterThan(0);
  });
});

describe('DEFAULT_AGENT_TAXONOMY', () => {
  it('defaults to memory/medium — never principle or canonical', () => {
    expect(DEFAULT_AGENT_TAXONOMY.category).toBe('memory');
    expect(DEFAULT_AGENT_TAXONOMY.confidence).toBe('medium');
    // Agents must never self-promote to firm doctrine.
    expect(DEFAULT_AGENT_TAXONOMY.category).not.toBe('principle');
    expect(DEFAULT_AGENT_TAXONOMY.confidence).not.toBe('canonical' as never);
  });
});

describe('buildBrainTaxonomyForPrompt', () => {
  it('includes every category name', () => {
    const prompt = buildBrainTaxonomyForPrompt();
    for (const c of BRAIN_CATEGORIES) {
      expect(prompt).toContain(c);
    }
  });

  it('includes every confidence rung', () => {
    const prompt = buildBrainTaxonomyForPrompt();
    for (const c of BRAIN_CONFIDENCES) {
      expect(prompt).toContain(c);
    }
  });

  it('mentions supersession (the invisible-correction pattern)', () => {
    const prompt = buildBrainTaxonomyForPrompt();
    expect(prompt.toLowerCase()).toContain('supersed');
  });

  it('forbids agents from claiming canonical confidence', () => {
    // The prompt should explicitly guard against agents promoting
    // their own writes to canonical — this is a capital-preservation
    // concern (a hallucinated "firm principle" would propagate).
    const prompt = buildBrainTaxonomyForPrompt();
    expect(prompt.toLowerCase()).toMatch(/never.*canonical|canonical.*reserved/);
  });
});
