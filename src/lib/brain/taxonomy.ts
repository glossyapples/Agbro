// Single source of truth for the brain's organising axes. Consumed by:
//   • starter library (emits category + confidence on seed entries)
//   • read_brain + write_brain tools (validate + filter)
//   • agent prompt (explains the mental model to Claude)
//   • /brain UI (pill labels + colours)
//
// Two axes:
//   category   — WHAT KIND of knowledge this is (stable, enumerated)
//   confidence — HOW MUCH WEIGHT to give it (ladder: canonical ≫ high ≫ medium ≫ low)
//
// Every kind-string the code has historically used maps to exactly one
// (category, confidence) pair via BRAIN_KIND_TAXONOMY. This gives us a
// clean backfill for existing rows and keeps the agent's write tool
// honest.

import type { BrainCategory, BrainConfidence } from '@prisma/client';

export const BRAIN_CATEGORIES: BrainCategory[] = [
  'principle',
  'playbook',
  'reference',
  'memory',
  'hypothesis',
  'note',
];

export const BRAIN_CONFIDENCES: BrainConfidence[] = [
  'canonical',
  'high',
  'medium',
  'low',
];

export const CATEGORY_LABEL: Record<BrainCategory, string> = {
  principle: 'Principle',
  playbook: 'Playbook',
  reference: 'Reference',
  memory: 'Memory',
  hypothesis: 'Hypothesis',
  note: 'Note',
};

export const CATEGORY_DESCRIPTION: Record<BrainCategory, string> = {
  principle:
    'Immutable doctrine — Buffett rules, firm charter. Never overruled by a single observation.',
  playbook:
    'Reusable procedures — pre-trade checklist, crisis response, biases to resist. How we act.',
  reference:
    'Background domain knowledge — sector primers, historical case studies, company dossiers.',
  memory:
    'Our lived experience — agent run summaries, post-mortems, weekly updates, lessons learned.',
  hypothesis:
    'Active bets on unknown truths — a theory under test. Upgrade or retire once proven.',
  note: 'User-written freeform notes.',
};

export const CONFIDENCE_LABEL: Record<BrainConfidence, string> = {
  canonical: 'Canonical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export const CONFIDENCE_DESCRIPTION: Record<BrainConfidence, string> = {
  canonical:
    'Axiomatic. Never overruled by a single observation. Reserved for the firm charter + Buffett/Graham/Munger rules.',
  high: 'Well-established and battle-tested. Survived multiple market regimes.',
  medium:
    'Working theory or recent observation. The default for agent-written entries.',
  low: 'Hunch, unverified. A signal to investigate further, not to act on.',
};

// Every legacy `kind` string maps to exactly one (category, confidence)
// pair. Used at seed time, during backfill, and defensively inside the
// write_brain tool if an agent emits a legacy kind without the new
// fields.
export const BRAIN_KIND_TAXONOMY: Record<
  string,
  { category: BrainCategory; confidence: BrainConfidence }
> = {
  principle: { category: 'principle', confidence: 'canonical' },
  checklist: { category: 'playbook', confidence: 'high' },
  pitfall: { category: 'playbook', confidence: 'high' },
  crisis_playbook: { category: 'playbook', confidence: 'high' },
  sector_primer: { category: 'reference', confidence: 'high' },
  case_study: { category: 'reference', confidence: 'high' },
  weekly_update: { category: 'memory', confidence: 'medium' },
  agent_run_summary: { category: 'memory', confidence: 'medium' },
  post_mortem: { category: 'memory', confidence: 'medium' },
  lesson: { category: 'memory', confidence: 'medium' },
  market_memo: { category: 'memory', confidence: 'medium' },
  research_note: { category: 'memory', confidence: 'medium' },
  hypothesis: { category: 'hypothesis', confidence: 'low' },
  note: { category: 'note', confidence: 'medium' },
};

// What category + confidence to assign to an agent-written entry whose
// kind the agent didn't specify. Defensive fallback only — the agent
// should set these explicitly via write_brain.
export const DEFAULT_AGENT_TAXONOMY = {
  category: 'memory' as BrainCategory,
  confidence: 'medium' as BrainConfidence,
};

// Compact prose the agent prompt can embed verbatim so Claude has the
// mental model available when calling read_brain / write_brain.
export function buildBrainTaxonomyForPrompt(): string {
  const catLines = BRAIN_CATEGORIES.map(
    (c) => `  • ${c} — ${CATEGORY_DESCRIPTION[c]}`
  ).join('\n');
  const confLines = BRAIN_CONFIDENCES.map(
    (c) => `  • ${c} — ${CONFIDENCE_DESCRIPTION[c]}`
  ).join('\n');
  return `Brain taxonomy (two axes, always both):

Category — what kind of knowledge:
${catLines}

Confidence — how much weight:
${confLines}

Supersession: when a lesson turns out wrong or outdated, write a NEW entry with the corrected insight and set supersedesId to the old entry's id. The old entry stays for audit but won't be pulled by default reads.

Agent write defaults: category=memory, confidence=medium. Only claim confidence=high if the lesson survived multiple decisions. Never emit confidence=canonical yourself — canonical is reserved for seeded firm doctrine.`;
}
