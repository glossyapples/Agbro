import { redirect } from 'next/navigation';
import { auth, signIn } from '@/lib/auth/config';

export const runtime = 'nodejs';

// Only accept same-origin relative paths as a post-login redirect target.
// Auth.js v5 already blocks off-origin redirects, but we sanitize here too
// so any future misconfiguration can't turn /login into an open redirect.
function sanitizeRedirect(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  // Must start with a single slash (not `//` → protocol-relative to another host).
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const session = await auth();
  if (session?.user) redirect('/');

  const from = sanitizeRedirect(searchParams.from);

  async function handleSignIn(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    if (!email) return;
    await signIn('resend', { email, redirectTo: from });
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">AgBro</h1>
        <p className="mt-1 text-sm text-ink-400">
          Sign in with a magic link. No passwords.
        </p>
      </header>

      <form action={handleSignIn} className="flex flex-col gap-3">
          <label htmlFor="email" className="text-sm font-medium text-ink-300">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-ink-100 focus:border-brand-400 focus:outline-none"
            placeholder="you@example.com"
          />
          <button
            type="submit"
            className="rounded-lg bg-brand-500 px-3 py-2 font-medium text-white hover:bg-brand-400"
          >
            Email me a sign-in link
          </button>
        </form>

      <p className="text-xs text-ink-500">
        By continuing you accept the{' '}
        <a href="/disclaimer" className="underline">
          risk disclaimer
        </a>
        .
      </p>
    </div>
  );
}
