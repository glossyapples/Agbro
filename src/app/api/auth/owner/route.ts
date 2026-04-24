// Single-user owner bypass.
//
// GET  /api/auth/owner — returns a minimal HTML sign-in form. Bookmarkable;
//                       no secrets in the URL. Browser password managers
//                       auto-fill the key field on return visits, so the
//                       "tap bookmark, tap submit" UX survives.
// POST /api/auth/owner — accepts the key via X-Agbro-Owner-Key header OR
//                       an HTML form body. Verifies the shared secret,
//                       finds-or-creates the owner User, mints an Auth.js
//                       database session, sets the session cookie, and
//                       redirects to /.
//
// Previously GET /api/auth/owner?key=... transited the secret in the query
// string — which ends up in reverse-proxy logs, Referer headers on outbound
// links, and browser history. This route used to work that way; the
// query-string path is gone as of this commit. Existing bookmarks need to
// be updated (re-save the bookmark after the first successful login).
//
// Security model unchanged: whoever knows AGBRO_SINGLE_USER_KEY is the
// owner. Treat the key like a password. Rotate by changing the env var.

import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { timingSafeEqual } from '@/lib/api';
import { bootstrapNewUser } from '@/lib/auth/bootstrap';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SESSION_TTL_DAYS = 30;

function ownerEnv(): { ownerEmail: string; ownerKey: string } | null {
  const ownerEmail = process.env.AGBRO_SINGLE_USER_EMAIL?.trim().toLowerCase();
  const ownerKey = process.env.AGBRO_SINGLE_USER_KEY;
  if (!ownerEmail || !ownerKey || ownerKey.length < 16) return null;
  return { ownerEmail, ownerKey };
}

// Small, self-contained sign-in form. Deliberately no external assets so
// it renders on a fresh session with zero round-trips. Password managers
// recognise the `autocomplete="current-password"` + `name="key"` combo
// and pre-fill on return visits. The form POSTs back to this same path.
function signInForm(errorMessage?: string): string {
  const err = errorMessage
    ? `<p style="color:#f88;margin:0 0 12px;font-size:13px;">${errorMessage}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>AgBro — owner sign-in</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#10131c; color:#e7ebf5; display:grid; place-items:center; min-height:100dvh; padding:16px; }
  .card { max-width:360px; width:100%; background:#161b27; border:1px solid #262e3f;
          border-radius:12px; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { margin:0 0 16px; color:#8892a6; font-size:12px; }
  label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.08em;
          color:#8892a6; margin-bottom:6px; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; background:#0e121b;
          border:1px solid #262e3f; border-radius:8px; color:#e7ebf5; font-size:14px; }
  button { margin-top:12px; width:100%; padding:10px 12px; background:#3d82f7; color:#fff;
           border:0; border-radius:8px; font-weight:600; font-size:14px; cursor:pointer; }
</style>
</head>
<body>
<main class="card">
  <h1>AgBro</h1>
  <p class="sub">Owner sign-in. Paste your key; your browser can remember it.</p>
  ${err}
  <form method="POST" action="/api/auth/owner" autocomplete="on">
    <label for="key">Owner key</label>
    <input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;
}

export async function GET() {
  const env = ownerEnv();
  // Feature-off when env not configured. Return 404 so the endpoint
  // doesn't reveal its existence on deploys where it's not enabled.
  if (!env) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return new NextResponse(signInForm(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Extra defence: hint to proxies that the HTML is sensitive.
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export async function POST(req: Request) {
  const env = ownerEnv();
  if (!env) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { ownerEmail, ownerKey } = env;

  // Accept the key via header (preferred for programmatic / bookmarklet
  // flows) or form body (what the HTML form submits).
  let provided = req.headers.get('x-agbro-owner-key') ?? '';
  if (!provided) {
    const form = await req.formData().catch(() => null);
    provided = String(form?.get('key') ?? '');
  }

  if (!timingSafeEqual(provided, ownerKey)) {
    log.warn('auth.owner.bad_key', { ip: req.headers.get('x-forwarded-for') });
    // Render the form again with an error instead of a bare 401 — the
    // user came from a browser, not an API client.
    const wantsHtml =
      (req.headers.get('accept') ?? '').includes('text/html') ||
      req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded');
    if (wantsHtml) {
      return new NextResponse(signInForm('That key didn’t match. Try again.'), {
        status: 401,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      });
    }
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

  // 303 See Other converts the POST-then-redirect into a GET of /
  // cleanly (proper post-redirect-get pattern).
  const res = NextResponse.redirect(new URL('/', req.url), 303);
  res.cookies.set(cookieName, sessionToken, {
    expires,
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/',
  });
  return res;
}
