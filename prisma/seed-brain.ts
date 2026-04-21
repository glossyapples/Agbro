// CLI: seeds/refreshes the starter brain + archived alternative strategies
// for every user in the database. Idempotent — safe to re-run after library
// updates; existing seed rows get their content refreshed, missing rows get
// created, and user-owned fields (active strategy, version) are never touched.
//
// Usage:  npm run db:seed-brain

import { PrismaClient } from '@prisma/client';
import { seedBrainForUser } from '../src/lib/brain/seed-brain';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  if (users.length === 0) {
    console.log('No users found. Nothing to seed.');
    return;
  }

  console.log(`Seeding brain for ${users.length} user(s)…`);
  let brainInserted = 0;
  let brainUpdated = 0;
  let strategyInserted = 0;
  let strategyUpdated = 0;

  for (const user of users) {
    const r = await seedBrainForUser(user.id);
    brainInserted += r.brainEntries.inserted;
    brainUpdated += r.brainEntries.updated;
    strategyInserted += r.strategies.inserted;
    strategyUpdated += r.strategies.updated;
    console.log(
      `  • ${user.email}: ${r.brainEntries.inserted} inserted / ${r.brainEntries.updated} refreshed brain, ` +
        `${r.strategies.inserted} inserted / ${r.strategies.updated} refreshed strategies`
    );
  }

  console.log(
    `\nDone. Brain: ${brainInserted} new, ${brainUpdated} refreshed. ` +
      `Strategies: ${strategyInserted} new, ${strategyUpdated} refreshed.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
