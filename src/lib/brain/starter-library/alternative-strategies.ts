// Archived alternative strategies for the wizard's comparison library.
// Each is installed with isActive=false. The user's current strategy remains
// active; these exist so the wizard can diff against them and so users can
// switch to a pre-built alternative in one tap.

import type { StrategySeed } from './types';

export const ALTERNATIVE_STRATEGIES: StrategySeed[] = [
  {
    slug: 'deep-value-graham',
    name: 'Deep Value (Graham)',
    buffettScore: 65,
    summary:
      'Strict Benjamin Graham screens. Buy statistically cheap, sell on mean reversion. ' +
      'Ignore growth and moat — the margin of safety is the number, not the story. ' +
      'Higher turnover than the core strategy, more winners and losers mixed together.',
    rules: {
      description: 'Graham-style deep value, optimised for statistical cheapness',
      minMarginOfSafetyPct: 33,
      maxPERatio: 15,
      maxPBRatio: 1.5,
      minCurrentRatio: 2,
      maxDebtToEquity: 1,
      minMoatSignal: 'none',
      minROEPct: 5,
      preferredSectors: [],
      avoidedSectors: [],
      preferDividend: false,
      minDividendYield: 0,
      maxPosition: 10,
      minCashReserve: 10,
      maxDailyTrades: 3,
      allowDayTrades: false,
      targetAnnualReturnPct: 15,
      holdingPeriodBias: 'medium',
      // Graham sells on mean reversion: +30% from cost is the target. Canonical
      // Graham rule also says "cut bait at 2 years if it never moved" — the
      // time stop captures that. No moat-break exit (Graham didn't buy moats),
      // and no dividend-safety (Graham didn't buy for yield).
      sellOnMeanReversionPct: 30, // legacy alias retained for the wizard
      targetSellPct: 30,
      timeStopDays: 730,
      thesisReviewDays: 90,
      fundamentalsDegradationExit: true,
      dividendSafetyExit: false,
      moatBreakExit: false,
      rebalanceOnly: false,
      // Graham-style: CSPs only. Selling puts at a strike below your Graham
      // liquidation-value entry is a clean way to get paid while waiting for
      // the bid. Covered calls don't fit — Graham sells on mean reversion,
      // not on strike targets; writing a CC would cap the upside he's
      // specifically trying to capture.
      optionsAllowed: true,
      optionStrategies: ['cash_secured_put'],
      maxOptionsBookPct: 10,
      minDTE: 30,
      maxDTE: 45,
      maxDeltaAbs: 0.3,
    },
  },
  {
    slug: 'quality-compounders',
    name: 'Quality Compounders (Late-Era Buffett / Munger)',
    buffettScore: 90,
    summary:
      'Pay up for quality. Wide moats, 20%+ ROE, long reinvestment runways, rational management. ' +
      'Accept P/E up to 30× and MoS as low as 5–10% for truly exceptional businesses. ' +
      'Hold forever by default. Low turnover, tax-efficient, extremely selective.',
    rules: {
      description: 'Pay for quality. Concentrate. Hold forever.',
      minMarginOfSafetyPct: 5,
      maxPERatio: 30,
      maxPBRatio: 999,
      minMoatSignal: 'wide',
      minROEPct: 20,
      maxDebtToEquity: 1.5,
      preferredSectors: [
        'Technology',
        'Consumer Defensive',
        'Financial Services',
        'Healthcare',
        'Communication Services',
      ],
      avoidedSectors: ['Energy', 'Basic Materials', 'Airlines'],
      preferDividend: false,
      minDividendYield: 0,
      maxPosition: 25,
      minCashReserve: 5,
      maxDailyTrades: 1,
      allowDayTrades: false,
      targetAnnualReturnPct: 14,
      holdingPeriodBias: 'forever',
      thesisReviewCadenceDays: 90, // legacy alias
      // Strictest hold profile. Never sell on price. Only exit if the moat
      // erodes (qualitative → 'review' signal for the LLM) or fundamentals
      // clearly deteriorate (ROE collapse). Munger: "the big money is not in
      // the buying or selling, but in the waiting."
      thesisReviewDays: 90,
      targetSellPct: null,
      timeStopDays: null,
      moatBreakExit: true,
      fundamentalsDegradationExit: true,
      dividendSafetyExit: false,
      rebalanceOnly: false,
      // Compounders: options OFF. Selling covered calls on a 20%-ROE
      // compounding machine risks getting assigned and giving up the very
      // name you're trying to hold for decades. CSPs could fit in theory,
      // but the bar of "strike ≤ desired entry" is so high for this tier
      // that the premium isn't worth the operational overhead. Keep simple.
      optionsAllowed: false,
      optionStrategies: [],
    },
  },
  {
    slug: 'dividend-growth',
    name: 'Dividend Growth (Aristocrats)',
    buffettScore: 80,
    summary:
      'Only buy companies with 25+ consecutive years of dividend increases and a safe payout ratio. ' +
      'Prioritise dependable, growing income. Accept slower capital appreciation in exchange for ' +
      'a smoother return profile and cash flow that compounds reliably.',
    rules: {
      description: 'Dividend Aristocrats and Kings only. Income first, growth second.',
      minMarginOfSafetyPct: 10,
      maxPERatio: 25,
      maxPBRatio: 999,
      minMoatSignal: 'narrow',
      minROEPct: 12,
      maxDebtToEquity: 2,
      minYearsOfDividendGrowth: 25,
      maxPayoutRatio: 0.7,
      minDividendYield: 2,
      preferredSectors: [
        'Consumer Defensive',
        'Industrials',
        'Healthcare',
        'Financial Services',
        'Utilities',
      ],
      avoidedSectors: ['Technology'],
      preferDividend: true,
      maxPosition: 10,
      minCashReserve: 10,
      maxDailyTrades: 2,
      allowDayTrades: false,
      targetAnnualReturnPct: 10,
      holdingPeriodBias: 'long',
      // Dividend strategy — the dividend IS the thesis. Sell triggers are
      // dividend-centric (cut / suspension / streak broken). Never on price.
      // Shorter-than-Compounders review cadence because the dividend streak
      // needs ongoing verification.
      thesisReviewDays: 90,
      targetSellPct: null,
      timeStopDays: null,
      moatBreakExit: false,
      fundamentalsDegradationExit: false,
      dividendSafetyExit: true,
      rebalanceOnly: false,
      // Dividend Growth: income is the point. Both CC and CSP layer cleanly.
      // Slightly higher book cap than Buffett Core reflects that extra yield
      // is explicitly part of the strategy's mandate. User still has to
      // flip the master Account.optionsEnabled toggle.
      optionsAllowed: true,
      optionStrategies: ['covered_call', 'cash_secured_put'],
      maxOptionsBookPct: 15,
      minDTE: 30,
      maxDTE: 45,
      maxDeltaAbs: 0.3,
    },
  },
  {
    slug: 'boglehead-index',
    name: 'Boglehead Index-Only',
    buffettScore: 75,
    summary:
      'Almost no active decisions. Three-fund portfolio: US total stock market, international, ' +
      'bonds. Rebalance quarterly to target weights. The honest benchmark every other strategy ' +
      'is trying to beat. Buffett himself recommends this for most investors.',
    rules: {
      description: 'Low-cost, broadly diversified index funds. Rebalance quarterly.',
      coreHoldings: [
        { symbol: 'VTI', targetPct: 60, note: 'Total US stock market' },
        { symbol: 'VXUS', targetPct: 30, note: 'Total international stock' },
        { symbol: 'BND', targetPct: 10, note: 'Total bond market' },
      ],
      rebalanceCadenceDays: 90,
      rebalanceToleranceBandPct: 5,
      minMarginOfSafetyPct: 0,
      minMoatSignal: 'none',
      allowedSymbols: ['VTI', 'VXUS', 'BND', 'VOO', 'SCHD'],
      maxPosition: 60,
      minCashReserve: 5,
      maxDailyTrades: 1,
      allowDayTrades: false,
      targetAnnualReturnPct: 8,
      holdingPeriodBias: 'forever',
      activeResearchAllowed: false,
      // Pure index discipline: no thesis-based exits. Rebalancing-only mode
      // tells the exit evaluator to stay out of the way entirely; drift
      // corrections happen via dedicated rebalance logic.
      thesisReviewDays: null,
      targetSellPct: null,
      timeStopDays: null,
      moatBreakExit: false,
      fundamentalsDegradationExit: false,
      dividendSafetyExit: false,
      rebalanceOnly: true,
      // Boglehead: pure index discipline. Options contradict the mandate —
      // you're not trying to optimize yield on holdings, you're holding the
      // market. Off.
      optionsAllowed: false,
      optionStrategies: [],
    },
  },
  {
    // Burry-style deep-research contrarian value. Anchored in his actual
    // Scion letters + interviews: de-emphasise P/E, obsess over cash
    // flow + EV/EBITDA + liquidation value, hunt "ick factor" names
    // others reflexively dismiss, concentrate in top convictions, and
    // wait. Scion delivered 489% net Nov 2000 → Jun 2008 (S&P ~2%) on
    // this approach. Retail long-only adaptation: we keep the deep-
    // research + contrarian + concentration DNA but skip the short /
    // CDS toolkit. That's what the "guest analyst" mode is for at
    // other firms — he flags the weird stuff, doesn't drive the book.
    slug: 'burry-deep-research',
    name: 'Burry Deep Research (Contrarian Value)',
    buffettScore: 70,
    summary:
      "Obsessive 10-K / 10-Q reader. Hunts 'ick' names — stocks whose name or " +
      'circumstance triggers immediate dismissal but whose numbers tell a ' +
      "different story. De-emphasises P/E; leads with cash flow, EV/EBITDA, " +
      'balance-sheet strength, hidden asset value. Concentrated in highest- ' +
      'conviction ideas. Low turnover on winners, fast exit on broken theses. ' +
      'Wakes rarely — this is a reading strategy, not a trading one.',
    rules: {
      description:
        "Contrarian deep value. Read the footnotes. Concentrate where conviction is highest. Don't pay for P/E — pay for cash flow.",
      // MoS deeper than Graham. Burry wants to be paid to wait through
      // the ick. 40% is approximately his Scion-era target.
      minMarginOfSafetyPct: 40,
      // P/E is explicitly DE-EMPHASISED. He calls out P/E as a misleading
      // metric when earnings quality is poor. We set it high so it's not
      // a hard gate; the analyzer's cash-flow yield + EV/EBITDA do the
      // filtering.
      maxPERatio: 999,
      maxPBRatio: 2,
      // Net-net working capital is a Burry preference — not required,
      // but if it shows up it's a strong buy signal. Rules engine
      // doesn't enforce this; the wizard + agent both read the note.
      preferNetNetWorkingCapital: true,
      // Cash flow yield (FCF / EV) is the primary filter. 8% is a
      // generous threshold — anything above is interesting, the depth
      // of the read decides if it's actionable.
      minFreeCashFlowYieldPct: 8,
      maxEvEbitda: 8,
      // Debt tolerance: higher than Graham if the debt is backed by
      // durable assets. Agent must READ the footnotes, not just the
      // ratio.
      maxDebtToEquity: 2,
      minMoatSignal: 'none',
      minROEPct: 0,
      preferredSectors: [],
      // Burry famously buys what others avoid — prisons (GEO), coal,
      // defence, tobacco have all shown up in his books. Zero sector
      // bans at the rule level; the individual thesis carries the
      // ethical judgement.
      avoidedSectors: [],
      preferDividend: false,
      minDividendYield: 0,
      // Higher concentration than any other preset — Scion routinely
      // runs top-3 weights of 10-15% each. Still capped; a single name
      // going against you shouldn't end the strategy.
      maxPosition: 20,
      minCashReserve: 15,
      // Low cadence — Burry is slow. 2 trades/day is a ceiling we
      // expect to rarely approach. Most weeks he makes zero trades.
      maxDailyTrades: 2,
      allowDayTrades: false,
      targetAnnualReturnPct: 25,
      // Position lifetime is thesis-dependent. A net-net might revert
      // in 6 months; a macro-paranoid short-adjacent long could sit
      // for 3 years. Hold signals drive the review cadence.
      holdingPeriodBias: 'long',
      thesisReviewDays: 180,
      // Burry exits fast when the thesis breaks. Fundamentals
      // degradation → out. Moat doesn't really apply. Target price
      // exit is on intrinsic-value convergence, not a fixed percent.
      targetSellPct: null,
      timeStopDays: 1095, // 3-year soft ceiling on unrealised theses
      moatBreakExit: false,
      fundamentalsDegradationExit: true,
      dividendSafetyExit: false,
      rebalanceOnly: false,
      // Options: CSPs on ick names you'd happily own at a lower strike
      // are on-brand. Covered calls don't fit — Burry's winners run
      // hard and capping the upside would defeat the concentration
      // thesis. Real Burry uses puts (long) heavily; we exclude that
      // from retail long-only in this seed, but the strategy
      // description flags it as a natural fit for more advanced users.
      optionsAllowed: true,
      optionStrategies: ['cash_secured_put'],
      maxOptionsBookPct: 15,
      minDTE: 45,
      maxDTE: 90,
      maxDeltaAbs: 0.25,
      // Research budget — this strategy justifies longer agent cadence
      // because the work is in reading, not reacting.
      preferredAgentCadenceMinutes: 240,
    },
  },
];
