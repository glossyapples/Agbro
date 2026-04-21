// SEC EDGAR XBRL client. Free, authoritative. Every paid fundamentals
// provider (Polygon, FMP, Yahoo, Bloomberg) sources from the same filings
// we're pulling directly.
//
// Two endpoints we rely on:
//   1. https://www.sec.gov/files/company_tickers.json  (ticker → CIK mapping)
//   2. https://data.sec.gov/api/xbrl/companyfacts/CIK{padded10}.json
//        (every XBRL fact ever filed for that CIK)
//
// SEC's fair-use policy requires a descriptive User-Agent with a contact
// email. Set AGBRO_SEC_USER_AGENT; we fall back to a sensible default so
// local dev works out of the box. They rate-limit ~10 req/sec; we stay well
// under that via the per-symbol usage pattern (the agent refreshes one at a
// time during a run, the CLI paces itself).

import { log } from '@/lib/logger';

// SEC requires a descriptive User-Agent with a contact email per their fair-
// use policy. MUST be pure ASCII — HTTP header values are ByteStrings, any
// non-ASCII character (em-dash, fancy quotes, etc.) blows up the Headers
// constructor before the request is made.
const USER_AGENT =
  process.env.AGBRO_SEC_USER_AGENT ??
  'AgBro/1.0 (agbro-trading@example.com) value-investing agent';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const FACTS_URL = (cik10: string) =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;

// The XBRL tag soup. Companies vary in which concept they report; we try
// primary tag first and fall through to sensible fallbacks. Skipping a tag
// results in a null in that field — the analyzer already handles null.
const TAGS = {
  eps: ['EarningsPerShareBasic', 'EarningsPerShareDiluted'],
  revenues: [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueNet',
  ],
  costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
  netIncome: ['NetIncomeLoss'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  shortTermDebt: ['LongTermDebtCurrent', 'ShortTermBorrowings', 'CommercialPaper'],
  sharesOutstanding: [
    'CommonStockSharesOutstanding',
    'EntityCommonStockSharesOutstanding',
    'WeightedAverageNumberOfSharesOutstandingBasic',
  ],
  dividendPerShare: ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'],
} as const;

export type FundamentalsSnapshot = {
  symbol: string;
  cik: string;
  asOf: string; // ISO date of the most recent filing we used
  source: 'edgar';
  // Raw extracted values
  epsTTM: number | null;
  bookValuePerShare: number | null;
  dividendPerShare: number | null;
  sharesOutstanding: number | null;
  totalDebt: number | null;
  totalEquity: number | null;
  netIncome: number | null;
  revenues: number | null;
  costOfRevenue: number | null;
  // Derived convenience fields
  returnOnEquityPct: number | null;
  grossMarginPct: number | null;
  debtToEquity: number | null;
  epsGrowthPct5y: number | null;
  // Anything we couldn't extract, named so the caller can log and the UI
  // can surface "data quality: partial".
  missingFields: string[];
};

// -------------------- Ticker → CIK --------------------

let _cikCache: Map<string, string> | null = null;

async function loadCikMap(): Promise<Map<string, string>> {
  if (_cikCache) return _cikCache;
  const res = await fetch(TICKERS_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`sec ticker list ${res.status}`);
  // Shape: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, ... }
  const data = (await res.json()) as Record<
    string,
    { cik_str: number; ticker: string; title: string }
  >;
  const m = new Map<string, string>();
  for (const row of Object.values(data)) {
    m.set(row.ticker.toUpperCase(), String(row.cik_str).padStart(10, '0'));
  }
  _cikCache = m;
  return m;
}

export async function lookupCik(symbol: string): Promise<string | null> {
  const map = await loadCikMap();
  // EDGAR uses dash for share classes; Alpaca + our watchlist sometimes use dot
  // (e.g. BRK.B ↔ BRK-B). Try both.
  const candidates = [symbol.toUpperCase(), symbol.toUpperCase().replace('.', '-'), symbol.toUpperCase().replace('-', '.')];
  for (const c of candidates) {
    const cik = map.get(c);
    if (cik) return cik;
  }
  return null;
}

// -------------------- companyfacts fetch --------------------

type XbrlFact = {
  units: Record<string, Array<{ end: string; val: number; fy?: number; fp?: string; form?: string; filed?: string }>>;
};
type CompanyFacts = {
  cik: number;
  entityName: string;
  facts: { 'us-gaap'?: Record<string, XbrlFact>; dei?: Record<string, XbrlFact> };
};

export async function fetchCompanyFacts(cik10: string): Promise<CompanyFacts> {
  const res = await fetch(FACTS_URL(cik10), { headers: { 'User-Agent': USER_AGENT } });
  if (res.status === 404) throw new Error(`sec companyfacts 404 for CIK ${cik10}`);
  if (!res.ok) throw new Error(`sec companyfacts ${res.status}`);
  return (await res.json()) as CompanyFacts;
}

// -------------------- XBRL extractors --------------------

// Pick the most recent annual (10-K) value for a given concept, searching the
// given tag list in order. Returns { val, end } or null.
function pickLatestAnnual(
  facts: CompanyFacts,
  tags: readonly string[],
  preferredUnit: string
): { val: number; end: string; unit: string } | null {
  const pool = facts.facts['us-gaap'] ?? {};
  for (const tag of tags) {
    const fact = pool[tag] ?? facts.facts.dei?.[tag];
    if (!fact) continue;
    const unitKey = Object.keys(fact.units).find((u) => u === preferredUnit) ?? Object.keys(fact.units)[0];
    const entries = fact.units[unitKey] ?? [];
    const annual = entries.filter((e) => e.form === '10-K');
    const source = annual.length > 0 ? annual : entries;
    if (source.length === 0) continue;
    // Prefer latest by `end` date, then by `filed`.
    const latest = source.reduce((a, b) => (a.end > b.end ? a : b));
    return { val: latest.val, end: latest.end, unit: unitKey };
  }
  return null;
}

// For EPS growth we need the historical annual series.
function annualSeries(
  facts: CompanyFacts,
  tags: readonly string[],
  preferredUnit: string
): Array<{ val: number; end: string; fy?: number }> {
  const pool = facts.facts['us-gaap'] ?? {};
  for (const tag of tags) {
    const fact = pool[tag];
    if (!fact) continue;
    const unitKey = Object.keys(fact.units).find((u) => u === preferredUnit) ?? Object.keys(fact.units)[0];
    const entries = fact.units[unitKey] ?? [];
    // One datapoint per fiscal year: latest filing for each fy.
    const byFy = new Map<number, { val: number; end: string; fy?: number }>();
    for (const e of entries) {
      if (e.form !== '10-K' || !e.fy) continue;
      const prev = byFy.get(e.fy);
      if (!prev || e.end > prev.end) byFy.set(e.fy, { val: e.val, end: e.end, fy: e.fy });
    }
    return [...byFy.values()].sort((a, b) => (a.fy ?? 0) - (b.fy ?? 0));
  }
  return [];
}

// CAGR from oldest to newest, rounded to 1 decimal. Returns null when we can't
// compute (sign change, missing data, ≤1 data point, division by zero).
function cagr(series: Array<{ val: number }>, years = 5): number | null {
  const pts = series.slice(-years - 1);
  if (pts.length < 2) return null;
  const first = pts[0].val;
  const last = pts[pts.length - 1].val;
  if (first <= 0 || last <= 0) return null; // CAGR undefined over sign changes
  const n = pts.length - 1;
  return (Math.pow(last / first, 1 / n) - 1) * 100;
}

export function extractFundamentals(
  symbol: string,
  cik: string,
  facts: CompanyFacts
): FundamentalsSnapshot {
  const missing: string[] = [];

  const get = (name: keyof typeof TAGS, unit: string) => {
    const r = pickLatestAnnual(facts, TAGS[name], unit);
    if (!r) missing.push(name);
    return r;
  };

  const eps = get('eps', 'USD/shares');
  const rev = get('revenues', 'USD');
  const cogs = get('costOfRevenue', 'USD');
  const netIncome = get('netIncome', 'USD');
  const equity = get('equity', 'USD');
  const ltd = get('longTermDebt', 'USD');
  const std = pickLatestAnnual(facts, TAGS.shortTermDebt, 'USD'); // optional, don't push to missing
  const shares = get('sharesOutstanding', 'shares');
  const dps = get('dividendPerShare', 'USD/shares');

  const totalDebt = ltd ? ltd.val + (std?.val ?? 0) : null;
  const equityVal = equity?.val ?? null;
  const sharesVal = shares?.val ?? null;

  const bookValuePerShare =
    equityVal != null && sharesVal != null && sharesVal > 0 ? equityVal / sharesVal : null;

  const returnOnEquityPct =
    netIncome?.val != null && equityVal != null && equityVal > 0
      ? (netIncome.val / equityVal) * 100
      : null;

  const grossMarginPct =
    rev?.val != null && cogs?.val != null && rev.val > 0
      ? ((rev.val - cogs.val) / rev.val) * 100
      : null;

  const debtToEquity =
    totalDebt != null && equityVal != null && equityVal > 0 ? totalDebt / equityVal : null;

  const epsSeries = annualSeries(facts, TAGS.eps, 'USD/shares');
  const epsGrowthPct5y = cagr(epsSeries, 5);

  const asOf = [eps?.end, rev?.end, equity?.end, netIncome?.end]
    .filter((d): d is string => !!d)
    .sort()
    .pop() ?? new Date().toISOString().slice(0, 10);

  return {
    symbol: symbol.toUpperCase(),
    cik,
    asOf,
    source: 'edgar',
    epsTTM: eps?.val ?? null,
    bookValuePerShare,
    dividendPerShare: dps?.val ?? null,
    sharesOutstanding: sharesVal,
    totalDebt,
    totalEquity: equityVal,
    netIncome: netIncome?.val ?? null,
    revenues: rev?.val ?? null,
    costOfRevenue: cogs?.val ?? null,
    returnOnEquityPct,
    grossMarginPct,
    debtToEquity,
    epsGrowthPct5y,
    missingFields: missing,
  };
}

// High-level entry point — symbol → fundamentals, or null if the company
// can't be resolved against EDGAR (e.g. foreign ADR without EDGAR filings).
export async function fetchFundamentals(symbol: string): Promise<FundamentalsSnapshot | null> {
  try {
    const cik = await lookupCik(symbol);
    if (!cik) {
      log.warn('edgar.cik_not_found', { symbol });
      return null;
    }
    const facts = await fetchCompanyFacts(cik);
    return extractFundamentals(symbol, cik, facts);
  } catch (err) {
    log.error('edgar.fetch_failed', err, { symbol });
    return null;
  }
}
