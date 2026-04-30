// Edge middleware: redirect unauthenticated traffic to /login.
// Cron and auth endpoints bypass via the matcher below (they handle their own auth).
//
// Uses the Auth.js session cookie directly (no DB lookup in edge runtime).

import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/disclaimer'];

// Auth.js v5 session cookie name. Prefixed "__Secure-" on HTTPS.
function hasSessionCookie(req: NextRequest): boolean {
  return (
    req.cookies.has('authjs.session-token') ||
    req.cookies.has('__Secure-authjs.session-token')
  );
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  if (hasSessionCookie(req)) return NextResponse.next();

  // Page requests → redirect to /login with return path.
  // API requests → 401 JSON so fetch callers don't follow a redirect.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('from', pathname + (search ?? ''));
  return NextResponse.redirect(url);
}

// Exclude: Auth.js routes, cron routes (secret-gated), health (public liveness),
// scheduler status (public liveness for the autonomous wake loop),
// scheduler-trace (public diagnostic — tick decisions only, no secrets,
// added to break the "agent silent for weeks, no logs visible" loop),
// Next.js internals, static assets.
export const config = {
  matcher: [
    '/((?!api/auth|api/cron|api/health|api/scheduler/status|api/debug/scheduler-trace|_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)',
  ],
};
