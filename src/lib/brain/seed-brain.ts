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
    const existing = await prisma.brainEntry.findUnique({
      where: { id },
      select: { title: true, body: true, tags: true },
    });
    await prisma.brainEntry.upsert({
      where: { id },
      create: {
        id,
        userId,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        relatedSymbols: [],
      },
      update: {
        // Deliberately do NOT reset userId/kind/id — just refresh content so
        // library improvements flow to existing users on the next seed run.
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
      },
    });
    if (!existing) {
      brainInserted += 1;
    } else if (
      existing.title !== entry.title ||
      existing.body !== entry.body ||
      existing.tags.join('|') !== entry.tags.join('|')
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
