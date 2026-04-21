// Aggregator for the starter brain library. Everything that ships with the
// app on Day 0 is exported from here. Add a new category file, import it,
// and include it in STARTER_BRAIN; the seeder picks it up automatically.

import { PRINCIPLES } from './principles';
import { CHECKLISTS } from './checklists';
import { PITFALLS } from './pitfalls';
import { SECTOR_PRIMERS } from './sector-primers';
import { CASE_STUDIES } from './case-studies';
import { ALTERNATIVE_STRATEGIES } from './alternative-strategies';
import type { BrainSeed, StrategySeed } from './types';

export const STARTER_BRAIN: BrainSeed[] = [
  ...PRINCIPLES,
  ...CHECKLISTS,
  ...PITFALLS,
  ...SECTOR_PRIMERS,
  ...CASE_STUDIES,
];

export const STARTER_STRATEGIES: StrategySeed[] = ALTERNATIVE_STRATEGIES;

// Small summary — used for the in-app button and cron logs.
export const STARTER_BRAIN_SUMMARY = {
  principles: PRINCIPLES.length,
  checklists: CHECKLISTS.length,
  pitfalls: PITFALLS.length,
  sector_primers: SECTOR_PRIMERS.length,
  case_studies: CASE_STUDIES.length,
  total: STARTER_BRAIN.length,
  alternative_strategies: STARTER_STRATEGIES.length,
};

// Canonical marker entry: presence signals the seed has run for this user.
// Check this exact slug to decide whether to offer the "Load starter brain"
// button on /brain.
export const STARTER_BRAIN_MARKER_SLUG = 'buffett-rule-1-never-lose-money';

export type { BrainSeed, StrategySeed } from './types';
