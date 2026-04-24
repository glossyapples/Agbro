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

// Paths that must stay reachable even when onboarding isn't complete
// — otherwise the middleware-ish redirect below creates an infinite
// loop (/ → /onboarding → /onboarding loads requirePageUser → /).
const ONBOARDING_EXEMPT = new Set(['/onboarding', '/settings', '/help', '/disclaimer']);

// For server components. If no session / stale session, redirects to /login
// with a `from` param so post-login returns the user to this page. If the
// user has a session but hasn't completed the /onboarding wizard, redirects
// there once — skipped for the exempt routes above.
export async function requirePageUser(returnTo: string = '/') {
  try {
    const user = await getCurrentUser();
    if (
      user.account &&
      !user.account.onboardingCompletedAt &&
      !ONBOARDING_EXEMPT.has(returnTo)
    ) {
      redirect('/onboarding');
    }
    return user;
  } catch (err) {
    // Re-raise Next's redirect "errors" so the above redirect() above
    // actually fires — catching it would swallow the redirect.
    if (err && typeof err === 'object' && 'digest' in err) throw err;
    const qs = returnTo && returnTo !== '/' ? `?from=${encodeURIComponent(returnTo)}` : '';
    redirect(`/login${qs}`);
  }
}
