// Per-user brain seeder. Idempotent: safe to run on every sign-in, from the
// in-app "Load starter brain" button, from the CLI, from the createUser hook.
// Rows are keyed with stable IDs so repeated runs re-render the same rows
// (no duplicates, no drift) and updates to the library text propagate on
// the next run.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  STARTER_BRAIN,
  STARTER_STRATEGIES,
  STARTER_BRAIN_SUMMARY,
  STARTER_BRAIN_MARKER_SLUG,
} from './starter-library';
import { BRAIN_KIND_TAXONOMY } from './taxonomy';

function brainRowId(userId: string, kind: string, slug: string): string {
  return `${userId}-seed-brain-${kind}-${slug}`;
}

function strategyRowId(userId: string, slug: string): string {
  return `${userId}-seed-strategy-${slug}`;
}

export type SeedBrainResult = {
  userId: string;
  brainEntries: {
    inserted: number;
    updated: number;
    unchanged: number;
    total: number;
  };
  strategies: {
    inserted: number;
    updated: number;
    unchanged: number;
    total: number;
  };
  summary: typeof STARTER_BRAIN_SUMMARY;
};

// Seeds the starter brain + archived alternative strategies for a single user.
// Does NOT touch the user's active strategy — alternatives are installed with
// isActive=false so the wizard can diff against them.
export async function seedBrainForUser(userId: string): Promise<SeedBrainResult> {
  let brainInserted = 0;
  let brainUpdated = 0;
  let brainUnchanged = 0;

  for (const entry of STARTER_BRAIN) {
    const id = brainRowId(userId, entry.kind, entry.slug);
    const taxonomy = BRAIN_KIND_TAXONOMY[entry.kind] ?? {
      category: 'reference' as const,
      confidence: 'high' as const,
    };
    const category = entry.category ?? taxonomy.category;
    const confidence = entry.confidence ?? taxonomy.confidence;
    // Stable library key independent of userId — lets us recognise the
    // same canonical entry across users and library versions without
    // depending on the row id's user prefix.
    const seedKey = `${entry.kind}:${entry.slug}`;
    const existing = await prisma.brainEntry.findUnique({
      where: { id },
      select: {
        title: true,
        body: true,
        tags: true,
        category: true,
        confidence: true,
        seedKey: true,
      },
    });
    await prisma.brainEntry.upsert({
      where: { id },
      create: {
        id,
        userId,
        kind: entry.kind,
        category,
        confidence,
        seedKey,
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        relatedSymbols: [],
      },
      update: {
        // Deliberately do NOT reset userId/kind/id — just refresh content
        // + taxonomy so library improvements flow to existing users on
        // the next seed run.
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        category,
        confidence,
        seedKey,
      },
    });
    if (!existing) {
      brainInserted += 1;
    } else if (
      existing.title !== entry.title ||
      existing.body !== entry.body ||
      existing.tags.join('|') !== entry.tags.join('|') ||
      existing.category !== category ||
      existing.confidence !== confidence ||
      existing.seedKey !== seedKey
    ) {
      brainUpdated += 1;
    } else {
      brainUnchanged += 1;
    }
  }

  // Archived alternative strategies for the wizard's comparison library.
  // These are created as isActive=false; the user's currently-active strategy
  // is never modified by this function.
  let strategyInserted = 0;
  let strategyUpdated = 0;
  let strategyUnchanged = 0;

  for (const strat of STARTER_STRATEGIES) {
    const id = strategyRowId(userId, strat.slug);
    const existing = await prisma.strategy.findUnique({
      where: { id },
      select: { name: true, summary: true, rules: true, buffettScore: true },
    });
    await prisma.strategy.upsert({
      where: { id },
      create: {
        id,
        userId,
        name: strat.name,
        summary: strat.summary,
        rules: strat.rules as Prisma.InputJsonValue,
        buffettScore: strat.buffettScore,
        isActive: false,
        version: 1,
      },
      update: {
        name: strat.name,
        summary: strat.summary,
        rules: strat.rules as Prisma.InputJsonValue,
        buffettScore: strat.buffettScore,
        // Never flip isActive or version on re-seed — that's owned by the user.
      },
    });
    if (!existing) {
      strategyInserted += 1;
    } else if (
      existing.name !== strat.name ||
      existing.summary !== strat.summary ||
      existing.buffettScore !== strat.buffettScore ||
      JSON.stringify(existing.rules) !== JSON.stringify(strat.rules)
    ) {
      strategyUpdated += 1;
    } else {
      strategyUnchanged += 1;
    }
  }

  return {
    userId,
    brainEntries: {
      inserted: brainInserted,
      updated: brainUpdated,
      unchanged: brainUnchanged,
      total: STARTER_BRAIN.length,
    },
    strategies: {
      inserted: strategyInserted,
      updated: strategyUpdated,
      unchanged: strategyUnchanged,
      total: STARTER_STRATEGIES.length,
    },
    summary: STARTER_BRAIN_SUMMARY,
  };
}

// Timestamp of the most recent starter-entry write for this user, so the
// UI can render "last synced X ago". Returns null if the brain was never
// seeded. Cheap — single indexed query.
export async function lastSeedTimestamp(userId: string): Promise<Date | null> {
  const latest = await prisma.brainEntry.findFirst({
    where: {
      userId,
      id: { startsWith: `${userId}-seed-brain-` },
    },
    orderBy: { updatedAt: 'desc' },
    select: { updatedAt: true },
  });
  return latest?.updatedAt ?? null;
}

// Cheap check for the UI: is the starter brain already loaded for this user?
// Looks for the canonical marker entry, not a count — more robust when users
// delete individual seed rows or when the library grows.
export async function isBrainSeeded(userId: string): Promise<boolean> {
  const marker = await prisma.brainEntry.findUnique({
    where: { id: brainRowId(userId, 'principle', STARTER_BRAIN_MARKER_SLUG) },
    select: { id: true },
  });
  return marker != null;
}

export { STARTER_BRAIN_SUMMARY };

// Returns the list of library-strategy slugs this user is missing. Used
// by /strategy to show a "new strategies available — sync now" nudge
// so users don't have to know that the /brain sync button is what also
// pulls in new strategy rows.
export async function missingStarterStrategySlugs(userId: string): Promise<string[]> {
  const expectedIds = STARTER_STRATEGIES.map((s) => strategyRowId(userId, s.slug));
  const existing = await prisma.strategy.findMany({
    where: { userId, id: { in: expectedIds } },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((s) => s.id));
  return STARTER_STRATEGIES.filter(
    (s) => !existingIds.has(strategyRowId(userId, s.slug))
  ).map((s) => s.slug);
}

// Taxonomy backfill — re-label any row whose (category, confidence)
// disagrees with the canonical map for its kind. Originally gated on
// category='memory' because that was the schema default, but that
// silently left rows with a different stale category (e.g. a legacy
// 'note'-categorised pitfall, or a hand-written principle that landed
// with the wrong confidence) alone. Now we fetch every row and update
// only when kind has an authoritative mapping AND the current values
// differ — so the update count is tight and users running sync
// repeatedly don't thrash uninvolved rows.
export async function backfillBrainTaxonomy(userId: string): Promise<number> {
  const rows = await prisma.brainEntry.findMany({
    where: { userId },
    select: { id: true, kind: true, category: true, confidence: true },
  });
  let fixed = 0;
  for (const row of rows) {
    const taxonomy = BRAIN_KIND_TAXONOMY[row.kind];
    if (!taxonomy) continue;
    if (
      row.category === taxonomy.category &&
      row.confidence === taxonomy.confidence
    ) {
      continue;
    }
    await prisma.brainEntry.update({
      where: { id: row.id },
      data: {
        category: taxonomy.category,
        confidence: taxonomy.confidence,
      },
    });
    fixed += 1;
  }
  return fixed;
}
