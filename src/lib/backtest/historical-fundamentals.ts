// Historical fundamentals fetcher — walks SEC EDGAR's companyfacts feed
// for a symbol, extracts quarterly metrics, and persists one
// StockFundamentalsSnapshot row per filing date. Used by the backtester
// to evaluate strategy filters at historical decision points without
// look-ahead bias.
//
// Reuses the live EDGAR wrappers in src/lib/data/sec-edgar.ts (ticker
// lookup, User-Agent policy, rate-limit awareness). This module is
// distinct because live fundamentals want ONE snapshot (latest); the
// backtester wants the FULL time series.
//
// Data quality notes:
//   - XBRL standardisation really kicked in around 2009. Pre-2009
//     coverage is sparse and concept-inconsistent.
//   - Some concepts (dividend yield, book value per share) are derived
//     from multiple tags and may be missing for share-class-heavy
//     filers. We store null rather than fudging.
//   - EDGAR's companyfacts feed stamps each fact with a 'filed' date —
//     the day the document hit EDGAR. We use THAT as asOfDate, not the
//     period end, because pre-filing data wasn't publicly known.

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const FACTS_URL = (cik10: string) =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;

const USER_AGENT =
  process.env.AGBRO_SEC_USER_AGENT ??
  'AgBro/1.0 (agbro-trading@example.com) value-investing agent';

// Same tag priorities as the live fetcher.
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
  equity: [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  ],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  shortTermDebt: ['LongTermDebtCurrent', 'ShortTermBorrowings', 'CommercialPaper'],
  sharesOutstanding: [
    'CommonStockSharesOutstanding',
    'EntityCommonStockSharesOutstanding',
    'WeightedAverageNumberOfSharesOutstandingBasic',
  ],
  bookValue: ['StockholdersEquity'],
};

type Fact = {
  end: string; // period end YYYY-MM-DD
  val: number;
  fp?: string; // fiscal period Q1 / Q2 / Q3 / FY
  form?: string; // 10-Q, 10-K, etc.
  filed: string; // filing date YYYY-MM-DD
  fy?: number;
};

type FactsJson = {
  facts?: {
    'us-gaap'?: Record<
      string,
      {
        units?: Record<string, Fact[]>;
      }
    >;
  };
};

async function secFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
}

async function cikForSymbol(symbol: string): Promise<string | null> {
  const res = await secFetch(TICKERS_URL);
  if (!res.ok) {
    log.warn('historical_fundamentals.tickers_failed', { status: res.status });
    return null;
  }
  const data = (await res.json()) as Record<string, { ticker: string; cik_str: number }>;
  for (const row of Object.values(data)) {
    if (row.ticker.toUpperCase() === symbol.toUpperCase()) {
      return String(row.cik_str).padStart(10, '0');
    }
  }
  return null;
}

// Pick the most specific fact array from a list of tag priorities.
function firstAvailable(
  facts: FactsJson['facts'],
  tags: string[],
  unit: string
): Fact[] {
  if (!facts?.['us-gaap']) return [];
  for (const tag of tags) {
    const node = facts['us-gaap'][tag];
    const arr = node?.units?.[unit];
    if (arr && arr.length > 0) return arr;
  }
  return [];
}

// Pull all available facts of a given flavour, keyed by filing date +
// period end so we can correlate across metrics. Annual numbers come
// from 10-K (fp='FY'); quarterly numbers come from 10-Q. TTM
// computation uses rolling 4-quarter sums where needed.
function groupByFiled(facts: Fact[]): Map<string, Fact> {
  // Keep one fact per filing date — if multiple periods reported in the
  // same 10-Q (rare but happens), use the most recent period end.
  const byFiled = new Map<string, Fact>();
  for (const f of facts) {
    const existing = byFiled.get(f.filed);
    if (!existing || existing.end < f.end) byFiled.set(f.filed, f);
  }
  return byFiled;
}

// Build TTM (trailing 12 months) EPS as of each filing date by summing
// the most recent 4 quarterly EPS entries with period-end <= filing date.
function ttmEpsAtFiled(epsFacts: Fact[]): Map<string, number> {
  const quarterlyOnly = epsFacts.filter((f) => f.fp && f.fp.startsWith('Q'));
  const result = new Map<string, number>();
  // For each filing date in the quarterly series, take the 4 most
  // recent period-ends <= that filing date and sum.
  for (const f of quarterlyOnly) {
    const priorQuarters = quarterlyOnly
      .filter((q) => q.end <= f.end)
      .sort((a, b) => (a.end < b.end ? 1 : -1))
      .slice(0, 4);
    if (priorQuarters.length === 4) {
      const sum = priorQuarters.reduce((s, q) => s + q.val, 0);
      result.set(f.filed, sum);
    }
  }
  return result;
}

type RowAtFiled = {
  asOfDate: Date;
  epsTTM: number | null;
  netIncomeTTM: number | null;
  equity: number | null;
  totalDebt: number | null;
  revenueTTM: number | null;
  costTTM: number | null;
  sharesOutstanding: number | null;
  dividendYield: number | null; // not derivable from companyfacts alone; null for now
};

function buildRows(factsJson: FactsJson): RowAtFiled[] {
  const facts = factsJson.facts;
  const epsFacts = firstAvailable(facts, TAGS.eps, 'USD/shares');
  const netIncomeFacts = firstAvailable(facts, TAGS.netIncome, 'USD');
  const equityFacts = firstAvailable(facts, TAGS.equity, 'USD');
  const longTermDebtFacts = firstAvailable(facts, TAGS.longTermDebt, 'USD');
  const shortTermDebtFacts = firstAvailable(facts, TAGS.shortTermDebt, 'USD');
  const revenueFacts = firstAvailable(facts, TAGS.revenues, 'USD');
  const costFacts = firstAvailable(facts, TAGS.costOfRevenue, 'USD');
  const sharesFacts = firstAvailable(facts, TAGS.sharesOutstanding, 'shares');

  const ttmEps = ttmEpsAtFiled(epsFacts);
  const ttmNetIncome = rollingTTM(netIncomeFacts);
  const ttmRevenue = rollingTTM(revenueFacts);
  const ttmCost = rollingTTM(costFacts);

  const equityByFiled = groupByFiled(equityFacts);
  const ltByFiled = groupByFiled(longTermDebtFacts);
  const stByFiled = groupByFiled(shortTermDebtFacts);
  const sharesByFiled = groupByFiled(sharesFacts);

  // Union of all filing dates we have any data for.
  const allFiled = new Set<string>([
    ...ttmEps.keys(),
    ...ttmNetIncome.keys(),
    ...equityByFiled.keys(),
    ...ltByFiled.keys(),
    ...stByFiled.keys(),
    ...sharesByFiled.keys(),
    ...ttmRevenue.keys(),
    ...ttmCost.keys(),
  ]);

  const rows: RowAtFiled[] = [];
  for (const filed of allFiled) {
    const lt = ltByFiled.get(filed)?.val;
    const st = stByFiled.get(filed)?.val;
    const totalDebt =
      lt != null || st != null ? (lt ?? 0) + (st ?? 0) : null;
    rows.push({
      asOfDate: new Date(filed + 'T00:00:00Z'),
      epsTTM: ttmEps.get(filed) ?? null,
      netIncomeTTM: ttmNetIncome.get(filed) ?? null,
      equity: equityByFiled.get(filed)?.val ?? null,
      totalDebt,
      revenueTTM: ttmRevenue.get(filed) ?? null,
      costTTM: ttmCost.get(filed) ?? null,
      sharesOutstanding: sharesByFiled.get(filed)?.val ?? null,
      dividendYield: null,
    });
  }
  return rows.sort((a, b) => a.asOfDate.getTime() - b.asOfDate.getTime());
}

function rollingTTM(facts: Fact[]): Map<string, number> {
  const quarterly = facts
    .filter((f) => f.fp && f.fp.startsWith('Q'))
    .sort((a, b) => (a.end < b.end ? -1 : 1));
  const result = new Map<string, number>();
  for (let i = 0; i < quarterly.length; i++) {
    const q = quarterly[i];
    const window = quarterly.filter((x) => x.end <= q.end).slice(-4);
    if (window.length === 4) {
      result.set(q.filed, window.reduce((s, x) => s + x.val, 0));
    }
  }
  return result;
}

// Fetch + persist full historical snapshots for a symbol. Idempotent:
// upserts by (symbol, asOfDate) so re-running for the same symbol
// refreshes rows without duplicating. Safe to call at backtest start
// for each universe symbol — cheap if already populated.
export async function backfillHistoricalFundamentals(
  symbol: string
): Promise<{ symbol: string; rowsWritten: number; skippedReason?: string }> {
  // Skip if we already have >= 20 snapshots (≈ 5 years of quarterlies)
  // — the data doesn't change retroactively so re-fetching is wasted
  // Alpaca+SEC calls. Refresh is manual if ever needed.
  const existing = await prisma.stockFundamentalsSnapshot.count({ where: { symbol } });
  if (existing >= 20) {
    return { symbol, rowsWritten: 0, skippedReason: 'already backfilled' };
  }

  const cik = await cikForSymbol(symbol).catch(() => null);
  if (!cik) {
    return { symbol, rowsWritten: 0, skippedReason: 'CIK not found' };
  }
  const res = await secFetch(FACTS_URL(cik));
  if (!res.ok) {
    log.warn('historical_fundamentals.facts_failed', { symbol, status: res.status });
    return { symbol, rowsWritten: 0, skippedReason: `EDGAR ${res.status}` };
  }
  const json = (await res.json()) as FactsJson;
  const rows = buildRows(json);
  if (rows.length === 0) {
    return { symbol, rowsWritten: 0, skippedReason: 'no facts parsed' };
  }

  let written = 0;
  for (const row of rows) {
    // Derive ratios that don't live directly in companyfacts. ROE = TTM
    // net income / equity (latest). D/E = debt / equity. Gross margin =
    // (revenue - cost) / revenue.
    const roe =
      row.netIncomeTTM != null && row.equity != null && row.equity > 0
        ? (row.netIncomeTTM / row.equity) * 100
        : null;
    const de =
      row.totalDebt != null && row.equity != null && row.equity > 0
        ? row.totalDebt / row.equity
        : null;
    const gm =
      row.revenueTTM != null && row.costTTM != null && row.revenueTTM > 0
        ? ((row.revenueTTM - row.costTTM) / row.revenueTTM) * 100
        : null;
    const bv =
      row.equity != null && row.sharesOutstanding != null && row.sharesOutstanding > 0
        ? row.equity / row.sharesOutstanding
        : null;
    await prisma.stockFundamentalsSnapshot.upsert({
      where: { symbol_asOfDate: { symbol, asOfDate: row.asOfDate } },
      create: {
        symbol,
        asOfDate: row.asOfDate,
        epsTTM: row.epsTTM,
        returnOnEquity: roe,
        debtToEquity: de,
        grossMarginPct: gm,
        bookValuePerShare: bv,
        sharesOutstanding: row.sharesOutstanding,
        peRatio: null, // needs price; populated on demand by lookup + bar fetch
        dividendYield: null,
        source: 'edgar',
      },
      update: {
        epsTTM: row.epsTTM,
        returnOnEquity: roe,
        debtToEquity: de,
        grossMarginPct: gm,
        bookValuePerShare: bv,
        sharesOutstanding: row.sharesOutstanding,
      },
    });
    written += 1;
  }
  log.info('historical_fundamentals.backfilled', { symbol, rowsWritten: written });
  return { symbol, rowsWritten: written };
}

// Best-effort backfill for a list of symbols. Sequential + short delay
// to respect SEC's 10/sec limit with headroom.
export async function backfillMany(symbols: string[]) {
  const results: Array<Awaited<ReturnType<typeof backfillHistoricalFundamentals>>> = [];
  for (const sym of symbols) {
    try {
      const r = await backfillHistoricalFundamentals(sym);
      results.push(r);
    } catch (err) {
      log.error('historical_fundamentals.backfill_exception', err, { symbol: sym });
      results.push({
        symbol: sym,
        rowsWritten: 0,
        skippedReason: (err as Error).message,
      });
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return results;
}
