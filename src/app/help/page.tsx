// Static help + docs page. Anchor-navigable, mobile-first, no LLM.
// Content lives as TSX (not markdown) so it's dev-maintainable, type-
// checked, and doesn't need a runtime markdown dependency. Each section
// has a stable id for deep-linking from settings tooltips or external
// references (e.g. /help#crypto-cap).
//
// Organising principle: answer the questions a consumer user would
// actually ask, in the order they'd ask them. Safety rails FIRST
// because capital preservation is AgBro's whole point.

import Link from 'next/link';

export const metadata = {
  title: 'Help · AgBro',
  description: 'How AgBro works, what every setting does, and how to fix the common issues.',
};

type Section = { id: string; title: string };

const TOC: Section[] = [
  { id: 'getting-started', title: 'Getting started' },
  { id: 'safety-rails', title: 'Safety rails' },
  { id: 'kill-switch', title: 'Kill switch — what to do' },
  { id: 'trading-rules', title: 'Trading rules & schedule' },
  { id: 'crypto', title: 'Crypto module' },
  { id: 'strategies', title: 'Strategies & wizard' },
  { id: 'burrybot', title: 'Burrybot (deep-research analyst)' },
  { id: 'meetings', title: 'Executive meetings' },
  { id: 'brain', title: 'Brain (firm memory)' },
  { id: 'api-keys', title: 'API keys (BYOK)' },
  { id: 'wallet', title: 'Wallet & deposits' },
  { id: 'troubleshooting', title: 'Troubleshooting' },
];

export default function HelpPage() {
  return (
    <div className="flex flex-col gap-5 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-semibold">Help &amp; docs</h1>
        <p className="mt-1 text-xs text-ink-400">
          What every setting does, how the agent behaves, and how to fix the
          things that commonly break. Tap a section below to jump.
        </p>
      </header>

      <nav className="card">
        <p className="mb-2 text-[10px] uppercase tracking-[0.1em] text-ink-400">
          Contents
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {TOC.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="text-brand-400 hover:underline">
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="getting-started" title="Getting started">
        <P>
          AgBro is an agentic value-investing brokerage. An LLM agent wakes up
          on a schedule, reads a persistent firm &ldquo;brain&rdquo; of
          principles + checklists + past decisions, looks at your positions,
          and decides whether to act or hold.
        </P>
        <P>
          <strong>It runs against Alpaca paper trading by default.</strong>{' '}
          Every &ldquo;trade&rdquo; is simulated — no real money at risk. The
          disclaimer page has the full legal framing.
        </P>
        <P className="font-semibold">Day-1 setup, in order:</P>
        <Ol>
          <li>
            Add an <strong>Anthropic API key</strong> in Settings → API keys.
            This is required — the agent can&apos;t run without it.
          </li>
          <li>
            <strong>Deposit</strong> a paper principal via Settings → Principal
            or the wallet page. Start small — $1,000 is plenty to test.
          </li>
          <li>
            Review <strong>Safety rails</strong> (next section). These are the
            halt thresholds. Default values are conservative; tune once you
            understand the tradeoffs.
          </li>
          <li>
            Pick a <strong>Strategy</strong> — Buffett Core is the default.
            Five other presets are available on /strategy; activate one if it
            matches your style better.
          </li>
          <li>
            Wait. The agent wakes every ~120 minutes by default and logs
            every decision on the Home page and /brain.
          </li>
        </Ol>
      </Section>

      <Section id="safety-rails" title="Safety rails">
        <P>
          Rails are hard-halt thresholds that run <em>above</em> the strategy
          rules. When any trips, the agent pauses immediately. You review and
          manually resume.
        </P>

        <SubHead>Daily loss kill (%)</SubHead>
        <P>
          Pause if today&apos;s equity drops by this much from the day&apos;s
          open. Negative number — <code>-5</code> means halt at a 5% daily
          loss. <code>0</code> disables the check. Default: <code>-5</code>.
          Uses the Alpaca portfolio-history feed so the trigger matches what
          you see on the home chart.
        </P>

        <SubHead>30-day drawdown pause (%)</SubHead>
        <P>
          Pause if equity sits at this much below the 30-day peak. Also
          negative — <code>-15</code> means halt at a 15% drawdown from peak.
          Catches grinding declines that the daily check misses.
        </P>

        <SubHead>Max trade notional (USD)</SubHead>
        <P>
          Hard ceiling on any single buy, regardless of position-size math.
          Protects against a bad price fetch or runaway sizing. Default:
          $5,000. The agent cannot submit a buy that would exceed this,
          full stop.
        </P>

        <SubHead>Allow meeting-proposed setting changes</SubHead>
        <P>
          When on, executive meetings can propose changes to the rails +
          cadence + expected return; you still click Accept to apply. When
          off, proposals are recorded for audit but can&apos;t be applied.
          API keys, identity, and deposits are ALWAYS off-limits regardless.
        </P>
      </Section>

      <Section id="kill-switch" title="Kill switch — what to do when it trips">
        <P>
          A kill-switch trip means a rail fired: daily loss, 30-day drawdown,
          or a data-unavailable transient (skips a tick without persisting a
          trip). The account is paused. The home page shows a banner with the
          reason.
        </P>
        <Ol>
          <li>
            <strong>Read the reason.</strong> Banner on Home + detail on
            Settings → Safety rails. Persistent trips show the original
            trigger timestamp.
          </li>
          <li>
            <strong>Investigate.</strong> Check the portfolio chart,
            /analytics, and the last few agent runs on Home. Was the loss
            real or a data hiccup?
          </li>
          <li>
            <strong>Clear &amp; resume</strong> from Settings → Safety rails
            when ready. The clear is manual and deliberate — we do not
            auto-resume.
          </li>
        </Ol>
        <P>
          The agent will NOT trade while the kill switch is active, even if
          you click &ldquo;Run now&rdquo; manually. Clearing is the only way
          to resume.
        </P>
      </Section>

      <Section id="trading-rules" title="Trading rules & schedule">
        <P>
          These are the levers the agent respects every wake-up. Changing any
          of these takes effect on the NEXT wake.
        </P>

        <SubHead>Max position %</SubHead>
        <P>
          Single position cap as percent of total equity. If a held name
          grows past this, the exit evaluator flags it for a trim. Default:
          10%.
        </P>

        <SubHead>Min cash reserve %</SubHead>
        <P>
          Floor on cash as percent of total equity. The agent cannot deploy
          below this. Default: 15%.
        </P>

        <SubHead>Max daily trades (stock)</SubHead>
        <P>
          Ceiling on agent-driven stock trades per ET day. Rejected /
          cancelled orders don&apos;t count against this — only live orders
          (pending, submitted, filled) consume the budget. Default: 3.
          Crypto has its own separate cap.
        </P>

        <SubHead>Expected annual return (%)</SubHead>
        <P>
          Your target gain. The agent calibrates aggressiveness to this —
          higher target = willingness to accept higher P/E, lower MOS. Cap is
          60%. Safety rails still apply regardless.
        </P>

        <SubHead>Risk tolerance</SubHead>
        <P>
          Conservative / Moderate / Aggressive. Coarse-grained style dial —
          interacts with expected-return to shape position sizing + MOS
          requirements.
        </P>

        <SubHead>Agent cadence (min)</SubHead>
        <P>
          Minutes between wake-ups. 120 is the default. Shorter = more
          responsive but more cost; longer = cheaper but slower to react.
          Market regime shifts (crash-like SPY moves) force a wake
          regardless of cadence.
        </P>

        <SubHead>Trading hours</SubHead>
        <P>
          Start/end in ET. Wakes outside these hours skip trade execution
          but still run analysis + brain updates. Default: 09:30 → 16:00.
        </P>

        <SubHead>Allow day trades</SubHead>
        <P>
          Off by default. Value investing doesn&apos;t require day trading.
          Only flip on if you&apos;re deliberately experimenting.
        </P>
      </Section>

      <Section id="crypto" title="Crypto module">
        <P>
          Crypto is a rule-based DCA engine — NOT an LLM decision. When
          enabled, a deterministic scheduler buys the coins + percentages
          you set on /crypto, on the cadence you set. No agent reasoning,
          no surprise trades.
        </P>

        <SubHead id="crypto-cap">Crypto portfolio cap (% of total)</SubHead>
        <P>
          This is the <strong>ceiling</strong>, not the target. Total crypto
          exposure (all coins combined, at market value) can never exceed
          this percentage of your whole portfolio (stocks + options +
          crypto). When hit, DCA scales down or skips; rebalance buys scale
          to fit; sells always proceed. Default: 10% keeps crypto as a
          small asymmetric satellite. Settings → Safety rails area.
        </P>

        <SubHead>DCA amount + cadence</SubHead>
        <P>
          Lives on the /crypto page. &ldquo;How much to buy each week&rdquo;
          is a <em>flow</em>, not a ceiling — it interacts with the cap:
          if buying would push you over, the DCA scales or skips.
        </P>

        <SubHead>Enable / disable the whole module</SubHead>
        <P>
          Settings → &ldquo;Enable crypto module (rule-based DCA only).&rdquo;
          Turning off preserves your config but stops all DCA activity. No
          existing positions are sold on disable — just no new buys.
        </P>
      </Section>

      <Section id="strategies" title="Strategies & wizard">
        <P>
          A strategy is the ruleset the agent trades against: sector
          allowlists, P/E caps, moat requirements, MOS floors, etc. AgBro
          ships with six presets:
        </P>
        <Ul>
          <li>
            <strong>Buffett Core</strong> — balanced value-quality default.
          </li>
          <li>
            <strong>Deep Value (Graham)</strong> — statistically cheap,
            mean-reversion exits.
          </li>
          <li>
            <strong>Quality Compounders</strong> — pay for moats, hold
            forever.
          </li>
          <li>
            <strong>Dividend Growth</strong> — Aristocrats only, income
            first.
          </li>
          <li>
            <strong>Boglehead Index</strong> — three-fund, rebalance, do
            nothing.
          </li>
          <li>
            <strong>Burry Deep Research</strong> — contrarian deep-value
            with ick focus. See Burrybot section below.
          </li>
        </Ul>
        <P>
          One strategy is active at a time. Switch on /strategy by tapping
          &ldquo;Activate&rdquo; on any archived card. The agent respects
          the active strategy&apos;s rules on the NEXT wake.
        </P>
        <SubHead>Strategy wizard</SubHead>
        <P>
          &ldquo;Open wizard&rdquo; on a strategy card launches a chat-based
          refinement session. Use this to customise a preset or build one
          from scratch. The wizard can edit rules; it cannot activate or
          delete a strategy.
        </P>
      </Section>

      <Section id="burrybot" title="Burrybot (deep-research analyst)">
        <P>
          Burrybot is a satirical -bot character — a Michael Burry-style
          contrarian deep-research analyst. He has two modes:
        </P>
        <SubHead>Guest analyst</SubHead>
        <P>
          Per-strategy toggle on every strategy card. When on, Burrybot
          joins that firm&apos;s executive meetings as a 6th voice. He
          speaks ≤3 times, always citing a specific filing / number.
          He cannot drive the final decision or propose policy changes —
          he&apos;s a respected new hire, not a principal.
        </P>
        <SubHead>His own firm</SubHead>
        <P>
          Activate the &ldquo;Burry Deep Research&rdquo; strategy and he
          becomes the principal. Meetings rotate to his cast; his rules
          de-emphasise P/E and lead with cash flow + EV/EBITDA.
        </P>
        <SubHead>Form hypothesis (one-shot)</SubHead>
        <P>
          When Burrybot is first enabled on a strategy, a &ldquo;Form
          hypothesis&rdquo; button appears on the card. One click runs a
          bounded Opus research session (~$0.20–0.40) that writes 5-10
          hypothesis brain entries tailored to that firm&apos;s rules,
          positions, and Burrybot&apos;s doctrine. The button disappears
          after a successful run; hypotheses appear on /brain under the
          Hypothesis category filter.
        </P>
        <SubHead>Ask Burrybot (chat)</SubHead>
        <P>
          Inline chat on every card where Burrybot is enabled. Ask specific
          questions grounded in filings or macro. He answers from the
          firm&apos;s rules, current positions, market regime, his seeded
          doctrine, and his active hypotheses. Not a trading tool — chat
          is for thinking, not ordering.
        </P>
        <P className="text-ink-400 text-[11px]">
          Cost: ~$0.05–0.20 per turn, billed to your Anthropic key.
          Rate-limited to 30 turns/hour.
        </P>
      </Section>

      <Section id="meetings" title="Executive meetings">
        <P>
          The firm runs weekly executive meetings (Friday 4pm ET, auto-cron)
          where five -bot characters review the week, make decisions, and
          file an agenda for the next. You can also run impromptu meetings
          from /strategy → Meetings tab.
        </P>
        <SubHead>Action items</SubHead>
        <P>
          Items flagged as &ldquo;research&rdquo; or &ldquo;review_position&rdquo;
          auto-queue for the agent&apos;s next wake while their status is
          &ldquo;started&rdquo;. Mark on_hold to pause; completed to retire.
          No separate &ldquo;Execute now&rdquo; button — status IS the lever.
        </P>
        <SubHead>Policy changes</SubHead>
        <P>
          Meetings may propose adjustments to safety rails, cadence, or
          expected return. These appear as Accept / Reject cards above the
          action-items list. Nothing applies until you accept. Proposal
          bounds are server-enforced — an out-of-range proposal is rejected
          with a clear reason.
        </P>
        <SubHead>Comic strips (opt-in)</SubHead>
        <P>
          Add an OpenAI API key in Settings and every meeting renders as a
          Mad Magazine-style editorial comic dramatising the turning-point
          scene. ~$0.05 per comic, billed to your OpenAI account.
        </P>
        <SubHead>Reset history</SubHead>
        <P>
          Two-click &ldquo;Reset meeting history&rdquo; button at the bottom
          of the Meetings tab — wipes meetings + action items + proposed
          changes for a fresh start. Does NOT touch brain entries, trades,
          or strategies.
        </P>
      </Section>

      <Section id="brain" title="Brain (firm memory)">
        <P>
          The brain is AgBro&apos;s persistent institutional memory. Every
          entry has two axes:
        </P>
        <SubHead>Category (what kind of knowledge)</SubHead>
        <Ul>
          <li>
            <strong>principle</strong> — immutable doctrine (Buffett rules,
            firm charter).
          </li>
          <li>
            <strong>playbook</strong> — reusable procedures (pre-trade
            checklist, crisis response, biases to resist).
          </li>
          <li>
            <strong>reference</strong> — domain knowledge (sector primers,
            case studies).
          </li>
          <li>
            <strong>memory</strong> — lived experience (run summaries,
            post-mortems, weekly updates, research notes).
          </li>
          <li>
            <strong>hypothesis</strong> — active bets under test.
          </li>
          <li>
            <strong>note</strong> — user-written freeform.
          </li>
        </Ul>
        <SubHead>Confidence</SubHead>
        <P>
          canonical &gt; high &gt; medium &gt; low. Canonical is reserved
          for seeded firm doctrine. Agent-written entries default to medium.
          An entry can be superseded — future reads skip it by default, but
          it stays for audit.
        </P>
        <SubHead>Library sync</SubHead>
        <P>
          AgBro ships with a starter library (37+ principles, playbooks,
          case studies). The ↻ Sync button on /brain pulls in library
          updates — new crisis playbooks, new case studies, new Burrybot
          doctrine. Safe to run anytime; idempotent.
        </P>
      </Section>

      <Section id="api-keys" title="API keys (BYOK)">
        <P>
          You bring your own keys. AgBro encrypts them at rest with
          AES-256-GCM (per-record IV) and never logs values. Keys are
          stored per-user; an operator with DB access still can&apos;t
          decrypt them without the encryption master key.
        </P>
        <Ul>
          <li>
            <strong>Anthropic</strong> — required. Agent + meetings +
            Burrybot all use it.
          </li>
          <li>
            <strong>OpenAI</strong> — optional. Used for meeting comic
            generation. Meetings work without it; comics just don&apos;t
            render.
          </li>
          <li>
            <strong>Perplexity</strong> — optional. Agent research tool;
            falls back to Google + synthesis if absent.
          </li>
          <li>
            <strong>Google Custom Search</strong> — optional. Same research
            fallback chain.
          </li>
        </Ul>
        <P>
          Add / rotate keys in Settings → API keys. Removing a key is
          instant; the agent discovers its absence on the next tool call
          and degrades gracefully.
        </P>
      </Section>

      <Section id="wallet" title="Wallet & deposits">
        <P>
          AgBro separates <strong>active cash</strong> (what the agent can
          spend) from <strong>wallet balance</strong> (parked, unavailable
          for trades). Transfers between them are instant + free.
        </P>
        <SubHead>Depositing</SubHead>
        <P>
          Settings → Principal or the Wallet page. Deposits &gt; $1,000 ask
          for confirmation (casino-budget framing — paper trading or not,
          the number anchors the agent&apos;s decisions). All deposits
          land in active cash by default.
        </P>
        <SubHead>Moving money to the wallet</SubHead>
        <P>
          Want to keep some principal out of the agent&apos;s reach?
          Transfer from active → wallet on the /wallet page. The agent
          cannot draw from wallet balance even if safety rails allow it.
        </P>
        <SubHead>Withdrawals</SubHead>
        <P>
          Paper-trading: there&apos;s no real money to withdraw. The
          wallet&apos;s &ldquo;transfer out&rdquo; is a record-keeping
          operation only. Real ACH + crypto send/receive are marked
          &ldquo;coming when you go live&rdquo;.
        </P>
      </Section>

      <Section id="troubleshooting" title="Troubleshooting">
        <SubHead>Kill switch tripped — what now?</SubHead>
        <P>See the &ldquo;Kill switch&rdquo; section above.</P>

        <SubHead>Credential save fails with AGBRO_CREDENTIAL_ENCRYPTION_KEY_MISSING</SubHead>
        <P>
          The deployment is missing the encryption master key env var. The
          operator sets this once at deploy time; it&apos;s not something
          you fix from the app. Flag it.
        </P>

        <SubHead>Meeting comic didn&apos;t generate</SubHead>
        <P>
          Most common: no OpenAI key saved. Settings → API keys. The
          meeting card will show the specific reason (&ldquo;No OpenAI
          key saved…&rdquo; or &ldquo;openai image 401: invalid key&rdquo;
          etc.) so you can see which rail tripped. Manually retry with
          the &ldquo;Generate comic&rdquo; button on the meeting card.
        </P>

        <SubHead>Form Hypothesis button reappeared after I ran it</SubHead>
        <P>
          You&apos;re viewing a different strategy&apos;s card than the
          one you originally ran it on. Hypotheses are scoped per-strategy.
          Look for the &ldquo;View N Burrybot hypotheses →&rdquo; link that
          appears on the card where they actually live; it links to the
          /brain Hypothesis filter.
        </P>

        <SubHead>Ask Burrybot says there are no hypotheses</SubHead>
        <P>
          Fixed in a recent update — the chat now pulls any Burrybot-
          authored hypothesis regardless of which strategy&apos;s chat
          you opened. If you still see the denial, redeploy + ask again.
        </P>

        <SubHead>&ldquo;Strategies added since last sync&rdquo; banner on /strategy</SubHead>
        <P>
          The starter library has new strategy presets not yet in your
          archive. Click &ldquo;Pull in&rdquo; on the banner. Same endpoint
          as /brain → Sync.
        </P>
      </Section>

      <p className="text-center text-[11px] text-ink-500">
        Missing something? Tell the operator. This page is static and
        dev-maintained.
      </p>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="card flex flex-col gap-2 scroll-mt-16">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
      <p className="mt-1">
        <Link href="#" className="text-[10px] text-ink-500 hover:text-ink-300">
          ↑ back to top
        </Link>
      </p>
    </section>
  );
}

function SubHead({
  id,
  children,
}: {
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <h3 id={id} className="mt-2 text-sm font-semibold text-ink-100 scroll-mt-16">
      {children}
    </h3>
  );
}

function P({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={`text-sm text-ink-200 leading-relaxed ${className}`}>
      {children}
    </p>
  );
}

function Ul({ children }: { children: React.ReactNode }) {
  return (
    <ul className="list-disc pl-5 text-sm text-ink-200 leading-relaxed space-y-1">
      {children}
    </ul>
  );
}

function Ol({ children }: { children: React.ReactNode }) {
  return (
    <ol className="list-decimal pl-5 text-sm text-ink-200 leading-relaxed space-y-1">
      {children}
    </ol>
  );
}
