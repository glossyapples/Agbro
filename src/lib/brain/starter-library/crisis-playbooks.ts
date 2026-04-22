// Historical crisis case studies, written for the agent to read when the
// market regime transitions away from 'calm'. Each playbook covers:
//   1. What actually happened (terse, factual)
//   2. What each value-investing school DID (not what they should have —
//      what the actual humans actually executed)
//   3. The durable lesson
//
// Purpose: give the agent a concrete reasoning anchor during a drawdown
// so it doesn't improvise its way into either panic-selling or
// heroically-catching-falling-knives. Reading these entries is required
// by the prompt when regime != 'calm'.

import type { BrainSeed } from './types';

export const CRISIS_PLAYBOOKS: BrainSeed[] = [
  {
    slug: 'black-monday-1987',
    kind: 'crisis_playbook',
    title: '1987 Black Monday — one-day -22% on S&P',
    body: `TRIGGER: Oct 19, 1987. Dow -22.6% in a single session. No
specific news catalyst — portfolio insurance feedback loop + program
trading cascade. VIX didn't exist yet but volatility was historic.

WHAT EACH SCHOOL DID:

- BUFFETT: Berkshire held through. Didn't buy meaningfully on the day —
  Buffett said later "it took me a while to recognize the opportunity."
  Started adding to existing positions in the weeks following once
  prices stabilized. His rule: don't try to catch the bottom, wait for
  the dust to settle and buy from a stable base.

- GRAHAM SCHOOL (still active via Walter Schloss, Irving Kahn): bought
  aggressively on the Friday before and the Monday itself. Several of
  these operators had their best years in 1988.

- QUALITY COMPOUNDERS: the trade was "don't sell what you understand."
  Nothing fundamentally changed about Coca-Cola, Gillette, or Washington
  Post in one day. Holders who panicked-sold locked in the loss;
  holders who held were whole within 18 months.

LESSON: a one-day move, however extreme, doesn't change the underlying
businesses. Your job is to verify the thesis hasn't broken, NOT to
predict the next day's move. If you wouldn't sell today's business
yesterday at a 22% higher price, don't sell it today — the business
is the same, only the quote changed.`,
    tags: ['seed', 'crisis', '1987', 'volatility'],
  },
  {
    slug: 'dot-com-bust-2000-2002',
    kind: 'crisis_playbook',
    title: '2000–2002 Dot-Com Bust — slow-motion Nasdaq -78%',
    body: `TRIGGER: March 2000 Nasdaq peak. 30+ months of grinding
decline, not one big day. Classic bubble unwind: speculative tech traded
at infinite multiples, ran out of greater fools, reverted violently.

WHAT EACH SCHOOL DID:

- BUFFETT: had been publicly skeptical for years ("I would rather be
  certain of a good result than merely hopeful of a great one"). Owned
  basically zero tech. Berkshire UNDERPERFORMED wildly through 1999 —
  people called him washed up. Then outperformed by 40%+ during the
  crash. Famously bought nothing in the peak years; deployed
  aggressively 2001-2003 into the wreckage (ConocoPhillips, PetroChina
  later).

- GRAHAM SCHOOL: had a field day. Old-economy value names were trading
  at single-digit P/Es while tech imploded. Seth Klarman, Tweedy
  Browne, and similar shops posted double-digit returns in 2000-2002.

- QUALITY COMPOUNDERS: held. Coca-Cola, Gillette, WaPo didn't suffer
  much — the bubble was Nasdaq-concentrated. Compounder holders who
  stayed disciplined were rewarded.

LESSON: bubbles can persist for years before popping. "Wait for the
right pitch" (Buffett) beats "participate because everyone else is."
During the unwind: buy the names that WEREN'T in the bubble at
newly-reasonable prices. The wreckage isn't always where the best
opportunities are — sometimes it's in what the bubble ignored.`,
    tags: ['seed', 'crisis', '2000', 'bubble'],
  },
  {
    slug: 'gfc-2008-2009',
    kind: 'crisis_playbook',
    title: '2008 Global Financial Crisis — S&P -57% peak to trough',
    body: `TRIGGER: Sept 2008 Lehman collapse. Multi-month cascade Oct
2007 to March 2009. VIX hit 80. S&P 500 -57% peak to trough. Housing +
credit + bank solvency all in doubt simultaneously.

WHAT EACH SCHOOL DID:

- BUFFETT: published "Buy American. I Am." NYT op-ed in Oct 2008 — but
  his actual moves were preferred-stock deals with downside protection:
  $5B Goldman Sachs preferred at 10% dividend + warrants; $3B GE
  preferred at 10% + warrants. He didn't buy common stock of
  distressed banks. He got INCOME with OPTIONALITY, not principal at
  risk. The famous op-ed said "gradually" — he wasn't all-in at the
  bottom.

- GRAHAM SCHOOL: the decade's generational opportunity. Seth Klarman's
  Baupost raised cash aggressively in 2007, deployed into 2008-2009
  distress. Multiple books (Montier, Browne) document net-nets and
  below-book-value names everywhere.

- QUALITY COMPOUNDERS: Munger bought Wells Fargo heavily during the
  crash. His reasoning: "If you can't stomach 50% declines in your
  investment you will get the mediocre returns you deserve." He held
  through and added. Quality names paid dividends throughout.

- DIVIDEND GROWTH: a disaster for anyone concentrated in financials —
  major dividend suspensions (Bank of America, GE, Citigroup). Those
  diversified outside financials (consumer staples, healthcare) mostly
  kept income intact.

LESSON: in a systemic crisis, the question isn't "is this cheap?" —
it's "will this institution exist in two years?" Buffett's preferred-
stock structure is instructive: take income, keep optionality, don't
bet the farm on the bottom. For dividend-focused strategies: financials
during credit crises are where dividend streaks die. Diversify across
sectors BEFORE the crisis, not during.`,
    tags: ['seed', 'crisis', '2008', 'credit'],
  },
  {
    slug: 'covid-crash-2020',
    kind: 'crisis_playbook',
    title: '2020 COVID Crash — fastest -34% in history',
    body: `TRIGGER: Feb-March 2020. S&P 500 -34% in 23 trading days —
fastest move of that magnitude ever. Pandemic + complete economic
shutdown. Then the V-shaped recovery began in April and hit new highs
by August.

WHAT EACH SCHOOL DID:

- BUFFETT: famously did NOTHING for about two months. Berkshire's cash
  pile grew. He sold airlines at a LOSS (thesis broken — the industry
  had fundamentally changed). Deployed capital later in 2020 into
  Verizon, Chevron, and Japanese trading houses. His March-April 2020
  Berkshire meeting: "We haven't done anything because we don't see
  anything that attractive." He was widely criticized at the time. He
  was right.

- GRAHAM SCHOOL: bought everything that survived in March 2020. The
  dislocation was brief but extreme — classic Graham territory. REITs,
  small-cap industrials, energy all traded at massive discounts.

- QUALITY COMPOUNDERS: the right move was to hold winners and add to
  names that hadn't broken. Apple dipped to ~$55 (split-adjusted),
  Microsoft to ~$140. Adding here was the trade of the decade.

- DIVIDEND GROWTH: many reduced or suspended (airlines, REITs,
  casinos, Shell cut its dividend for the first time since WWII).
  Dividend growers in staples (P&G, KO, PEP) kept paying. Energy was
  mixed (Shell cut, ExxonMobil didn't).

- BOGLEHEAD: did nothing. Kept DCA-ing. Was back to all-time highs by
  August. Arguably the simplest "winning" strategy of all.

LESSON: speed of the move matters less than your readiness for it.
Buffett's cash pile came from years of discipline, not from timing
the crash. Having the capability to act during the dislocation is a
function of what you did BEFORE it, not what you try to do DURING it.
Also: "obvious" opportunities can be wrong. Airlines looked cheap in
March 2020; Buffett sold them because the thesis was broken, not
because the price was wrong.`,
    tags: ['seed', 'crisis', '2020', 'pandemic'],
  },
  {
    slug: 'rate-cycle-2022',
    kind: 'crisis_playbook',
    title: '2022 Rate-Hike Crash — bonds + stocks down together',
    body: `TRIGGER: Jan-Oct 2022. Fed raising rates aggressively after
decade of ZIRP. S&P -25%, Nasdaq -33%, long-duration Treasuries -30%.
First year since 1969 where stocks AND bonds both lost money. No
single "event" — grinding decline driven by rate repricing.

WHAT EACH SCHOOL DID:

- BUFFETT: bought aggressively. Berkshire deployed ~$50B in 2022
  (Occidental, Chevron, HP, Activision merger arb, Japanese trading
  houses). Reasoning: quality businesses at reasonable prices finally
  available after years of everything trading at growth multiples.

- GRAHAM SCHOOL: more muted than in prior crashes because the decline
  was orderly — no fire-sale prices. But energy + some industrials
  hit clear value territory.

- QUALITY COMPOUNDERS: held, added to highest-conviction names. Apple
  and Microsoft down 25-30% from peak both rewarded adders.

- DIVIDEND GROWTH: one of the easier crises — almost no dividend cuts
  in aristocrats. Rising rates meant higher yields on new money.
  Diversified dividend portfolios held up relatively well.

- BOGLEHEAD: the painful one. Bonds and stocks both down = nowhere to
  hide in the traditional 60/40. DCA continued as normal; rebalancing
  into stocks during the drawdown accelerated recovery.

LESSON: not all crashes are created equal. 2022 was a rate-regime
reset, not a solvency crisis. Fundamentally sound businesses were the
safe bet — no company went bankrupt from rates rising to 5%. Compare
to 2008 where the question was "will this institution exist?". Read
the CRISIS correctly: solvency-risk crises (2008, Asian 1997) need
balance-sheet focus; repricing crises (2022, 1994 bond rout) are
opportunities for patient buyers with cash.`,
    tags: ['seed', 'crisis', '2022', 'rates'],
  },
];
