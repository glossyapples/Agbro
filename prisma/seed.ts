// Seed AgBro with a starter user + a comprehensive Buffett-style watchlist.
// Figures are rough, directionally useful starting points — agents update them.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Seed = {
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  peRatio: number | null;
  pbRatio: number | null;
  dividendYield: number | null;
  debtToEquity: number | null;
  returnOnEquity: number | null;
  grossMarginPct: number | null;
  moatScore: number;
  buffettScore: number;
  notes: string;
};

// A starter universe weighted toward durable cash-generative businesses,
// broad-market ETFs (ballast), and dividend aristocrats. The agent will
// curate this over time.
const STOCKS: Seed[] = [
  { symbol: 'BRK.B', name: 'Berkshire Hathaway', sector: 'Financial Services', industry: 'Diversified', peRatio: 22, pbRatio: 1.5, dividendYield: 0, debtToEquity: 0.2, returnOnEquity: 10, grossMarginPct: 40, moatScore: 95, buffettScore: 95, notes: 'The benchmark. Buffett himself.' },
  { symbol: 'KO',    name: 'Coca-Cola', sector: 'Consumer Defensive', industry: 'Beverages', peRatio: 25, pbRatio: 10, dividendYield: 3.0, debtToEquity: 1.7, returnOnEquity: 40, grossMarginPct: 60, moatScore: 90, buffettScore: 85, notes: 'Iconic brand, global distribution.' },
  { symbol: 'AAPL',  name: 'Apple', sector: 'Technology', industry: 'Consumer Electronics', peRatio: 30, pbRatio: 40, dividendYield: 0.5, debtToEquity: 1.5, returnOnEquity: 150, grossMarginPct: 45, moatScore: 88, buffettScore: 80, notes: 'Ecosystem moat; Buffett\'s largest public position.' },
  { symbol: 'MSFT',  name: 'Microsoft', sector: 'Technology', industry: 'Software', peRatio: 35, pbRatio: 11, dividendYield: 0.7, debtToEquity: 0.3, returnOnEquity: 38, grossMarginPct: 70, moatScore: 90, buffettScore: 78, notes: 'Switching costs + cloud network effects.' },
  { symbol: 'GOOGL', name: 'Alphabet', sector: 'Communication Services', industry: 'Internet Content', peRatio: 24, pbRatio: 6, dividendYield: 0.4, debtToEquity: 0.1, returnOnEquity: 28, grossMarginPct: 56, moatScore: 85, buffettScore: 75, notes: 'Dominant search; cash machine.' },
  { symbol: 'V',     name: 'Visa', sector: 'Financial Services', industry: 'Credit Services', peRatio: 30, pbRatio: 14, dividendYield: 0.8, debtToEquity: 0.5, returnOnEquity: 45, grossMarginPct: 97, moatScore: 92, buffettScore: 82, notes: 'Toll road on global payments.' },
  { symbol: 'MA',    name: 'Mastercard', sector: 'Financial Services', industry: 'Credit Services', peRatio: 33, pbRatio: 60, dividendYield: 0.6, debtToEquity: 2.4, returnOnEquity: 170, grossMarginPct: 100, moatScore: 92, buffettScore: 80, notes: 'Same moat as V, higher leverage.' },
  { symbol: 'JNJ',   name: 'Johnson & Johnson', sector: 'Healthcare', industry: 'Drug Manufacturers', peRatio: 18, pbRatio: 5, dividendYield: 3.2, debtToEquity: 0.5, returnOnEquity: 23, grossMarginPct: 68, moatScore: 80, buffettScore: 82, notes: 'Dividend aristocrat, diversified healthcare.' },
  { symbol: 'PG',    name: 'Procter & Gamble', sector: 'Consumer Defensive', industry: 'Household Products', peRatio: 25, pbRatio: 8, dividendYield: 2.4, debtToEquity: 0.7, returnOnEquity: 30, grossMarginPct: 51, moatScore: 82, buffettScore: 80, notes: 'Brand moat, consistent cash.' },
  { symbol: 'WMT',   name: 'Walmart', sector: 'Consumer Defensive', industry: 'Discount Stores', peRatio: 28, pbRatio: 7, dividendYield: 1.2, debtToEquity: 0.8, returnOnEquity: 18, grossMarginPct: 24, moatScore: 78, buffettScore: 72, notes: 'Scale advantage; e-commerce catching up.' },
  { symbol: 'COST',  name: 'Costco', sector: 'Consumer Defensive', industry: 'Discount Stores', peRatio: 50, pbRatio: 20, dividendYield: 0.5, debtToEquity: 0.5, returnOnEquity: 30, grossMarginPct: 12, moatScore: 85, buffettScore: 70, notes: 'Membership model, ruthless pricing.' },
  // HD, LOW, MCD, ABBV all have negative book value due to aggressive buybacks;
  // that makes P/B, D/E and ROE mechanically nonsensical. Seed them as null so
  // the analyzer can't trust garbage; SEC EDGAR refresh will compute real
  // numbers (which for these names will still be unusual — the agent should
  // read the sector primer before reacting).
  { symbol: 'HD',    name: 'Home Depot', sector: 'Consumer Cyclical', industry: 'Home Improvement', peRatio: 24, pbRatio: null, dividendYield: 2.3, debtToEquity: null, returnOnEquity: null, grossMarginPct: 34, moatScore: 80, buffettScore: 72, notes: 'Duopoly with LOW; cyclical. Negative book value from buybacks — trust EDGAR refresh, not seeded ratios.' },
  { symbol: 'MCD',   name: "McDonald's", sector: 'Consumer Cyclical', industry: 'Restaurants', peRatio: 24, pbRatio: null, dividendYield: 2.4, debtToEquity: null, returnOnEquity: null, grossMarginPct: 57, moatScore: 85, buffettScore: 75, notes: 'Real-estate moat + global brand. Negative book value from buybacks — trust EDGAR refresh.' },
  { symbol: 'PEP',   name: 'PepsiCo', sector: 'Consumer Defensive', industry: 'Beverages', peRatio: 23, pbRatio: 12, dividendYield: 3.4, debtToEquity: 2.5, returnOnEquity: 48, grossMarginPct: 54, moatScore: 85, buffettScore: 80, notes: 'Frito-Lay gives it a broader moat than KO.' },
  { symbol: 'UNH',   name: 'UnitedHealth', sector: 'Healthcare', industry: 'Healthcare Plans', peRatio: 18, pbRatio: 5, dividendYield: 1.8, debtToEquity: 0.7, returnOnEquity: 24, grossMarginPct: 24, moatScore: 75, buffettScore: 70, notes: 'Scale + data; regulatory risk.' },
  { symbol: 'XOM',   name: 'ExxonMobil', sector: 'Energy', industry: 'Oil & Gas', peRatio: 12, pbRatio: 2, dividendYield: 3.5, debtToEquity: 0.2, returnOnEquity: 20, grossMarginPct: 33, moatScore: 60, buffettScore: 65, notes: 'Scale, integrated; commodity exposure.' },
  { symbol: 'CVX',   name: 'Chevron', sector: 'Energy', industry: 'Oil & Gas', peRatio: 13, pbRatio: 1.7, dividendYield: 4.1, debtToEquity: 0.2, returnOnEquity: 15, grossMarginPct: 35, moatScore: 58, buffettScore: 65, notes: 'Buffett favourite; dividend aristocrat.' },
  { symbol: 'LMT',   name: 'Lockheed Martin', sector: 'Industrials', industry: 'Defense', peRatio: 18, pbRatio: 20, dividendYield: 2.9, debtToEquity: 3.1, returnOnEquity: 85, grossMarginPct: 13, moatScore: 75, buffettScore: 70, notes: 'Dept of Defense customer concentration.' },
  { symbol: 'ADP',   name: 'Automatic Data Processing', sector: 'Industrials', industry: 'Staffing & Employment', peRatio: 28, pbRatio: 18, dividendYield: 2.3, debtToEquity: 0.7, returnOnEquity: 60, grossMarginPct: 45, moatScore: 78, buffettScore: 75, notes: 'Dividend aristocrat; sticky payroll moat.' },
  { symbol: 'ABBV',  name: 'AbbVie', sector: 'Healthcare', industry: 'Drug Manufacturers', peRatio: 16, pbRatio: 40, dividendYield: 3.8, debtToEquity: 8, returnOnEquity: 70, grossMarginPct: 70, moatScore: 70, buffettScore: 75, notes: 'Humira cliff behind it; dividend growth.' },
  { symbol: 'TXN',   name: 'Texas Instruments', sector: 'Technology', industry: 'Semiconductors', peRatio: 28, pbRatio: 11, dividendYield: 2.8, debtToEquity: 0.9, returnOnEquity: 40, grossMarginPct: 62, moatScore: 78, buffettScore: 75, notes: 'Analog chips moat, dividend grower.' },
  { symbol: 'LOW',   name: "Lowe's", sector: 'Consumer Cyclical', industry: 'Home Improvement', peRatio: 20, pbRatio: null, dividendYield: 1.8, debtToEquity: null, returnOnEquity: null, grossMarginPct: 33, moatScore: 77, buffettScore: 72, notes: 'Second player in HD/LOW duopoly. Negative book value from buybacks — trust EDGAR refresh.' },
  { symbol: 'SPGI',  name: 'S&P Global', sector: 'Financial Services', industry: 'Financial Data', peRatio: 35, pbRatio: 5, dividendYield: 0.8, debtToEquity: 0.6, returnOnEquity: 12, grossMarginPct: 68, moatScore: 88, buffettScore: 78, notes: 'Ratings duopoly with MCO; regulated moat.' },
  { symbol: 'MCO',   name: "Moody's", sector: 'Financial Services', industry: 'Financial Data', peRatio: 40, pbRatio: 28, dividendYield: 0.8, debtToEquity: 2.3, returnOnEquity: 70, grossMarginPct: 72, moatScore: 90, buffettScore: 80, notes: 'Buffett holding; ratings oligopoly.' },
  { symbol: 'BLK',   name: 'BlackRock', sector: 'Financial Services', industry: 'Asset Management', peRatio: 22, pbRatio: 3.2, dividendYield: 2.3, debtToEquity: 0.7, returnOnEquity: 15, grossMarginPct: 49, moatScore: 82, buffettScore: 74, notes: 'Largest asset manager; iShares ETFs.' },
  // Ballast ETFs.
  { symbol: 'VOO',   name: 'Vanguard S&P 500 ETF', sector: 'ETF', industry: 'Index', peRatio: 22, pbRatio: 4, dividendYield: 1.3, debtToEquity: null, returnOnEquity: null, grossMarginPct: null, moatScore: 60, buffettScore: 70, notes: 'Buffett\'s recommended default. Low cost, diversified.' },
  { symbol: 'SCHD',  name: 'Schwab U.S. Dividend Equity ETF', sector: 'ETF', industry: 'Index', peRatio: 16, pbRatio: 3, dividendYield: 3.5, debtToEquity: null, returnOnEquity: null, grossMarginPct: null, moatScore: 55, buffettScore: 75, notes: 'Quality dividend-focused index.' },
  { symbol: 'VIG',   name: 'Vanguard Dividend Appreciation', sector: 'ETF', industry: 'Index', peRatio: 22, pbRatio: 5, dividendYield: 1.8, debtToEquity: null, returnOnEquity: null, grossMarginPct: null, moatScore: 55, buffettScore: 72, notes: 'Dividend growers.' },
  { symbol: 'VTI',   name: 'Vanguard Total Stock Market', sector: 'ETF', industry: 'Index', peRatio: 21, pbRatio: 4, dividendYield: 1.4, debtToEquity: null, returnOnEquity: null, grossMarginPct: null, moatScore: 58, buffettScore: 68, notes: 'Whole US market in one ticker.' },
];

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'owner@agbro.local' },
    update: {},
    create: {
      email: 'owner@agbro.local',
      name: 'AgBro Owner',
    },
  });

  await prisma.account.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      expectedAnnualPct: 12.0,
      riskTolerance: 'moderate',
      maxPositionPct: Number(process.env.MAX_POSITION_PCT ?? 15),
      maxDailyTrades: Number(process.env.MAX_DAILY_TRADES ?? 3),
      minCashReservePct: Number(process.env.MIN_CASH_RESERVE_PCT ?? 10),
    },
  });

  await prisma.strategy.upsert({
    where: { id: 'seed-strategy-v1' },
    update: {},
    create: {
      id: 'seed-strategy-v1',
      userId: user.id,
      name: 'Buffett-style Value + Dividend Core',
      isActive: true,
      version: 1,
      buffettScore: 85,
      summary:
        'Buy durable-moat businesses trading below intrinsic value with a 20%+ margin of safety. ' +
        'Prefer dividend payers with ROE > 15% and manageable debt. Ballast with broad-market ETFs. ' +
        'Hold for years. Only sell on thesis break or materially better opportunity.',
      rules: {
        minMarginOfSafetyPct: 20,
        minMoatSignal: 'narrow',
        minROEPct: 15,
        maxDebtToEquity: 1.5,
        preferredSectors: [
          'Consumer Defensive',
          'Financial Services',
          'Healthcare',
          'Technology',
          'Industrials',
          'ETF',
        ],
        avoidedSectors: [],
        preferDividend: true,
        minDividendYield: 0,
        maxPosition: 15,
        minCashReserve: 10,
        maxDailyTrades: 3,
        allowDayTrades: false,
        targetAnnualReturnPct: 12,
        holdingPeriodBias: 'long',
        // Buffett Core exit rules: never sell on price alone (matches how
        // Buffett actually sold IBM — circle-of-competence realization — and
        // the airlines in 2020 — thesis break, not a stop). No stop-loss;
        // Buffett himself doesn't use one. Thesis review every 180 days.
        thesisReviewDays: 180,
        targetSellPct: null,
        timeStopDays: null,
        moatBreakExit: true,
        fundamentalsDegradationExit: true,
        dividendSafetyExit: true,
        rebalanceOnly: false,
      },
    },
  });

  for (const s of STOCKS) {
    // Mark seeded fundamentals explicitly so the agent (and the UI) knows to
    // prefer EDGAR-backed data when available. Don't overwrite a row that's
    // already been refreshed from EDGAR.
    await prisma.stock.upsert({
      where: { symbol: s.symbol },
      update: {
        name: s.name,
        sector: s.sector,
        industry: s.industry,
        moatScore: s.moatScore,
        buffettScore: s.buffettScore,
        notes: s.notes,
        onWatchlist: true,
      },
      create: {
        ...s,
        onWatchlist: true,
        lastAnalyzedAt: new Date(),
        fundamentalsSource: 'seed',
      },
    });
  }

  // Only seed Day 0 once per user to keep re-running the seed idempotent.
  const hasCharter = await prisma.brainEntry.findFirst({
    where: { userId: user.id, kind: 'principle', title: 'Day 0 — The Charter' },
  });
  if (!hasCharter) {
    await prisma.brainEntry.create({
      data: {
        userId: user.id,
        kind: 'principle',
        title: 'Day 0 — The Charter',
        body:
          'AgBro exists to preserve principal first, and grow it second. ' +
          'No options. No shorting. No margin. Minimal day trading. ' +
          'Every trade must pass the internal analyzer AND carry a written Bull/Bear case. ' +
          'Margin of safety is non-negotiable. We learn in public: every closed position gets a post-mortem.',
        tags: ['charter', 'principles'],
      },
    });
  }

  // ── FOMC calendar ───────────────────────────────────────────────────────
  // The Fed publishes meeting dates a full year in advance. Hardcoded here
  // because the schedule is stable and there's no free API. Update yearly.
  // Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
  const FOMC_MEETINGS: Array<{ date: string; description: string }> = [
    // 2026 (announced Sep 2025)
    { date: '2026-01-28', description: 'FOMC meeting (statement + press conference)' },
    { date: '2026-03-18', description: 'FOMC meeting (SEP + press conference)' },
    { date: '2026-04-29', description: 'FOMC meeting (statement + press conference)' },
    { date: '2026-06-17', description: 'FOMC meeting (SEP + press conference)' },
    { date: '2026-07-29', description: 'FOMC meeting (statement + press conference)' },
    { date: '2026-09-16', description: 'FOMC meeting (SEP + press conference)' },
    { date: '2026-10-28', description: 'FOMC meeting (statement + press conference)' },
    { date: '2026-12-09', description: 'FOMC meeting (SEP + press conference)' },
    // 2025 (remainder)
    { date: '2025-12-10', description: 'FOMC meeting (SEP + press conference)' },
  ];
  for (const m of FOMC_MEETINGS) {
    const occursAt = new Date(`${m.date}T18:00:00Z`); // 2pm ET == 19:00 UTC (EST) / 18:00 UTC (EDT). 18:00 UTC is close enough for blackout math.
    // Idempotent: skip if a FOMC event already exists for this date.
    const existing = await prisma.marketEvent.findFirst({
      where: { kind: 'fomc', occursAt: { gte: new Date(`${m.date}T00:00:00Z`), lt: new Date(`${m.date}T23:59:59Z`) } },
    });
    if (!existing) {
      await prisma.marketEvent.create({
        data: { kind: 'fomc', occursAt, description: m.description },
      });
    }
  }

  console.log(`Seeded ${STOCKS.length} stocks, 1 user, 1 account, 1 strategy, 1 brain entry, ${FOMC_MEETINGS.length} FOMC meetings.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
