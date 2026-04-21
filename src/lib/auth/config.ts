// Auth.js v5 configuration. Magic-link email sign-in backed by Prisma.
// In dev (no RESEND_API_KEY), the sign-in URL is logged to stdout instead
// of sent — Auth.js's recommended local workflow.

import NextAuth from 'next-auth';
import type { NextAuthConfig } from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Resend from 'next-auth/providers/resend';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';

const ALLOWED_EMAILS = (process.env.AGBRO_ALLOWED_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const authConfig: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'database' },
  pages: { signIn: '/login', verifyRequest: '/login?check=1' },
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
      // New sign-up: bootstrap a trading Account, a default Strategy, and
      // a Day-0 charter brain entry. Defaults mirror prisma/seed.ts so dev
      // seed and prod sign-up converge.
      if (!user.id) return;
      await prisma.account.upsert({
        where: { userId: user.id },
        update: {},
        create: {
          userId: user.id,
          expectedAnnualPct: 12.0,
          riskTolerance: 'moderate',
          maxPositionPct: Number(process.env.MAX_POSITION_PCT ?? 15),
          maxDailyTrades: Number(process.env.MAX_DAILY_TRADES ?? 3),
          minCashReservePct: Number(process.env.MIN_CASH_RESERVE_PCT ?? 10),
        },
      });
      const existingStrategy = await prisma.strategy.findFirst({
        where: { userId: user.id },
      });
      if (!existingStrategy) {
        await prisma.strategy.create({
          data: {
            userId: user.id,
            name: 'Buffett-style Value + Dividend Core',
            isActive: true,
            version: 1,
            buffettScore: 85,
            summary:
              'Buy durable-moat businesses trading below intrinsic value with a 20%+ margin of safety. ' +
              'Prefer dividend payers with ROE > 15% and manageable debt. Ballast with broad-market ETFs. ' +
              'Hold for years. Only sell on thesis break or materially better opportunity.',
            rules: {
              minMarginOfSafetyPct: 20,
              minMoatSignal: 'narrow',
              minROEPct: 15,
              maxDebtToEquity: 1.5,
              preferDividend: true,
              maxPosition: 15,
              minCashReserve: 10,
              maxDailyTrades: 3,
              allowDayTrades: false,
              targetAnnualReturnPct: 12,
            },
          },
        });
      }
      await prisma.brainEntry.create({
        data: {
          userId: user.id,
          kind: 'principle',
          title: 'Day 0 — The Charter',
          body:
            'AgBro exists to preserve principal first, and grow it second. ' +
            'No options. No shorting. No margin. Minimal day trading. ' +
            'Every trade must pass the internal analyzer AND carry a written Bull/Bear case. ' +
            'Margin of safety is non-negotiable. We learn in public: every closed position gets a post-mortem.',
          tags: ['charter', 'principles'],
        },
      });
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
