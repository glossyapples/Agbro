// Shared shapes for the starter brain library. Each category file exports an
// array of these; the aggregator flattens them into a single list used by the
// seeder + the /api/brain/load-defaults endpoint.

import type { BrainCategory, BrainConfidence } from '@prisma/client';
import type { StrategyKey } from '@/lib/backtest/rules';

export type BrainSeed = {
  // Stable slug. Stable IDs become `${userId}-seed-brain-${kind}-${slug}`
  // so re-runs (createUser hook, in-app button, CLI) are idempotent.
  slug: string;
  kind:
    | 'principle'
    | 'checklist'
    | 'pitfall'
    | 'sector_primer'
    | 'case_study'
    | 'crisis_playbook';
  title: string;
  body: string;
  tags: string[];
  // Optional overrides. If omitted, the seeder derives them from `kind`
  // via BRAIN_KIND_TAXONOMY — every library file today relies on that
  // mapping, so overrides are only needed for one-off tuning.
  category?: BrainCategory;
  confidence?: BrainConfidence;
};

export type StrategySeed = {
  slug: string;
  // Stable identifier stamped onto Strategy.presetKey — used for cast
  // inference, backtest ruleset lookup, Burry firm detection, etc.
  // Must match the StrategyKey union so a typo surfaces at compile time.
  presetKey: StrategyKey;
  name: string;
  summary: string;
  buffettScore: number; // 0..100
  rules: Record<string, unknown>;
};
