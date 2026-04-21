// Auth.js v5 configuration. Magic-link email sign-in backed by Prisma.
// In dev (no RESEND_API_KEY), the sign-in URL is logged to stdout instead
// of sent — Auth.js's recommended local workflow.

import NextAuth from 'next-auth';
import type { NextAuthConfig } from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Resend from 'next-auth/providers/resend';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { bootstrapNewUser } from './bootstrap';

const ALLOWED_EMAILS = (process.env.AGBRO_ALLOWED_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const authConfig: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'database' },
  // Required behind a reverse proxy (Railway / Vercel / Fly). Without this,
  // Auth.js v5 refuses to process requests for non-localhost hostnames and
  // every page that calls auth() throws.
  trustHost: true,
  pages: {
    signIn: '/login',
    // verifyRequest deliberately omitted — setting it to a custom path with a
    // query string confuses Auth.js v5's action router (UnknownAction).
    // The built-in /api/auth/verify-request page is minimal but functional;
    // a custom styled page can land on a dedicated route (e.g. /auth/check)
    // later if we want.
  },
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY ?? 'dev-no-op',
      from: process.env.AGBRO_MAIL_FROM ?? 'AgBro <onboarding@resend.dev>',
      async sendVerificationRequest({ identifier, url, provider }) {
        // Dev fallback: no key → print the magic link to server logs so we can copy it.
        if (!process.env.RESEND_API_KEY) {
          log.info('auth.magic_link.dev_fallback', { email: identifier, url });
          return;
        }
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: provider.from,
            to: identifier,
            subject: 'Your AgBro sign-in link',
            html: `<p>Sign in to AgBro:</p><p><a href="${url}">${url}</a></p><p>This link expires in 24 hours.</p>`,
            text: `Sign in to AgBro: ${url}\n\nThis link expires in 24 hours.`,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`resend send failed: ${res.status} ${body}`);
        }
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      // Allowlist gate (optional). If AGBRO_ALLOWED_EMAILS is set, only those
      // addresses can sign in. Leave unset to allow any verified email.
      if (ALLOWED_EMAILS.length === 0) return true;
      const email = user.email?.toLowerCase();
      return !!email && ALLOWED_EMAILS.includes(email);
    },
    async session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) await bootstrapNewUser(user.id);
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
