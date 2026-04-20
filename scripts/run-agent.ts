// Manually wake the agent from the CLI. Useful for cron environments that prefer a script.
import { runAgent } from '../src/lib/agents/orchestrator';
import { prisma } from '../src/lib/db';

async function main() {
  const user = await prisma.user.findFirst();
  if (!user) throw new Error('no user — run db:seed first');
  const result = await runAgent({ userId: user.id, trigger: 'manual' });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
