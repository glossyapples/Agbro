// Sector-specific "what good looks like" and "what to avoid" reference cards.
// The agent pulls these during research so it's not applying generic norms
// (e.g. "D/E < 1") to sectors where they don't fit (e.g. Financials).

import type { BrainSeed } from './types';

export const SECTOR_PRIMERS: BrainSeed[] = [
  {
    slug: 'financials',
    kind: 'sector_primer',
    title: 'Sector Primer: Financial Services',
    body: `Leverage is normal here — banks operate at 8–12× equity, insurers hold float. Do NOT apply a generic D/E < 1 rule; it will disqualify every bank.

What "good" looks like:
  - Banks: ROE 12–18%, net interest margin (NIM) stable, loan-loss provisions low relative to peers, tier-1 capital well above regulatory minimum, efficiency ratio < 60%.
  - Insurers: combined ratio < 100% (underwriting profit), long-term reserve development favourable, float growing at modest rate.
  - Asset managers / exchanges / ratings: capital-light, 30%+ ROE typical, look for organic AUM growth ex-market performance.

Watch for: credit-cycle deterioration (rising NPLs), reaching for yield on the asset side, opaque derivatives exposure, regulatory capital pressure.

Buffett exemplars: Bank of America, Moody's, American Express. Moat source: switching costs, regulatory licences, float cost advantage.`,
    tags: ['seed', 'sector_primer', 'financials'],
  },
  {
    slug: 'technology',
    kind: 'sector_primer',
    title: 'Sector Primer: Technology',
    body: `Moat sources: switching costs (Microsoft Office, Salesforce), network effects (Google Search, Meta Platforms), ecosystem lock-in (Apple), scale economies in data/cloud (Azure, AWS).

What "good" looks like:
  - Gross margin > 60% for software, > 40% for hardware
  - ROE > 25% (but interpret cautiously in buyback-heavy names with low book)
  - FCF margin > 20%
  - Revenue growth > 10% sustained, deceleration to LSD growth is a yellow flag

Watch for: moat erosion (switching costs decay, new entrants on a different architecture), disruption from below (what Christensen called low-end disruption), stock-based compensation dilution — always compute "FCF less SBC" as the honest cash number.

Buffett exemplars: Apple. Buffett has explicitly said tech is often outside his circle; we should be humbler here than in Consumer Defensive.`,
    tags: ['seed', 'sector_primer', 'technology'],
  },
  {
    slug: 'energy',
    kind: 'sector_primer',
    title: 'Sector Primer: Energy',
    body: `Commodity-tied. Revenue follows oil/gas prices, which you cannot predict. Profits over a full cycle matter far more than any single year.

What "good" looks like:
  - Integrated majors with low per-barrel breakeven (< $40/bbl)
  - Strong balance sheet — net debt / EBITDA < 2× through the cycle
  - Disciplined capex — prefer buybacks/dividends over production growth
  - ROE 12–20% averaged over a 10-year cycle (single-year numbers mislead)

Avoid: pure-play upstream with high breakevens, highly-leveraged producers (they die in downturns), assets in jurisdictions with contract-risk (nationalisation history).

Prefer: diversified integrated (XOM, CVX), midstream toll-road operators with long contracts.

Dividend aristocrats in this sector (CVX, XOM) are Buffett-style. Watch for sustained dividend coverage: dividend must be safe at $50 oil, not just $90 oil.`,
    tags: ['seed', 'sector_primer', 'energy'],
  },
  {
    slug: 'consumer-defensive',
    kind: 'sector_primer',
    title: 'Sector Primer: Consumer Defensive',
    body: `This is the Buffett sweet spot: people buy soap, drinks, and toothpaste in every economy. Revenue is sticky, margins are steady, moat is brand + distribution.

What "good" looks like:
  - Gross margin 40–60%, stable over 10 years
  - ROE 20–40% (often juiced by buybacks — check book value trend)
  - Dividend yield 2–4%, payout ratio < 70%, 10+ year dividend-growth streak
  - Organic revenue growth matches or beats category (share gain, not just price hikes)

Watch for: private-label erosion (Walmart / Costco house brands), changing consumer preferences (processed food vs. fresh), category shrinkage (smoking, sugary drinks in some geographies).

Exemplars: KO, PG, PEP, WMT, COST. When these get cheap (MoS ≥ 20%), they are usually excellent long-term holdings. The hard part is not the analysis — it's the patience to wait for the discount.`,
    tags: ['seed', 'sector_primer', 'consumer-defensive'],
  },
  {
    slug: 'healthcare',
    kind: 'sector_primer',
    title: 'Sector Primer: Healthcare',
    body: `Wildly heterogeneous — drug makers, devices, payors, distributors, services all behave differently. Treat them as sub-sectors.

Drug makers (pharma): patent cliffs are existential. A drug maker with 40% of revenue in a product losing exclusivity in 3 years is NOT the same business in 5 years. Always look at the pipeline — R&D spend as % of sales, Phase III assets, expected LoE dates. Prefer diversified majors (JNJ, ABBV post-Humira-cliff) over single-product stories.

Health insurers (UNH): scale matters, data matters, regulatory risk is permanent. ROE 15–25% typical. Watch medical cost ratio (MCR) — creeping MCR eats earnings.

Medical devices: think durable moats through surgeon preference and bundled-hospital contracts. Capital-light, high margins when entrenched.

Watch for: political risk (drug-price legislation, Medicare-for-all proposals), FDA setbacks, litigation overhangs (opioid, talc, etc.).`,
    tags: ['seed', 'sector_primer', 'healthcare'],
  },
  {
    slug: 'industrials',
    kind: 'sector_primer',
    title: 'Sector Primer: Industrials',
    body: `Cyclical by default. Earnings rise and fall with capex cycles, industrial production, and (for aerospace/defense) government budgets. Full-cycle metrics matter far more than any single year.

What "good" looks like:
  - Stable or growing backlog + book-to-bill > 1.0
  - ROIC > 10% averaged through a cycle (not just at peak)
  - Clean balance sheet — leverage low enough to survive a 2008-style demand collapse
  - Aftermarket / service revenue mix > 30% of total (smooths the cycle, higher margin)

Watch for: peak-cycle earnings extrapolated into the future (every cycle peak produces "this time is different" takes that age badly), customer concentration (any single customer > 20% is a risk), over-leverage going into downturn.

Exemplars: LMT (government customer, duopoly dynamics, dividend aristocrat), ADP (staffing, dividend aristocrat, recurring-revenue moat).`,
    tags: ['seed', 'sector_primer', 'industrials'],
  },
];
