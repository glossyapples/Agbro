// Shared shapes for the starter brain library. Each category file exports an
// array of these; the aggregator flattens them into a single list used by the
// seeder + the /api/brain/load-defaults endpoint.

export type BrainSeed = {
  // Stable slug. Stable IDs become `${userId}-seed-brain-${kind}-${slug}`
  // so re-runs (createUser hook, in-app button, CLI) are idempotent.
  slug: string;
  kind:
    | 'principle'
    | 'checklist'
    | 'pitfall'
    | 'sector_primer'
    | 'case_study';
  title: string;
  body: string;
  tags: string[];
};

export type StrategySeed = {
  slug: string;
  name: string;
  summary: string;
  buffettScore: number; // 0..100
  rules: Record<string, unknown>;
};
