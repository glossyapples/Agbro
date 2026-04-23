# AgBro — Warren Buffbot

> Agentic brokerage infrastructure. Preserve principal. Grow patiently.

AgBro is a "set-it-and-forget-it" trading platform where a Claude-powered
agent wakes up on a schedule, studies its own notes, researches candidates,
runs internal valuation calculators, and — if a trade passes every safety
rail — places it through Alpaca Markets. Everything is logged; every closed
position gets a post-mortem; every week the agent writes a brain update so
the next agent picks up smarter than the last one.

## ⚠ Disclaimer (read first)

This is experimental software. It is not financial advice, and it is not a
registered brokerage. **Think of the money you deposit the way you'd think
about money you brought to a casino.** The author's own rule of thumb is $100
to $1,000, based on financial comfort. Never your rent, tuition, emergency
fund, or retirement savings. Past results don't predict future results.
AgBro will sometimes be wrong. Full disclaimer at `/disclaimer` in-app.

## The two goals, in order

1. **Preserve principal.** Losing the seed capital is a catastrophic failure.
2. **Grow it.** Target an annual return the user sets in Settings.

No options. No shorting. No margin. Minimal day trading (off by default). Spot
equities + ETFs only. Value investing bias (Buffett / Graham / Munger).

## Features

- **Mobile-first PWA**: iPhone Safari → Add to Home Screen. Runs without a
  laptop ever being opened again.
- **Live controls**: Stop, Pause, Continue from the home screen.
- **Agent runtime**: orchestrator backed by `claude-opus-4-7` — hardcoded for
  trade decisions (`src/lib/agents/models.ts`) so it can't be downgraded.
- **Internal financial analyzer**: Graham Number, Graham Formula, two-stage
  DCF, Dividend Discount Model, sector-fair P/E, moat signal, Buffett score,
  margin-of-safety, position sizer. Runs BEFORE any trade. Cross-referenced
  by the agent with online research.
- **Research stack**: Perplexity for specific / time-sensitive facts, Google
  CSE for general background. Every candidate gets a **Bull Case + Bear
  Case** on record.
- **Comprehensive seed stock DB**: 29 Buffett-style names + ETFs, enriched by
  the agent over time.
- **Strategy wizard**: conversational chat where the user iterates on strategy
  with an agent. All historical strategies preserved.
- **Company brain**: weekly updates, post-mortems, lessons, principles.
- **Notifications**: every trade, every pause, every weekly update.
- **Audit log**: user actions are recorded alongside agent decisions.
- **Safety rails enforced server-side**:
  - `maxPositionPct` — no single position exceeds N%
  - `maxDailyTrades` — hard cap
  - `minCashReservePct` — always keep N% in cash
  - Trading hours + weekend skip
  - Paused/stopped flags checked on every wake-up *and* every order

## Tech stack

- Next.js 14 (App Router) + TypeScript + Tailwind
- Prisma + PostgreSQL
- `@anthropic-ai/sdk` with tool-use — model: **`claude-opus-4-7`** for trades
- `@alpacahq/alpaca-trade-api` — paper trading by default
- Perplexity API + Google Programmable Search

## Quick start (local)

```bash
cp .env.example .env            # fill in keys
npm install
npx prisma db push              # create schema against your local DB
npm run db:seed                 # optional: seed the 29-stock watchlist
npm run dev
open http://localhost:3000
```

First sign-in:

1. Go to `/login`, enter an email.
2. Because `RESEND_API_KEY` is empty in dev, the magic link is **logged to
   your terminal** as `auth.magic_link.dev_fallback`. Copy the `url` field
   from that line and open it.
3. The sign-in hook auto-creates your trading Account, a default Strategy,
   and a Day-0 brain entry. You land on `/`.

Manually trigger a wake-up:

```bash
npm run agent:run
# or, once signed in:
curl -X POST http://localhost:3000/api/agents/run -b cookies.txt
```

## Deploying to Railway

1. **Create a new Railway project** from this repo.
2. **Add the PostgreSQL plugin.** Railway injects `DATABASE_URL`.
3. **Set environment variables** in the service (see `.env.example` for the
   full list). Minimum to boot:
   - `ANTHROPIC_API_KEY`
   - `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER=true`
   - `AGBRO_CRON_SECRET` — any random string (use `openssl rand -hex 32`)
   - `AUTH_SECRET` — any random string (use `openssl rand -base64 32`)
   - `AUTH_URL` — your Railway public URL, e.g. `https://agbro.up.railway.app`
   - `RESEND_API_KEY` + `AGBRO_MAIL_FROM` — needed so magic links actually get
     emailed. Without these you can't sign in on the deployed instance.
   - `AGBRO_ALLOWED_EMAILS` — comma-separated allowlist (recommended for a
     single-person deploy). Leave empty to allow any email to sign in.
   - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — strongly
     recommended; without these the rate limiter falls back to in-memory,
     which is bypassable by any restart or second instance.
   - `PERPLEXITY_API_KEY`, `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX` — optional;
     research tools gracefully no-op without them.
4. **First boot.** Railway auto-detects `package.json`. Build runs
   `prisma generate && next build` (pure, no DB access). The start command
   (`npm run start:prod`) runs `prisma db push --skip-generate` against
   the live DB before booting Next — so the schema provisions itself on
   every deploy. This is idempotent when the schema already matches.
   Note: `db push` will **refuse** destructive schema changes without an
   explicit `--accept-data-loss` flag; if a deploy fails on a rename, you
   need to handle it by hand or switch to `prisma migrate`.
5. **Scheduling is automatic.** The Next.js server includes an
   in-process scheduler that wakes the agent every 2 minutes and
   respects each account's `agentCadenceMinutes`, trading hours, and
   weekend / regime-transition rules. No GitHub Actions setup, no
   Railway cron to configure — deploy and it runs. The weekly Brain
   writeup can still be triggered by Railway cron (`0 22 * * 5` →
   `POST /api/cron/weekly` with `x-agbro-cron-secret`), or manually
   from the CLI (`scripts/weekly-brain.ts`).

   `POST /api/cron/tick` remains available as a manual trigger for
   debugging / ops (same cron-secret header). Set
   `AGBRO_DISABLE_SCHEDULER=true` to turn the internal loop off (e.g.
   during a maintenance window).
6. **Health check.** Point your uptime monitor at `GET /api/health` (public,
   returns 200 with `{ok:true, db:{ok, latencyMs}}` when healthy, 503 otherwise).
7. **Sign in.** Visit your URL, `/login`, enter your email. Auth.js emails a
   magic link via Resend. The sign-in hook bootstraps your account on first
   use — no manual seed required in prod.
8. **Add to Home Screen** on your phone. Done.

### Going live (real money)

Phased rollout is the only responsible path:
- Keep `ALPACA_PAPER=true` for the first **several weeks** of real deployment.
- Watch `AgentRun.costUsd`, the Brain's weekly post-mortems, and the Analytics
  page. If week-over-week the agent isn't making sensible calls, stay paper.
- When flipping live, also deposit the **smallest meaningful** amount first
  (see Disclaimer). `ALPACA_PAPER=false` is the only switch; **nothing else
  changes**, which is the point — there must be no code path that behaves
  differently between paper and live.

## File map

```
prisma/
  schema.prisma              # data model
  seed.ts                    # starter user, strategy, 29-stock watchlist
src/lib/
  analyzer/index.ts          # Graham / DCF / DDM / moat / Buffett score / sizer
  alpaca.ts                  # broker wrapper, paper by default, cancelOrder
  agents/
    models.ts                # enforces claude-opus-4-7 for trades
    orchestrator.ts          # wake-up loop: tool-use agent + position sync + cost
    prompts.ts               # charter + wizard + brain-writer system prompts
    schemas.ts               # Zod schemas for agent tool inputs
    tools.ts                 # the tools exposed to the agent
  research/
    perplexity.ts
    google.ts
  auth/config.ts             # Auth.js v5 config (magic-link + first-sign-in hooks)
  api.ts                     # requireUser / apiError / timing-safe cron secret
  logger.ts                  # structured JSON logger
  pricing.ts                 # Anthropic token → USD estimator
  ratelimit.ts               # Upstash + in-memory fallback
  strategy-diff.ts           # rule-by-rule diff of two Strategy.rules blobs
  time.ts                    # ET-midnight helper (daily trade cap)
  db.ts, money.ts, auth.ts
src/app/
  page.tsx                   # overview + live Stop/Pause/Continue
  login/page.tsx             # magic-link sign-in
  trades/page.tsx            # trade log w/ Bull + Bear per trade
  strategy/                  # list + wizard chat + compare view
  brain/page.tsx             # principles, weekly updates, post-mortems
  analytics/page.tsx         # scoreboard
  settings/page.tsx          # limits, cadence, hours, deposits, sign out
  disclaimer/page.tsx        # full risk disclosure
  api/
    auth/[...nextauth]      # Auth.js handler
    agents/run              # wake the agent on demand (rate-limited)
    account/                # control (pause/stop/continue), deposit, settings
    strategy/, brain/, trades/, analyzer/
    cron/tick               # scheduled wake-up (per-user fan-out, 90s budget)
    cron/weekly             # weekly brain writeup (per-user)
    health                  # liveness + DB check (public)
src/middleware.ts            # redirects unauth pages → /login, 401 JSON for /api
scripts/
  run-agent.ts              # CLI wake
  weekly-brain.ts           # CLI weekly brain trigger
```

## How the agent thinks (in one breath)

```
read brain →
  check account state (broker + policy) →
  re-evaluate existing positions →
  research candidates (perplexity + google) →
  run_analyzer for every serious candidate →
  record Bull Case + Bear Case →
  size_position (respects all limits) →
  place_trade (server re-validates caps/pause/stop) →
  finalize_run (writes summary → brain entry)
```

## What we will NOT do

- Options. Shorting. Margin. Futures. Crypto.
- Trade on hunches — every trade has an internal valuation + a written Bull
  AND Bear case.
- Silently downgrade the trade-decision model. Trade decisions use
  `claude-opus-4-7`, enforced in code.
- Pretend we can't lose money. We can. See the disclaimer.

## Contributing

AgBro is a living codebase. The agent itself contributes over time — every
post-mortem is a training signal for the next run. Principles distilled from
repeated experience live in the Brain.
