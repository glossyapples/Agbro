// Session-backed auth. Reads the Auth.js database session and loads the user
// plus their TradingAccount (1:1 relation). Throws when no session is
// present — callers should go through requireUser() in src/lib/api.ts, which
// translates the throw into a 401 response.

import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth/config';

export async function getCurrentUser() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error('unauthenticated');
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { account: true },
  });
  if (!user) throw new Error('session user not found');
  return user;
}

// Optional variant: returns null instead of throwing. Handy for layouts/pages
// that want to render different UI when signed out without catching.
export async function maybeCurrentUser() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  return prisma.user.findUnique({
    where: { id: userId },
    include: { account: true },
  });
}
