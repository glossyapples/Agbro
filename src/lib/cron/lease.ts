// Leader-election helpers for the scheduler. One row per named lease;
// acquire is an atomic INSERT ... ON CONFLICT DO UPDATE with a
// `WHERE expires_at < NOW()` guard, so two replicas contending for the
// same lease see exactly one winner. Release sets expires_at = NOW()
// explicitly rather than waiting for TTL — the TTL is a crash
// safety-net, not the primary release path.
//
// See SchedulerLease model in prisma/schema.prisma for the design
// rationale (why not pg_advisory_lock, why not xact-scoped).

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';

// Opaque per-process token. Generated once at module load so every
// acquire from this instance carries the same identity — makes
// ownership observable in the DB and lets release verify we still
// own the lease (we don't stomp on another instance's newer claim).
const HOLDER_ID = `agbro-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

// Default TTL is a crash safety-net: long enough that a healthy tick
// won't expire mid-run, short enough that a crashed replica's lease
// is reclaimable on the next tick. 3 minutes handles the weekly-
// meeting tick (which fans out meetings async but returns in seconds)
// comfortably.
const DEFAULT_TTL_MS = 3 * 60_000;

export type LeaseAcquisition =
  | { acquired: true; holderId: string; leaseId: string }
  | { acquired: false; heldBy: string | null; leaseId: string };

export async function tryAcquireLease(
  leaseId: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<LeaseAcquisition> {
  const expiresAt = new Date(Date.now() + ttlMs);
  // Atomic: insert if no row, or update if existing row is expired.
  // The ON CONFLICT branch's WHERE is key — without it, an unexpired
  // lease would get overwritten. Returns the row iff we won the race.
  const rows = await prisma.$queryRaw<
    Array<{ heldBy: string; expiresAt: Date }>
  >`
    INSERT INTO "SchedulerLease" ("leaseId", "heldBy", "acquiredAt", "expiresAt")
    VALUES (${leaseId}, ${HOLDER_ID}, NOW(), ${expiresAt})
    ON CONFLICT ("leaseId") DO UPDATE
      SET "heldBy" = EXCLUDED."heldBy",
          "acquiredAt" = EXCLUDED."acquiredAt",
          "expiresAt" = EXCLUDED."expiresAt"
      WHERE "SchedulerLease"."expiresAt" < NOW()
    RETURNING "heldBy", "expiresAt"
  `;
  if (rows.length > 0 && rows[0].heldBy === HOLDER_ID) {
    return { acquired: true, holderId: HOLDER_ID, leaseId };
  }
  // Didn't win — find out who's holding it for the log line. Best-
  // effort; if this second query fails we still return acquired:false.
  const current = await prisma.schedulerLease
    .findUnique({ where: { leaseId }, select: { heldBy: true } })
    .catch(() => null);
  return { acquired: false, heldBy: current?.heldBy ?? null, leaseId };
}

export async function releaseLease(leaseId: string): Promise<void> {
  // Only release if we still own the lease — protects against the
  // unlikely case where our tick overran the TTL and another replica
  // legitimately reclaimed it mid-run.
  await prisma.schedulerLease
    .updateMany({
      where: { leaseId, heldBy: HOLDER_ID },
      data: { expiresAt: new Date() },
    })
    .catch((err) => {
      log.warn('scheduler.lease_release_failed', {
        leaseId,
        err: (err as Error).message,
      });
    });
}

// Exported for observability — useful in /api/scheduler/status.
export function leaseHolderId(): string {
  return HOLDER_ID;
}
