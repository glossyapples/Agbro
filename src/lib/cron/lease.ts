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
// is reclaimable on the next tick. Must strictly exceed the route
// handler's maxDuration (5 min on /api/cron/tick) — otherwise a slow
// tick that runs the full 5 min would have its lease expire mid-body
// and a second replica could acquire while the first is still inside
// runTickBody, double-firing crypto cycle + regime detect. Audit C12.
const DEFAULT_TTL_MS = 6 * 60_000;

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
  // Audit C10: runtime shape assertion. Postgres returns the column
  // names verbatim from the RETURNING clause (quoted → camelCase).
  // The TS generic above is a fiction TypeScript can't verify at
  // runtime. If a future schema migration adds @map("held_by") on
  // SchedulerLease.heldBy, RETURNING would still respect the literal
  // column name "heldBy" (because the SQL is hand-written, not
  // Prisma-generated) — but if anyone refactors the SQL to use the
  // Prisma client API, the response shape could shift to snake_case
  // and the equality check below would silently always be false,
  // re-introducing the original 2-week outage. This guard fails
  // LOUDLY in that case so we catch it on the first tick.
  if (rows.length > 0 && !('heldBy' in rows[0])) {
    log.error(
      'scheduler.lease.unexpected_row_shape',
      new Error(
        `tryAcquireLease got row without heldBy property — column-name contract broken; got keys=${Object.keys(rows[0]).join(',')}`
      ),
      { leaseId }
    );
    throw new Error(
      'scheduler lease row shape mismatch — heldBy property missing. See logs.'
    );
  }
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
