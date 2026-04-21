#!/usr/bin/env node
// Release step: push the Prisma schema against the live DB before booting
// the app. Idempotent when the schema matches.
//
// In the normal case we run `prisma db push --skip-generate`. That command
// REFUSES any change it considers lossy (column drop, type narrowing,
// constraint drop). Refusal is correct for real-money prod — we don't want
// a careless schema edit to wipe a column of trade history.
//
// For paper-trading / first-day-of-testing deploys, where the live DB only
// contains re-seedable or re-derivable state, the refusal is noise. Set
//   AGBRO_DB_ACCEPT_DATA_LOSS=true
// in Railway env and this script passes `--accept-data-loss` to Prisma.
//
// HOW TO FLIP OFF AGAIN (before real money):
//   Unset AGBRO_DB_ACCEPT_DATA_LOSS in Railway.
//   Any future schema change that Prisma considers lossy will then fail the
//   deploy — which is exactly what you want when the DB holds real state.

const { spawnSync } = require('node:child_process');

const acceptDataLoss = process.env.AGBRO_DB_ACCEPT_DATA_LOSS === 'true';
const args = ['db', 'push', '--skip-generate'];
if (acceptDataLoss) args.push('--accept-data-loss');

if (acceptDataLoss) {
  console.log(
    '[release] AGBRO_DB_ACCEPT_DATA_LOSS=true — running prisma db push WITH --accept-data-loss. ' +
      'Columns present in the DB but absent from the current schema WILL be dropped. ' +
      'Unset this env var before real-money live.'
  );
} else {
  console.log('[release] prisma db push (refuses lossy changes — the safe default).');
}

const r = spawnSync('prisma', args, { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
