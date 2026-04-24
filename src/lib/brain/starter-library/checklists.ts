// Operational checklists. Short, concrete, in-the-moment. The agent is
// expected to mentally walk through the relevant checklist before acting.

import type { BrainSeed } from './types';

export const CHECKLISTS: BrainSeed[] = [
  {
    slug: 'pre-trade',
    kind: 'checklist',
    title: 'Pre-Trade Checklist',
    body: `Before any buy order, every item must be YES:

  1. Is this symbol inside my circle of competence? (Can I explain the business in two sentences?)
  2. Has run_analyzer been called within the last 24h with fresh numbers?
  3. Is margin-of-safety ≥ 20% against blended intrinsic? (Strategy may tighten this.)
  4. Is the moat signal at least "narrow"? (Strategy may require "wide".)
  5. Is ROE ≥ 15% and D/E ≤ 1.5? (Strategy rules override — read the active strategy first.)
  6. Have I written a one-paragraph Bull Case AND Bear Case? (Both concrete, not "vibes".)
  7. Will this position stay under maxPositionPct of portfolio after the fill?
  8. Will the account stay above minCashReservePct after the fill?
  9. Am I under the maxDailyTrades cap for today?
  10. Is the active strategy compatible with this trade? (Sector allowed? P/E under cap? Dividend floor met?)

If ANY answer is NO, do not place the trade. Record a research note instead.`,
    tags: ['seed', 'checklist', 'pre-trade'],
  },
  {
    slug: 'sell',
    kind: 'checklist',
    title: 'Sell Checklist',
    body: `Before any sell order — especially trimming a winner or cutting a loser — check:

  1. Thesis break? Is the specific reason I bought this no longer true? (Name the event, not the feeling.)
  2. Materially better opportunity? Is the capital going into something with higher expected risk-adjusted return? (Name it.)
  3. Position size drift? Has the position grown past the policy cap and needs a rebalance trim?
  4. Dividend cut, fraud allegation, or regulatory action? These are automatic re-evaluations, not automatic sells.
  5. If NONE of 1–3 applies, the default is HOLD. "It's been a good run" is not a sell signal. Neither is "it's down 20%."

Tax / friction reminder: every sale crystallises a taxable event and a spread cost. The bar for selling is HIGHER than the bar for buying, not lower.`,
    tags: ['seed', 'checklist', 'sell'],
  },
  {
    slug: 'research',
    kind: 'checklist',
    title: 'Research Checklist',
    body: `When researching a candidate before updating fundamentals or placing a trade:

  1. research_perplexity for: latest earnings, competitive threats, recent insider transactions, management changes in last 12 months. Ask explicitly for Bull Case AND Bear Case.
  2. research_google for: long-term industry context, sector tailwinds/headwinds, regulatory landscape.
  3. Pull the relevant sector_primer from the brain (kinds: ["sector_primer"]) and check norms: what does "good" ROE / leverage / margin look like in THIS sector?
  4. Pull any related case_study from the brain (kinds: ["case_study"]) — have we seen this pattern before?
  5. Update Stock fundamentals via update_stock_fundamentals if you have fresh data. Bumps lastAnalyzedAt.
  6. Record a research_note with source, topic, Bull Case, Bear Case, and a 1-line summary. Every research loop ends with a persisted note — otherwise the next agent has no record.`,
    tags: ['seed', 'checklist', 'research'],
  },
  {
    slug: 'earnings-day',
    kind: 'checklist',
    title: 'Earnings-Day Checklist',
    body: `When a name on the watchlist reports earnings:

  1. Do not trade in the first 2 hours after the report. Initial price moves are liquidity-driven, not information-driven.
  2. Wait for the earnings call transcript. Headlines miss the forward commentary, which is usually where the thesis lives or dies.
  3. Re-run run_analyzer with the new TTM EPS, new FCF per share, new book value. The OLD valuation is stale within minutes of the print.
  4. Compare new numbers to our stored fundamentals. Is the gap explained by the print, or did we have bad data? If the latter, update_stock_fundamentals is urgent.
  5. Re-state the Bull Case AND Bear Case from scratch. What changed? If nothing changed materially, the thesis stands and no action is needed.
  6. Only after all of the above: consider whether to add, trim, hold, or exit. Default is HOLD when in doubt.`,
    tags: ['seed', 'checklist', 'earnings'],
  },
  {
    slug: 'burry-10k-walkthrough',
    kind: 'checklist',
    title: "Burrybot's 10-K Walkthrough",
    body: `The full read before any position >5% of book. Budget 2-3 hours per name — this is the work.

  1. READ THE LETTER TO SHAREHOLDERS first. Note tone, accountability, what management chose to discuss vs skip. A CEO who names mistakes by year is more trustworthy than one who only discusses wins.
  2. INCOME STATEMENT — map 5 years side-by-side. Revenue growth quality: organic vs acquired vs price. Margins: expanding / flat / compressing (which line?). One-time items: are they really one-time, or recurring dressed up?
  3. CASH FLOW STATEMENT is the truth serum. Compute free cash flow manually: operating CF − capex. Compare to net income. Ratio < 0.7 is a yellow flag; < 0.5 means earnings are mostly accrual.
  4. BALANCE SHEET — net debt, current ratio, book value per share. Look for hidden assets: real estate at historical cost, equity stakes at cost, fully depreciated but still-earning PP&E.
  5. FOOTNOTES — the whole point. Specifically: (a) revenue recognition policy, (b) segment disclosures, (c) off-balance-sheet commitments (leases, JVs), (d) related-party transactions, (e) pension/post-retirement obligations.
  6. SHAREHOLDER BASE — insider ownership >5% is a green flag; recent insider selling is a red flag; institutional concentration tells you volatility profile.
  7. RISK FACTORS — SEC-mandated CYA section, but the first 3 risks listed are usually the ones management actually worries about. Cross-reference with the letter's tone.
  8. WRITE THE ONE-PAGE THESIS into brain via write_brain with category=memory, confidence=medium. Bull case. Bear case. Three facts that would change your mind. Then wait a week before acting — conviction that survives a week of sleep is worth more than Day-1 enthusiasm.`,
    tags: ['seed', 'checklist', 'burry', 'research', '10-k'],
  },
];
