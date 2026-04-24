// Aggregator for the starter brain library. Everything that ships with the
// app on Day 0 is exported from here. Add a new category file, import it,
// and include it in STARTER_BRAIN; the seeder picks it up automatically.

import { PRINCIPLES } from './principles';
import { CHECKLISTS } from './checklists';
import { PITFALLS } from './pitfalls';
import { SECTOR_PRIMERS } from './sector-primers';
import { CASE_STUDIES } from './case-studies';
import { CRISIS_PLAYBOOKS } from './crisis-playbooks';
import { ALTERNATIVE_STRATEGIES } from './alternative-strategies';
import type { BrainSeed, StrategySeed } from './types';

// Bump this whenever the starter library's CONTENT changes (new entries
// added, existing entries edited). The /brain page compares this against
// the most recent seed entry's updatedAt to show users whether they're
// running the latest library. Bump = a meaningful content change worth
// a user re-sync. Don't bump for typos.
//
// History:
//   1.0.0 — initial public brain (principles, checklists, pitfalls,
//            sector primers, case studies, alternative strategies)
//   1.1.0 — added 5 crisis playbooks (1987, 2000, 2008, 2020, 2022)
//   1.2.0 — Burrybot onboarded as the firm's deep-research voice:
//            new strategy (Burry Deep Research), 4 Burry principles,
//            1 Burry checklist (10-K walkthrough), 1 Burry case study
//            (The Big Short). Users on older versions pick these up
//            via the "↻ Sync" button on /brain.
export const STARTER_BRAIN_VERSION = '1.2.0';

export const STARTER_BRAIN: BrainSeed[] = [
  ...PRINCIPLES,
  ...CHECKLISTS,
  ...PITFALLS,
  ...SECTOR_PRIMERS,
  ...CASE_STUDIES,
  ...CRISIS_PLAYBOOKS,
];

export const STARTER_STRATEGIES: StrategySeed[] = ALTERNATIVE_STRATEGIES;

// Small summary — used for the in-app button and cron logs.
export const STARTER_BRAIN_SUMMARY = {
  principles: PRINCIPLES.length,
  checklists: CHECKLISTS.length,
  pitfalls: PITFALLS.length,
  sector_primers: SECTOR_PRIMERS.length,
  case_studies: CASE_STUDIES.length,
  crisis_playbooks: CRISIS_PLAYBOOKS.length,
  total: STARTER_BRAIN.length,
  alternative_strategies: STARTER_STRATEGIES.length,
  version: STARTER_BRAIN_VERSION,
};

// Canonical marker entry: presence signals the seed has run for this user.
// Check this exact slug to decide whether to offer the "Load starter brain"
// button on /brain.
export const STARTER_BRAIN_MARKER_SLUG = 'buffett-rule-1-never-lose-money';

export type { BrainSeed, StrategySeed } from './types';
