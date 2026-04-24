// Durable investing principles. Short, quotable, actionable. The agent reads
// these at wake-up to ground every decision.

import type { BrainSeed } from './types';

export const PRINCIPLES: BrainSeed[] = [
  {
    slug: 'buffett-rule-1-never-lose-money',
    kind: 'principle',
    title: 'Rule No. 1: Never Lose Money',
    body: `Buffett: "Rule No. 1: Never lose money. Rule No. 2: Never forget Rule No. 1."

This is literal and load-bearing. A 50% loss requires a 100% gain to recover. Two mediocre wins don't compensate for one large loss — the math is asymmetric and punishing.

Practically: decline trades you're unsure of. Pass faster than you buy. The cost of missing a gain is linear; the cost of losing principal is compound.`,
    tags: ['seed', 'principle', 'buffett', 'risk'],
  },
  {
    slug: 'margin-of-safety',
    kind: 'principle',
    title: 'Margin of Safety',
    body: `Graham's central idea: only buy when price is meaningfully below your estimate of intrinsic value. The gap protects you from mistakes in your own valuation, from bad luck, and from Mr. Market.

Default target: price ≤ 80% of blended intrinsic (20%+ margin of safety). For less certain businesses, demand more. Never trade it away to feel "in the market."

If the analyzer says MoS < 20%, the answer is wait or pass. There is always another pitch.`,
    tags: ['seed', 'principle', 'graham', 'valuation'],
  },
  {
    slug: 'circle-of-competence',
    kind: 'principle',
    title: 'Circle of Competence',
    body: `Buffett: "Know the edge of your circle of competence, and stay well inside it."

If you can't explain in two sentences how the business earns money and what would kill it, you don't understand it. Unknown unknowns are where principal dies.

The size of the circle matters far less than knowing where its edge is. Broad-market ETFs are always inside the circle; a new biotech on promising Phase II data is almost never inside it.`,
    tags: ['seed', 'principle', 'buffett', 'discipline'],
  },
  {
    slug: 'mr-market',
    kind: 'principle',
    title: 'Mr. Market',
    body: `Graham's allegory: imagine a manic-depressive partner who every day offers to buy your share of the business or sell you his, at wildly varying prices. You are never obligated to transact.

Use his moods. Don't catch them. Panic is a discount; euphoria is a premium. Our job is to transact when he's wrong about price, and sit when he's right.

If the news is loud and the price move is violent, that's usually Mr. Market — not new information about intrinsic value.`,
    tags: ['seed', 'principle', 'graham', 'psychology'],
  },
  {
    slug: 'price-is-not-value',
    kind: 'principle',
    title: 'Price Is What You Pay, Value Is What You Get',
    body: `Price is a number on a screen. Value is the discounted stream of cash a business produces over its life. They are related only loosely in the short term.

A stock going up is not the same as the underlying business getting better. A stock going down is not the same as the business getting worse.

Anchor on value (via the analyzer). Let price come to you.`,
    tags: ['seed', 'principle', 'buffett', 'valuation'],
  },
  {
    slug: 'moat-first-price-second',
    kind: 'principle',
    title: 'Moat First, Price Second',
    body: `Munger's upgrade on Graham: "A great business at a fair price is superior to a fair business at a great price."

A wide moat compounds value for decades and forgives timing errors. A fair business with no moat requires perfect timing to profit — and timing is the skill we explicitly do not claim.

Preference order: wide-moat at fair price > wide-moat at great price > narrow-moat at great price >>> no-moat at any price.`,
    tags: ['seed', 'principle', 'munger', 'quality'],
  },
  {
    slug: 'favourite-holding-period-forever',
    kind: 'principle',
    title: 'Our Favourite Holding Period Is Forever',
    body: `Buffett again. Long holding periods compound returns, minimise taxes and frictions, and compress the number of decisions we have to make.

Sell only on: (a) thesis break — the reason we bought is no longer true; (b) materially better opportunity; (c) a forced rebalance due to position size drift. Never sell because a position "had a good run" or "feels extended" without one of those triggers.

Inaction is often the highest-value move of the day.`,
    tags: ['seed', 'principle', 'buffett', 'patience'],
  },
  {
    slug: 'invert-always-invert',
    kind: 'principle',
    title: 'Invert, Always Invert',
    body: `Munger (via Jacobi): before buying, explicitly ask "what would cause this thesis to fail?" List the top three. If any is plausible and you can't rule it out, demand a larger margin of safety — or pass.

The bear case is not an afterthought. It is a structural part of every decision. A thesis you can't stress-test is a thesis you don't understand.

Always produce a Bull Case AND a Bear Case. If the Bear Case is weaker than the Bull Case, you have not tried hard enough on the Bear Case.`,
    tags: ['seed', 'principle', 'munger', 'discipline'],
  },
  {
    slug: 'concentrate-on-conviction',
    kind: 'principle',
    title: 'Concentrate on Conviction, ETF the Rest',
    body: `Munger: "The wise ones bet heavily when the world offers them that opportunity. They bet big when they have the odds. And the rest of the time, they don't."

Practically: it's fine — correct even — to have large cash or broad-ETF positions when nothing screens well. The account's ballast (VOO, VTI, SCHD) is doing productive work even when no single-name thesis deserves more capital.

Server-side caps still bound any single position. Concentration inside the cap; diversification across uncorrelated caps.`,
    tags: ['seed', 'principle', 'munger', 'sizing'],
  },
  {
    slug: 'cash-is-a-position',
    kind: 'principle',
    title: 'Cash Is a Position',
    body: `Cash earns a yield (via the brokerage sweep) and — more importantly — preserves optionality. The next 20%-margin-of-safety opportunity arrives on its own schedule, not ours. Cash is what lets us take it.

"Under-invested" is a feeling, not a metric. The question is never "are we fully deployed?" — it's "is this specific trade better than holding the cash?"

Respect the min cash reserve as a floor, not a target. Above that floor, deploy only when MoS and moat justify it.`,
    tags: ['seed', 'principle', 'risk', 'sizing'],
  },
  // ─── Burrybot's contributions ──────────────────────────────────────
  // Seeded principles drawn from Michael Burry's Scion letters + public
  // writing on "ick" investing. Tagged 'burry' so the agent can filter
  // to his voice when the active strategy is Burry Deep Research OR
  // when he's invited as a guest. Confidence=canonical because these
  // are his published convictions, not hypotheses.
  {
    slug: 'burry-ick-is-an-invitation',
    kind: 'principle',
    title: "Ick Is an Invitation (Burrybot)",
    body: `Burrybot's framing, almost verbatim: "Ick investing means taking a special analytical interest in stocks that inspire a first reaction of 'ick.'"
The names that trigger reflexive dismissal — the private prison, the regional bank mid-scandal, the retailer everyone buried, the pharma with a Phase III failure — are the richest hunting ground precisely because the selling is indiscriminate and price detaches from asset value.
Ick is not a buy signal on its own. It's a flag to READ. Pick up the 10-K. Read the footnotes. Do the cash-flow math. If the numbers disagree with the vibe, that's where the alpha lives.`,
    tags: ['seed', 'principle', 'burry', 'contrarian'],
  },
  {
    slug: 'burry-read-the-footnotes',
    kind: 'principle',
    title: 'Read the Footnotes Nobody Reads (Burrybot)',
    body: `The press release is marketing. The income statement is curated. The footnotes are where the real story hides — lease obligations, off-balance-sheet entities, one-time charges that recur, segment disclosures that don't tie to the headline.
Process: before valuing a name, read the last 10-K + three most recent 10-Qs cover-to-cover. Annotate the footnotes specifically. If you can't name the three biggest accounting choices management made, you don't understand the business yet.
This is the one habit that separates deep-value research from pattern-matching headlines.`,
    tags: ['seed', 'principle', 'burry', 'research'],
  },
  {
    slug: 'burry-concentration-follows-conviction',
    kind: 'principle',
    title: 'Concentration Follows Conviction (Burrybot)',
    body: `Scion's book historically ran concentrated — top-3 names routinely 10-15% each. Conviction earned through weeks of reading deserves position size commensurate with the work done.
But the direction runs one way: conviction EARNS concentration. Concentration does NOT create conviction. If you're sized up on something you can't defend in one page, you're gambling, not investing.
In practice: for any position >10% of book, write a one-page thesis into the brain with the three facts that would change your mind. Re-read it monthly.`,
    tags: ['seed', 'principle', 'burry', 'sizing'],
  },
  {
    slug: 'burry-cash-flow-over-earnings',
    kind: 'principle',
    title: 'Cash Flow Over Earnings (Burrybot)',
    body: `P/E is the lazy metric. Earnings include non-cash charges, one-time benefits, stock-based comp the headline ignores, and timing choices that let management smooth the curve.
Lead with free cash flow. FCF yield (FCF ÷ enterprise value), EV/EBITDA, and the cash-conversion ratio (FCF ÷ net income) tell you whether the business actually generates owner earnings or just GAAP earnings. Two businesses at the same P/E can differ by 3x on cash quality.
When P/E looks attractive but cash-conversion is weak, the "cheapness" is mostly accrual accounting.`,
    tags: ['seed', 'principle', 'burry', 'valuation'],
  },
];
