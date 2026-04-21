// Session-backed auth. Reads the Auth.js database session and loads the user
// plus their TradingAccount. API routes should go through requireUser() in
// src/lib/api.ts (returns 401). Server pages should use requirePageUser()
// below (redirects to /login on missing/stale session).

import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { auth, signOut } from '@/lib/auth/config';

export async function getCurrentUser() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error('unauthenticated');
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { account: true },
  });
  if (!user) {
    // Session cookie refers to a user row that no longer exists. Sign the
    // stale session out so the next request gets redirected to /login
    // cleanly instead of looping on the same 500.
    await signOut({ redirect: false }).catch(() => undefined);
    throw new Error('session stale');
  }
  return user;
}

export async function maybeCurrentUser() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  return prisma.user.findUnique({
    where: { id: userId },
    include: { account: true },
  });
}

// For server components. If no session / stale session, redirects to /login
// with a `from` param so post-login returns the user to this page.
export async function requirePageUser(returnTo: string = '/') {
  try {
    return await getCurrentUser();
  } catch {
    const qs = returnTo && returnTo !== '/' ? `?from=${encodeURIComponent(returnTo)}` : '';
    redirect(`/login${qs}`);
  }
}
