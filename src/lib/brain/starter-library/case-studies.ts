// Historical cases. Each study carries one clear lesson. The agent pulls
// these pre-trade as pattern-matching fuel — "have we seen this before?"

import type { BrainSeed } from './types';

export const CASE_STUDIES: BrainSeed[] = [
  {
    slug: 'ko-1988',
    kind: 'case_study',
    title: 'Case Study: Buffett Buys Coca-Cola (1988)',
    body: `Situation: After the 1987 crash, Buffett began accumulating KO at ~$2.45/share split-adjusted. By 1989, Berkshire owned 7% of the company. Over the following decade, KO compounded at ~25% annually.

Thesis: KO had one of the strongest brand moats in history, global distribution that competitors couldn't replicate, pricing power that kept gross margins > 60%, and a dividend that grew every year. The company was undervalued relative to a reasonable DCF because the market was still hungover from crash paranoia.

Lesson: When a wide-moat, globally-dominant brand sells at a discount after a market dislocation, that is the textbook setup. Don't confuse "everything is down" with "nothing is worth buying." Market-wide dislocations are when the best businesses become available at value prices.

Applied today: KO, PG, PEP, WMT and similar names rarely offer > 20% MoS. When they do (typically during broad drawdowns), the Bull Case is ancient and obvious. That's a feature, not a bug.`,
    tags: ['seed', 'case_study', 'buffett', 'KO'],
  },
  {
    slug: 'axp-salad-oil',
    kind: 'case_study',
    title: 'Case Study: AmEx Salad Oil Scandal (1964)',
    body: `Situation: In 1963, Allied Crude Vegetable Oil defrauded creditors including an AmEx warehousing subsidiary for ~$150M (enormous then). AmEx stock collapsed. Buffett (Buffett Partnership) bought ~5% of AmEx near the lows.

Thesis: The scandal was real, but it was a subsidiary-level event. The core AmEx business — the charge card and Travelers Cheques — had an intact moat: network effects, brand trust, merchant acceptance. Buffett's field research (he visited restaurants in Omaha to see if people were still using their AmEx cards — they were) confirmed the core franchise was unharmed.

Lesson: Distinguish TEMPORARY problems from PERMANENT impairment. A scandal, a product recall, a management exit — these can depress the price far below intrinsic if the core franchise survives. The analytical work is separating "the market is right, this is a changed business" from "the market has overreacted, the franchise is intact."

Applied today: When news sends a wide-moat stock down 30%+ in a session, don't buy blindly — but DO investigate. The question: does this event break the franchise, or just dent the quarter?`,
    tags: ['seed', 'case_study', 'buffett', 'AXP'],
  },
  {
    slug: 'geico',
    kind: 'case_study',
    title: 'Case Study: GEICO and the Low-Cost Moat',
    body: `Situation: GEICO (founded 1936) sold auto insurance direct-to-consumer while the rest of the industry sold through commissioned agents. The direct model stripped ~15% off the cost structure — a structural cost advantage that let GEICO offer lower premiums without sacrificing underwriting profit.

Buffett first invested in GEICO in 1951 as a student of Ben Graham (Graham was on GEICO's board). He reinvested in the 1970s crisis, and Berkshire fully acquired GEICO in 1996.

Thesis: A low-cost position in a commodity-like product (auto insurance) is one of the most durable moats that exists. Once you're cheapest, you win price-sensitive customers, which gives you more data and scale, which makes you cheaper still. The flywheel self-reinforces for decades.

Lesson: Look for structural cost advantages — a different distribution model, a vertically integrated process, a scale that rivals can't reach. They compound for longer than almost anyone anticipates. Costco is the modern version: membership model + thin retail margin = structural cost advantage.`,
    tags: ['seed', 'case_study', 'buffett', 'GEICO'],
  },
  {
    slug: 'ibm-2011-2018',
    kind: 'case_study',
    title: 'Case Study: Buffett and IBM, 2011–2018',
    body: `Situation: Berkshire accumulated ~$10B of IBM starting in 2011. The thesis: steady earnings, strong FCF, massive buybacks, dominant position in enterprise IT services.

What went wrong: IBM's "Global Services" revenue declined YoY for 20+ consecutive quarters through the mid-2010s as enterprise IT moved to public cloud (AWS, Azure, GCP). IBM was slow to adapt; its moat was narrower than it looked because the moat depended on a hardware+service bundle that was dissolving. Buffett exited ~break-even by 2018.

Lesson: Buffett himself admitted he misjudged the competitive dynamics. A "wide moat" in a technology that's being disrupted is not a moat at all — it's a legacy position. ROE and FCF can look strong while the underlying demand is quietly rolling over.

Applied today: In technology especially, ask "is this business BETTER positioned than 5 years ago, or WORSE?" Flat revenue with rising buyback-driven EPS can mask thesis erosion. Watch the top line, not just EPS.

Even Buffett makes mistakes. Post-mortem honestly. Exit when you realise you were wrong, don't hold for pride.`,
    tags: ['seed', 'case_study', 'buffett', 'IBM', 'mistake'],
  },
  {
    slug: 'khc-writedown',
    kind: 'case_study',
    title: 'Case Study: Kraft Heinz and the 2019 Writedown',
    body: `Situation: 3G Capital and Berkshire merged Kraft and Heinz in 2015. The playbook: zero-based budgeting, aggressive cost cuts, margin expansion. For a while it worked — margins rose, FCF was strong.

What went wrong: 3G's cost-cutting came at the expense of brand reinvestment. Consumer preferences shifted toward fresh, healthier, private-label alternatives. Kraft's flagship brands (Velveeta, Kraft Singles, Oscar Mayer) lost relevance to younger consumers. In Feb 2019, KHC wrote down $15.4B of goodwill, cut the dividend 36%, and the stock collapsed. Buffett called it "one of the bigger mistakes" Berkshire had made.

Lesson: Cost cuts can temporarily lift margins even as the underlying brand equity bleeds out. Revenue growth is a truer measure of brand health than margin. A consumer brand that stops growing organically is often a dying asset dressed up as a cash cow.

Applied today: When a consumer-brand name has expanding margins but FLAT or declining organic volumes, that's a yellow flag — not a green one. The analyzer sees the margin; you have to separately confirm the revenue health.`,
    tags: ['seed', 'case_study', 'buffett', 'KHC', 'mistake'],
  },
  {
    slug: 'airlines-sector',
    kind: 'case_study',
    title: 'Case Study: Airlines — A Sector to Mostly Avoid',
    body: `Situation: Buffett famously called airlines a "death trap" in the 1990s after his USAir investment. Then — against his own rule — he bought stakes in the four major US carriers (AAL, DAL, LUV, UAL) in 2016. In April 2020, as COVID grounded fleets, Berkshire exited the entire airline position at a significant loss.

Why airlines are structurally bad: (1) Commodity product — a seat between NYC and LAX on one carrier is nearly identical to another. (2) Massively capital-intensive — fleet costs billions, cannot be shrunk quickly. (3) High fixed cost ratio — a 5% revenue drop is devastating. (4) Powerful unions limit wage flexibility. (5) Exogenous shocks (fuel spikes, pandemics, wars) are frequent and brutal.

Lesson: Some sectors have structural economics that make durable competitive advantage nearly impossible. Over a full cycle, the industry earns less than its cost of capital. You can get lucky timing one cycle but you will eventually give it back.

Applied today: Default to AVOID airlines, most unhedged commodity producers, and high-capex cyclicals. If we ever decide to participate, demand extreme margin-of-safety and size SMALL. Even Buffett learned this one twice.`,
    tags: ['seed', 'case_study', 'buffett', 'airlines', 'sector-avoid'],
  },
];
