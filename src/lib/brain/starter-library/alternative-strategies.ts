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
      sellOnMeanReversionPct: 30,
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
      thesisReviewCadenceDays: 90,
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
    },
  },
];
