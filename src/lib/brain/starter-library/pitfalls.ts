// Biases and trap patterns we want the agent to recognise and resist. Each
// entry names the trap, explains why it's expensive, and prescribes a
// counter-move.

import type { BrainSeed } from './types';

export const PITFALLS: BrainSeed[] = [
  {
    slug: 'value-trap',
    kind: 'pitfall',
    title: 'Value Traps: Cheap for a Reason',
    body: `A low P/E or high dividend yield can reflect a broken business, not a bargain. The market is usually not that dumb — "cheap" stocks often get cheaper because earnings are about to fall, the dividend is about to be cut, or the moat is eroding.

Defenses:
  - Check earnings trajectory over 5y. Is EPS flat or declining? That's a red flag even if today's P/E looks low.
  - Check payout ratio. Dividend yield > 6% with payout > 80% is a dividend cut warning, not income.
  - Check industry trend. Newspapers and cable TV had cheap multiples for 15 years as they went to zero.
  - Demand a moat signal of at least "narrow" before treating a low multiple as "value."`,
    tags: ['seed', 'pitfall', 'valuation'],
  },
  {
    slug: 'anchoring-to-price',
    kind: 'pitfall',
    title: 'Anchoring to Current Price',
    body: `"It's down 30% from the 52-week high, must be cheap." No. The 52-week high is a price, not a value. The only anchor that matters is intrinsic value.

A stock can be up 50% and still be undervalued. A stock can be down 50% and still be overvalued. Stop thinking in deltas from recent prices.

Counter-move: when evaluating, hide the chart. Run run_analyzer. Compare current price to blended intrinsic. That ratio is the decision. The 52-week range is noise.`,
    tags: ['seed', 'pitfall', 'psychology'],
  },
  {
    slug: 'recency-bias',
    kind: 'pitfall',
    title: 'Recency Bias',
    body: `The last quarter is not the next 20 quarters. The last month of price action is not the next decade of returns. Our brains weight recent events too heavily.

Examples:
  - A great Q beat doesn't turn a bad business into a good one.
  - A bad Q miss doesn't turn a wide-moat compounder into a value trap.
  - 6 months of underperformance is not evidence a strategy is broken — value strategies regularly have 1–3 year droughts before reasserting.

Counter-move: weight 5-year and 10-year numbers heavily. Use the analyzer's DCF + Graham + DDM blend; it forces multi-year thinking.`,
    tags: ['seed', 'pitfall', 'psychology'],
  },
  {
    slug: 'averaging-down-broken-thesis',
    kind: 'pitfall',
    title: 'Averaging Down on a Broken Thesis',
    body: `Adding to a loser because "it's cheaper now" only works if the original thesis is still intact. If the thesis is broken (earnings guidance cut, dividend cut, management exit, regulatory hit), you are not being patient — you are throwing good money after bad.

Test: WRITE DOWN the original Bull Case from the brain/trade record. Is each bullet still true as of today? If any is no longer true, the thesis is broken. Do not add.

The "one more average-down" is how small losses become large ones. This is the single most common way portfolios blow up.`,
    tags: ['seed', 'pitfall', 'risk', 'psychology'],
  },
  {
    slug: 'dcf-terminal-sensitivity',
    kind: 'pitfall',
    title: 'DCF Terminal Value Sensitivity',
    body: `A 10-year DCF is dominated by the terminal value — often 60–80% of the total. The terminal value is  FCF × (1+g) / (r−g). A 1% change in g or r swings intrinsic value 20–40%.

This means a DCF is only as good as its assumptions — and most assumptions are wrong by more than 1%.

Defenses:
  - Never rely on DCF alone. The analyzer blends Graham Number, Graham Formula, DCF, DDM, and sector P/E for a reason.
  - Sanity-check: is the implied growth rate realistic vs. the last 5 years of actuals?
  - If DCF is the ONLY valuation screaming "buy," be suspicious. Multiple methods should agree for strong_buy verdicts.`,
    tags: ['seed', 'pitfall', 'valuation'],
  },
  {
    slug: 'single-valuation-overconfidence',
    kind: 'pitfall',
    title: 'Overconfidence in a Single Valuation',
    body: `Every valuation method has blind spots. DCF is terminal-value-dominated. Graham Number assumes earnings and book value are real (both can be distorted). DDM breaks for non-payers and for r ≤ g. Sector fair P/E is a crude average that ignores quality.

A number is not truth. It is one lens. Use multiple lenses and look for agreement.

Rule: the analyzer returns an AVERAGE of available valuations. If the components disagree wildly (e.g., Graham says $20, DCF says $80), don't trust the average — investigate why. Disagreement is information, not noise to smooth over.`,
    tags: ['seed', 'pitfall', 'valuation'],
  },
];
