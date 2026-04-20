// Single-user MVP — "auth" is hard-coded to the seed account. Extend later.
import { prisma } from '@/lib/db';

const SEED_EMAIL = 'owner@agbro.local';

export async function getCurrentUser() {
  const user = await prisma.user.findUnique({
    where: { email: SEED_EMAIL },
    include: { account: true },
  });
  if (!user) throw new Error('seed user missing — run `npm run db:seed`');
  return user;
}
