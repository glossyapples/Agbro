// Single-user owner bypass. GET /api/auth/owner?key=<AGBRO_SINGLE_USER_KEY>
// verifies the shared secret, finds-or-creates the owner User row, runs the
// same bootstrap hook as the magic-link createUser event, mints a real
// Auth.js database Session, sets the session cookie, and redirects to /.
//
// Designed for a single-person self-hosted deploy where wiring up email
// magic links is friction the owner doesn't need. Bookmark the URL, tap it
// when the 30-day session expires, add-to-home-screen on your phone.
//
// Security model: whoever knows AGBRO_SINGLE_USER_KEY is the owner. Treat
// the key like a password. Rotate by changing the env var (invalidates the
// bookmark, not existing sessions — those live until their expires date).

import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { timingSafeEqual } from '@/lib/api';
import { bootstrapNewUser } from '@/lib/auth/bootstrap';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SESSION_TTL_DAYS = 30;

export async function GET(req: Request) {
  const ownerEmail = process.env.AGBRO_SINGLE_USER_EMAIL?.trim().toLowerCase();
  const ownerKey = process.env.AGBRO_SINGLE_USER_KEY;

  // Feature-off when either env var is missing. Return 404 so the endpoint
  // doesn't reveal its existence on deploys where it's not enabled.
  if (!ownerEmail || !ownerKey || ownerKey.length < 16) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const provided = url.searchParams.get('key') ?? '';
  if (!timingSafeEqual(provided, ownerKey)) {
    log.warn('auth.owner.bad_key', { ip: req.headers.get('x-forwarded-for') });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Find or create the owner User. Auth.js's PrismaAdapter normally does
  // this in the magic-link flow; here we do it directly.
  const user = await prisma.user.upsert({
    where: { email: ownerEmail },
    update: {},
    create: { email: ownerEmail, emailVerified: new Date() },
  });
  await bootstrapNewUser(user.id);

  // Mint an Auth.js database session. The cookie name + shape matches what
  // Auth.js itself issues, so auth() / getCurrentUser() treat this as a
  // normal session and everything downstream works unchanged.
  const sessionToken = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { sessionToken, userId: user.id, expires } });

  const isSecure = (process.env.AUTH_URL ?? '').startsWith('https://');
  const cookieName = isSecure ? '__Secure-authjs.session-token' : 'authjs.session-token';

  log.info('auth.owner.ok', { userId: user.id, email: ownerEmail });

  const res = NextResponse.redirect(new URL('/', req.url));
  res.cookies.set(cookieName, sessionToken, {
    expires,
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/',
  });
  return res;
}
