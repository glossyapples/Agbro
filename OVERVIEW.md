# AgBro — full product overview

---

## The elevator pitch

AgBro is a paper-trading app modeled as a small **Berkshire-style agentic investment firm**. Instead of "a trading bot," you get a rotating cast of LLM-powered "partner-bots" who hold weekly executive meetings (rendered as comic strips), build institutional memory over time, and operate an agent that wakes up every ~2 hours to actually run the book. Every decision is logged, every meeting is readable, every rule is yours to tune.

---

## Stack

- **Framework**: Next.js 14 App Router + TypeScript + Tailwind, mobile-first (iOS PWA)
- **DB**: Postgres on Railway, Prisma ORM (watchlist authoritative in per-user `UserWatchlist` — the legacy global `Stock` catalog is now read-only cache, ending the multi-tenant leak risk)
- **LLM**: Claude Opus 4.7 for the agent / meetings / chats · OpenAI gpt-image-2 for comics
- **Broker**: Alpaca paper trading (free tier, IEX feed)
- **Data**: SEC EDGAR `companyfacts` for historical fundamentals, Alpaca for prices/bars
- **Research**: Perplexity + Google Custom Search (both optional, BYOK)
- **Auth**: Auth.js magic links + operator bypass key (secret passed via POST body + header, never the URL query string)
- **Credentials**: AES-256-GCM per-record IV, validated master key env var, never logged
- **Scheduler**: In-process 2-minute cron (Railway-hosted), regime-triggered force-wake on SPY crisis moves, **multi-replica safe via `SchedulerLease` leader-election row** (TTL'd lease; only the leaseholder runs the tick)

Everything is BYOK on API keys — Anthropic (required), OpenAI (optional for comics), Perplexity + Google (optional for research). User pays providers directly; AgBro doesn't markup.

---

## The agent (wake-up loop)

- Cron tick runs every 2 min, checks per-user: `isStopped`, `isPaused`, kill-switch active, within trading hours, cadence elapsed, regime-triggered force-wake
- Each wake fires a **16-turn Claude tool-use loop** with a serialized inflight lock (Account-row `FOR UPDATE`) and stale-run sweep
- **Tools exposed to the agent** (22 currently):
  - `get_account_state`, `get_positions`, `get_latest_price`, `is_market_open`, `get_watchlist`
  - `read_brain` (filter by category / confidence / kind / tags / symbols / superseded)
  - `write_brain` (for lessons, post-mortems, hypotheses, corrections)
  - `record_research_note` (mirrors to brain as `category=memory, kind=research_note`)
  - `run_analyzer` (internal valuation: Graham / DCF / DDM / Buffett score / MOS / verdict)
  - `research_perplexity`, `research_google`
  - `refresh_fundamentals` (EDGAR point-in-time pull)
  - `update_stock_fundamentals` (agent-supplied refresh for ETFs/ADRs EDGAR can't serve)
  - `screen_universe` (rate-limited weekly candidate discovery via Perplexity)
  - `evaluate_exits` (per-position signals: hold / review / trim / sell + tax-harvest flag)
  - `get_event_calendar` (earnings + macro)
  - `acknowledge_thesis_review` (bumps review timer on confirmed holds)
  - `size_position`, `place_trade` (market + limit; MOS gate on buys; defense-in-depth safety rails)
  - `get_option_chain`, `place_option_trade` (covered calls + cash-secured puts only; strategy must permit)
  - `finalize_run` (writes `agent_run_summary` brain entry with sourceRunId)
- **Defense-in-depth trade gate** (every buy): **Governor audit row** (approved/rejected/requires_approval with a structured reason code) → forbidden-symbol check → autonomy-ladder divergence (Observe intercepts; Propose queues) → MOS → earnings blackout (3 days) → wash-sale (IRS §1091 30-day) → wallet spendable pre-check → per-trade notional cap → FOR UPDATE lock → daily-cap count (excludes rejected/cancelled) → pending-row reservation → broker call → DB stitch. Every rejection lands in `GovernorDecision` with a rendered user-readable explanation.
- **Prompt caching** on system + tool defs (~6k tokens) to cut within-run input cost
- **Cost accounting** cache-aware via shared pricing module

---

## The brain (firm memory)

- Persistent `BrainEntry` table, per-user, richer than a log
- **Two axes**:
  - `category` enum: `principle | playbook | reference | memory | hypothesis | note`
  - `confidence` enum: `canonical | high | medium | low`
- Plus: legacy `kind` label (finer-grained), `tags[]`, `relatedSymbols[]`, `supersededById` self-ref, `sourceRunId` + `sourceMeetingId` provenance, `seedKey` for library sync
- **Seeded starter library** (v1.2.0, 37+ entries):
  - 10 Buffett/Graham/Munger **principles**
  - 4 operational **checklists** (pre-trade, earnings-day, research, sell)
  - 6 **pitfalls** (biases to resist)
  - 6 **sector primers** (Finance, Tech, Healthcare, Utilities, Energy, Consumer)
  - 6 **case studies** (KO 1988, AXP salad oil, IBM mistake, KHC writedown, airlines, plus The Big Short)
  - 5 **crisis playbooks** (1987, 2000, 2008, 2020, 2022)
  - 4 **Burrybot principles** (ick is an invitation, read the footnotes, concentration follows conviction, cash flow over earnings) + his 10-K walkthrough checklist
- **↻ Sync button** on /brain upserts latest library + backfills category/confidence on mis-tagged rows
- **Supersession**: corrected entries retire old ones invisibly (still audit-readable with `includeSuperseded=true`)
- **/brain page** with category-filter pills, confidence badges, tag + ticker chips

---

## Executive meetings

- **Auto-weekly** on Friday 4pm ET + **impromptu** trigger button anytime
- Single Claude call where one model plays all 5 (or 6 with Burrybot guest) roles in one transcript
- **Roles**: `warren_buffbot` (CEO, value-decisive), `charlie_mungbot` (contrarian), `analyst`, `risk`, `operations` + optional `michael_burrybot` guest
- **Cast rotates by active strategy** — Warren Buff-bot + Charlie Mung-bot at Buffett Core, Ben Graham-bot + Mr. Market-bot at Deep Value, Terry Smythe-bot + Nick Trayne-bot at Quality Compounders, The Aristocrat-bot + Yield-bot at Dividend Growth, Jack Boagle-bot + Three-Fund-bot at Boglehead, Burrybot + Cassandra-bot at his firm
- **Generic supporting cast** (stable across strategies): Ana Bytesworth-bot (analyst), Ray Drawdown-bot (risk), Oli Tickertape-bot (ops)
- **Structured JSON output**: transcript (turns) · summary · decisions · actionItems (new) · actionItemUpdates (reviews of prior items) · policyChanges (accept/reject UI) · sentiment · comicFocus (turning-point beat for the comic)
- **Briefing** pre-computes: agent-run cost summary with drag percentages, recent trades, open action items (carried forward), recent brain entries, active hypotheses, current positions, market regime, crypto config, full safety posture
- **Policy changes** applyable only to `account` (maxPositionPct, dailyLossKillPct, drawdownPauseThresholdPct, maxDailyTrades, minCashReservePct, maxCryptoAllocationPct, expectedAnnualPct) + `cadence` (agentCadenceMinutes). All other "kinds" (strategy rules, crypto config, universe) are rejected at the boundary with a clear 400
- **Reset history** button wipes meetings/action items/proposed changes cleanly

---

## Comic strip generation (opt-in, BYOK OpenAI)

- **Two-step pipeline**:
  1. Claude writes a comic screenplay from the meeting transcript (focused on the `comicFocus` beat), following a Mad Magazine / CRACKED editorial-caricature style guide + strategy-specific mood (London boardroom, Columbia lecture hall, etc.)
  2. OpenAI `gpt-image-2` renders the screenplay as a 4-6 panel page with dialogue
- **Strict cast sheet** — each character has a fixed visual description the prompt reuses for consistency across meetings
- **Dialogue rules**: ≤12 words per bubble, no "Name:" prefixes, voice translation layer converts engineering jargon to boardroom English, mandatory USD currency
- **In-band await** with polling safety net + persisted `comicError` for every failure mode
- **Save-to-photos** button with Web Share API + download fallback, retry on onError

---

## Burrybot (deep-research analyst)

A satirical "-bot" homage to Michael Burry — introverted, terse, reads 10-Ks others skim.

- **Guest mode** — per-strategy toggle. Joins meetings as 6th role, ≤3 turns, can't drive decisions or propose policy changes, can suggest `research` action items
- **Firm mode** — "Burry Deep Research" strategy. He's the principal; full cast rotation to his team; rules de-emphasise P/E, lead with FCF yield + EV/EBITDA
- **Form hypothesis** (one-shot per strategy) — bounded Opus call writes 5-10 `category=hypothesis, confidence=low` brain entries tagged `burry` + `strategy-<id>` + `onboard-<id>`. Button auto-hides after successful run
- **Ask Burrybot** (inline multi-turn chat per strategy card) — context-loaded with firm rules, positions, regime, Burrybot's doctrine, his active hypotheses. No trading authority, no policy-change authority. Rate-limited 30 turns/hour

---

## Safety rails

- **Daily loss kill** (%, default -5) — pauses if equity drops ≥5% intraday
- **30-day drawdown pause** (%, default -15) — pauses if equity sits ≥15% below 30-day peak
- **Max trade notional** ($, default $5,000) — hard cap per single buy, no exceptions
- **BYOK API cost-governor** — `monthlyApiBudgetUsd` (default $50) + `budgetAlarmThresholdPct` (default 80). Warning banner fires at the threshold; 100% auto-pauses the account with reason `BUDGET_EXCEEDED` clearable from Settings. Month-to-date spend aggregated from `AgentRun.costUsd` against the UTC calendar (aligns with Anthropic's invoice window).
- **Fail-closed semantics** — Alpaca outage returns `data_unavailable` and skips the tick without persisting a trip (vs the previous fail-open behaviour)
- **Kill-switch persistence** — once tripped, survives restarts; requires manual clear from Settings
- **Pre-trade gates**: Governor audit row · forbidden-symbol check · autonomy-ladder divergence · earnings blackout (3-day window) · wash-sale (IRS §1091) · MOS check vs active strategy's `minMarginOfSafetyPct` · wallet spendable · per-trade notional · daily-cap count · FOR UPDATE lock
- **Allow agent proposals toggle** — when off, meetings record policy-change proposals for audit but can't apply them

---

## Governor + autonomy ladder

Every pre-trade decision now routes through a **structured reason-code Governor**. The existing defense-in-depth gates (MOS, earnings, wash-sale, wallet, notional, daily-cap, pause/stop) each emit a `GovernorDecision` row with:

- `decision` ∈ `approved | rejected | requires_approval`
- `reasonCodes[]` from a fixed enum (`EARNINGS_BLACKOUT`, `MOS_INSUFFICIENT`, `WALLET_INSUFFICIENT`, `NOTIONAL_CAP_EXCEEDED`, `MANDATE_FORBIDDEN_SYMBOL`, `PROPOSE_MODE_REQUIRES_APPROVAL`, etc. — 19 codes total)
- `userExplanation` — rendered template that names the conflict ("This trade would push AAPL to 11% of portfolio, above your 8% cap")
- `autonomyLevel` + `governorVersion` stamped for reproducibility

**Autonomy ladder** (`Account.autonomyLevel`):

- **Observe** — every proposal intercepted before any gate; logged as a pending approval for user review. Zero autonomous execution.
- **Propose** — all gates run. If approved, the trade routes to the approval queue (not the broker) with reason `PROPOSE_MODE_REQUIRES_APPROVAL`. Real rail rejections still fire.
- **Auto** — today's behaviour. Governor's native approve/reject stands; only mandate-escalated decisions queue.

**Approval queue** at `/approvals` with per-item cards: Approve re-dispatches the trade through the gate with `bypassAutonomyLadder=true` (re-checks fresh — MOS at 5pm may differ from 9am); Reject stores an optional note for the agent to read next run. Items expire after 24h via a sweep that runs at the top of every scheduler tick. Home dashboard shows a pending-count banner linking to the queue.

**Your Plan** (`/onboarding`) — one-time setup capturing `timeHorizonYears`, `planningAssumption` (% /yr — *a planning input, not a forecast*), `maxPositionPct`, `drawdownPauseThresholdPct`, `autonomyLevel`, `forbiddenSectors[]`, `forbiddenSymbols[]`. Middleware-level redirect routes first-time users here before they can reach the trading surface. A "Your Plan" card on the home dashboard summarises the chosen values.

---

## Strategies (6 presets + custom)

Each has a deterministic rulebook consumed by both the live agent and the backtester:

| Preset | Bet | Default style |
|---|---|---|
| Buffett Core | Wide moat + decent ROE + reasonable P/E | Balanced, holding-period 'long' |
| Deep Value (Graham) | Statistical cheapness | Mean-reversion exits at +30%, 2yr time stop |
| Quality Compounders | Pay for quality | Low turnover, "hold forever" |
| Dividend Growth | 25yr Aristocrat streak | Sell only on dividend cut |
| Boglehead Index | Three-fund passivity | Quarterly rebalance to target weights |
| Burry Deep Research | Ick + deep fundamentals | Higher concentration (20% max), 240-min cadence |

- **Stable `presetKey` column** for identification (no more user-rename breaks)
- **Strategy wizard** chat at `/strategy/[id]` lets you refine rules collaboratively
- One active at a time; Activate button flips via atomic `UPDATE ... SET isActive=(id=$1)`
- Each card carries: Burrybot guest toggle · Form Hypothesis button · Ask Burrybot chat · hypothesis-count link back to /brain

---

## Backtesting

- **Single run** at `/backtest` — pick strategy + date window + universe, see equity curve vs SPY, full event log, data warnings
- **Robustness grid** at `/backtest/grid` — every strategy × every named window (2008 GFC, 2020 COVID, 2022 bear, etc.) with overlay chart
- **Two tiers**:
  - Tier 1 — classic deterministic rules only (original behaviour)
  - Tier 2 — additionally screens universe by point-in-time EDGAR fundamentals at each decision date
- **EDGAR fundamentals pipeline** (`historical-fundamentals.ts`): pulls `companyfacts` JSON, duration-aware classifier for quarters vs annuals, union-synonym tags (JNJ switched us-gaap tags across years), Visa fiscal-year forward-fill for off-calendar filers, backfills into `StockFundamentalsSnapshot` per symbol
- **Anti-look-ahead**: snapshots stamped with EDGAR `filed` date, point-in-time lookup via `asOfDate <= decisionDate`, per-day price bucket cache
- **Per-sim cache scoping** prevents parallel grid cells from racing
- **Regime detector** replicated in backtest (SPY-based: calm / elevated / crisis / recovery)
- **Honest no-data semantics** — emits `data_warning` events for missing day-0 prices, late-start symbols, no-bars universes; UI banner surfaces them

---

## Crypto module

- **Rule-based DCA only** — no LLM. Deterministic scheduler buys coins at user-set percentages on user-set cadence
- **Portfolio cap** (%, default 10%) — ceiling on total crypto as % of whole portfolio. DCA scales or skips to stay under
- **Per-coin target allocations** (e.g. 50% BTC, 30% ETH, 20% SOL) — drift rebalances
- **Separate daily-trade cap** from stock so DCA legs don't eat the agent's budget
- **Master toggle** — turning off preserves config but halts all activity; no positions sold on disable

---

## Wallet + deposits

- **Two-bucket model**: active cash (agent-spendable) + wallet balance (parked, off-limits to agent)
- **Instant + free transfers** between buckets via /wallet
- **Deposits** with idempotency key (safe for network retries), soft-confirm on ≥$1,000 (casino-budget framing from disclaimer)
- **Paper-trading** — no real ACH; `Deposit` and transfer rows are record-keeping only

---

## Analytics

- **Performance chart** (1D / 1W / 1M / all) vs SPY
- **Trade history** with realized P&L, closed positions list
- **Drawdown timeline**
- **Decision log** — browsable per agent run, shows every tool call with truncation markers
- **Mood rings** on home (Market mood 8 states · Agent mood 7 states) with expandable "why this mood" explainer

---

## UI surfaces (15 routes)

- `/` — Home dashboard (equity, mood rings, positions, recent agent runs, "Your Plan" card, pending-approvals + budget-warning banners, overdue-scheduler diagnostic)
- `/onboarding` — one-time Plan wizard; middleware-level redirect gates first-time users until completed
- `/approvals` — pending-approval queue with Approve / Reject actions per card
- `/trades` — trade history with manual sell capability
- `/strategy` — 3 tabs (Strategy list / Meetings / Back-testing)
- `/strategy/[id]` — wizard chat for one strategy
- `/brain` — firm memory with category filters + sync button
- `/settings` — all safety/trading/crypto settings + API keys + session + API cost-governor budget
- `/wallet` — deposits + transfers
- `/analytics` — deeper performance + attribution
- `/backtest`, `/backtest/grid` — single + grid simulation
- `/candidates` — Tier-2 screener output awaiting user promote/reject
- `/help` — 12-section static docs
- `/disclaimer` — full legal framing
- `/crypto` — DCA config + coin allocations

Bottom nav: Home · Trades · Strategy · Brain · Settings (5 tabs, iOS-optimized)

---

## Observability + admin

- **Structured JSON logger** (info default in prod, debug in dev). Key events: agent.run.start/end/tool_error, meeting.completed/comic_result/comic_failed_trigger, safety.kill_switch_applied, tick.start/end, policy_change.applied
- **Health endpoint** (`/api/health`) with lazy scheduler boot
- **Scheduler status** (`/api/scheduler/status`) exposing tick count, last run, env-var presence flags
- **AuditLog** table for credential changes + policy-change accept/reject
- **Rate-limit buckets**: `agents.run` (10/hr), `burry.hypothesis` (3/hr), `burry.chat` (30/hr), `meetings.comic` (10/hr), `analyzer` (60/min), `strategy.wizard` (20/min), `candidates.wizard` (6/hr), `default` (120/min)
- **Upstash Redis** for distributed rate-limit; falls back to in-memory with loud warning if not configured

---

## Testing

- **Vitest** suite, colocated `*.test.ts` files next to source, `node` environment
- **313 passing tests across 29 files, full suite runs in ~4s**
- `npm test` (watch) · `npm run test:run` (one-shot) · `npm run test:ci` (with v8 coverage)
- **Phase 1 — pure-function coverage** (shipped):
  - **Pricing math** (`pricing.test.ts`) — cache-aware cost per model tier (Opus/Sonnet/Haiku), env-var rate overrides, unknown-model → 0, rounding
  - **Schema validation** (`agents/schemas.test.ts`) — PlaceTradeInput with buy-specific MOS `superRefine` (buy requires IV + MOS; sell flexible); SizePositionInput; UpdateStockFundamentalsInput bounds
  - **Brain taxonomy** (`brain/taxonomy.test.ts`) — `BRAIN_KIND_VALUES` derived from map keys (no drift), canonical mappings pinned, agent-taxonomy never promotes to principle/canonical, prompt-builder completeness
  - **Backtest rules** (`backtest/rules.test.ts`) — every `StrategyKey` produces a ruleset, Burry empty-ruleset pinned (cash-drag regression guard), dividend_growth absent `minDividendYieldPct` pinned (un-evaluable-filter guard), Boglehead target weights sum to 1.0, ruleset shape invariants
  - **Starter library integrity** (`brain/starter-library/index.test.ts`) — no duplicate `(kind, slug)` pairs (upsert collision), every kind known to taxonomy, `STARTER_BRAIN_MARKER_SLUG` present (`isBrainSeeded` guard), presetKey uniqueness, Burry-tagged doctrine exists
  - **Cost-summary drag math** (`meetings/cost-summary.test.ts`) — canonical $39.37/wk × $100.1k × 30% → 6.82% drag-on-target math pinned, division-by-zero guards, monotonicity invariants
  - **Cross-cutting concerns** (`api.test.ts`, `ratelimit.test.ts`, `logger.test.ts`, `money.test.ts`, `time.test.ts`, `analyzer.test.ts`, `strategy-diff.test.ts`, `data/sec-edgar.test.ts`) — cron-secret auth, bucket isolation + windowing, log level filtering, currency formatting, ET time helpers, analyzer verdict shape, strategy diff renderer, EDGAR XBRL parsing
- **Mutation-verified** — four deliberate regressions were reintroduced and confirmed caught: Burry rotation rules, dividend yield filter, MOS superRefine removal, drag-math formula error
- **Phase 2 — property tests (shipped, fast-check)**:
  - **`classifyRailVerdict` state machine** (`safety/rails.test.ts`) — extracted pure function (the I/O-coupled `checkKillSwitches` delegates to it) with generative coverage of enable/disable, priority ordering (`daily_loss` > `drawdown` > `data_unavailable`), fail-CLOSED on Alpaca outage, "first trigger wins"
  - **Fundamentals parser** (`backtest/historical-fundamentals.test.ts`) — `durationDays` round-trip, classifier disjointness + boundary drift guard (80-100 / 350-380 days), `rollingTTM` forward-fill pinned via Visa / off-calendar-filer scenario
  - **Point-in-time cache key** (`backtest/point-in-time.test.ts`) — determinism, per-scope isolation (pins the parallel-grid-cell fix), price-bucket rounding
  - **Rate-limit bucket meta-test** (`ratelimit.buckets.test.ts`) — static scan of every `checkLimit()` call site in `src/` asserting the bucket is in the declared union; a typo now fails CI rather than silently bypassing rate limits
  - **PlaceTradeInput superRefine** (`agents/schemas.property.test.ts`) — generative coverage of the buy-side IV + MOS gate; any buy missing either field is rejected, sells pass without them
- **Sprint 1 coverage — Governor + autonomy + approval queue (shipped)**:
  - **Reason-code module** (`safety/reason-codes.test.ts`) — enum ↔ render map completeness (no orphan codes), template smoke tests for every code, length ceiling, determinism
  - **Autonomy helpers** (`safety/autonomy.test.ts`) — 3-level ladder, parser fallback to 'auto' on garbage input, label/description tables cover every level
  - **Pending approval factory** (`safety/pending-approval.test.ts`) — atomic Governor-decision + approval-row write, TTL defaults, bigint field persistence, governor-version stamping
  - **Expiry sweep** (`safety/approval-sweep.test.ts`) — pending → expired with `resolvedBy='timeout'`, swallows DB errors to never block the tick
  - **Cost-budget classifier** (`safety/budget.test.ts`) — `classifyBudgetState` with property-based monotonicity, UTC month boundary
  - **API handlers** (`src/app/api/**/*.test.ts`) — GET `/api/approvals` filters + BigInt serialisation · POST `/api/approvals/[id]/approve` with idempotency (404/403/409/410) + `runTool` dispatch with `bypassAutonomyLadder=true` · POST `/api/approvals/[id]/reject` with state-machine guards · POST `/api/onboarding` validation + forbidden-list normalisation · POST `/api/settings/budget` with nullable-cap semantics
- **Scoped but not yet shipped**:
  - **Phase 3** — integration tests with a test DB (`seedBrainForUser` idempotency, `backfillBrainTaxonomy`, `writeBrain` validation, policy-change apply boundary, AgentRun stale-sweep, daily-cap exclusion, cascade FK chain)
  - **Phase 4** — chaos tests with mocked externals (Alpaca/Anthropic/OpenAI/EDGAR failure modes)
  - **Playwright E2E on the money path** — browser-level verification of the sign-up → wizard → agent run → proposal → approval → fill flow. Deferred; covered at the API layer by the Sprint 1 handler tests above.
- No UI/component tests — deliberate scope choice for a mobile-first app; Vitest node-environment focuses on the pure logic + HTTP handlers that matter

---

## What's aspirational / known gaps (honest)

- **Real ACH in/out** — flagged "coming when live"
- **Crypto send/receive** — same
- **No subscription/pricing tier** — BYOK + paper-trading means no revenue path yet
- **Comic storage inline base64** — meetings carry ~2MB comic data URLs; should be R2/S3 at scale. Deferred until object storage is provisioned.
- **Playwright E2E** — browser-level money-path smoke test. Sprint 1 ships handler-level Vitest coverage instead; full E2E is a follow-up when CI + test-infra land.
- **Mandate sector-level enforcement** — `forbiddenSectors[]` is captured at onboarding but not yet enforced at trade time (no reliable per-symbol sector source). `forbiddenSymbols[]` is fully wired through the Governor.
- **Onboarding wizard screen-per-question polish** — v1 ships a single-screen mobile-scrollable form; the proposal called for 7-9 screens with progressive disclosure. The schema + flow + governor integration ship; the UX polish is follow-up.
- **Some meeting prompt tuning** — agents occasionally over-fixate on cost when it's only marginally material

---

**TL;DR**: Value-investing paper-trading app that treats itself as a five-to-six-bot "firm" with institutional memory, weekly exec meetings rendered as Mad Magazine comics, a **Governor-routed defense-in-depth trade gate** with structured reason codes + audit trail, a **three-level autonomy ladder** (Observe / Propose / Auto) feeding a **user approval queue**, a **BYOK API cost-governor** that pauses the agent before surprise bills, a **Your Plan onboarding wizard** every user must complete before trading, six preset strategies + a custom wizard, point-in-time-fundamentals backtesting, rule-based crypto DCA, BYOK on every model provider, a growing brain library you resync from the repo, and a **313-test mutation-verified Vitest suite** (property tests + HTTP handler tests) pinning the critical behaviour invariants.
