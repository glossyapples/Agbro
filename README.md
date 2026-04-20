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
npx prisma migrate dev --name init
npm run db:seed
npm run dev
open http://localhost:3000
```

Manually trigger a wake-up:

```bash
npm run agent:run
# or
curl -X POST http://localhost:3000/api/agents/run
```

## Deploying to Railway

1. Create a new Railway project from this repo.
2. Add a **PostgreSQL** plugin. Railway injects `DATABASE_URL`.
3. Set environment variables (see `.env.example`). At minimum:
   - `ANTHROPIC_API_KEY`
   - `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER=true`
   - `AGBRO_CRON_SECRET` (any random string)
   - `PERPLEXITY_API_KEY`, `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX` (optional but
     strongly recommended)
4. Railway auto-detects `package.json`; `build` runs migrations + `next build`.
5. Add two Railway **cron** services (or use an external cron):
   - `*/30 9-16 * * 1-5` → `POST /api/cron/tick`  (wakes the agent on cadence)
   - `0 17 * * 5` → `POST /api/cron/weekly`       (Friday 5pm weekly brain)
   Each request must include the header `x-agbro-cron-secret: $AGBRO_CRON_SECRET`.
6. Open the Railway URL on your phone → Add to Home Screen. Done.

## File map

```
prisma/
  schema.prisma              # data model
  seed.ts                    # starter user, strategy, 29-stock watchlist
src/lib/
  analyzer/index.ts          # Graham / DCF / DDM / moat / Buffett score / sizer
  alpaca.ts                  # broker wrapper, paper by default
  agents/
    models.ts                # enforces claude-opus-4-7 for trades
    orchestrator.ts          # wake-up loop: tool-use agent
    prompts.ts               # charter + wizard + brain-writer system prompts
    tools.ts                 # the tools exposed to the agent
  research/
    perplexity.ts
    google.ts
  db.ts, money.ts, auth.ts
src/app/
  page.tsx                   # overview + live Stop/Pause/Continue
  trades/page.tsx            # trade log w/ Bull + Bear per trade
  strategy/                  # list + wizard chat
  brain/page.tsx             # principles, weekly updates, post-mortems
  analytics/page.tsx         # scoreboard
  settings/page.tsx          # limits, cadence, hours, deposits
  disclaimer/page.tsx        # full risk disclosure
  api/
    agents/run              # wake the agent on demand
    account/                # control (pause/stop/continue), deposit, settings
    strategy/, brain/, trades/, analyzer/
    cron/tick               # scheduled wake-up
    cron/weekly             # weekly brain writeup
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
