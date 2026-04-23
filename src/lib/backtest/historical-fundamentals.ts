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
  start?: string; // period start YYYY-MM-DD (present for flow/duration facts)
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

// Duration classifiers. We can't trust `fp` alone: some filers report
// YTD values (6-month, 9-month) tagged Q2/Q3 that would double-count if
// summed. The authoritative signal is `start`..`end` duration.
function durationDays(f: Fact): number | null {
  if (!f.start) return null;
  const s = new Date(f.start + 'T00:00:00Z').getTime();
  const e = new Date(f.end + 'T00:00:00Z').getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return Math.round((e - s) / 86_400_000);
}

function isQuarterDuration(f: Fact): boolean {
  const d = durationDays(f);
  return d != null && d >= 80 && d <= 100;
}

function isAnnualDuration(f: Fact): boolean {
  const d = durationDays(f);
  return d != null && d >= 350 && d <= 380;
}

// For flow items (income statement), keep ONE fact per unique period end
// — take the most-recently-filed version so amendments/restatements win.
function dedupeByEnd(facts: Fact[]): Fact[] {
  const byEnd = new Map<string, Fact>();
  for (const f of facts) {
    const existing = byEnd.get(f.end);
    if (!existing || existing.filed < f.filed) byEnd.set(f.end, f);
  }
  return Array.from(byEnd.values()).sort((a, b) => (a.end < b.end ? -1 : 1));
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

export type TagDiagnostic = {
  tagsTried: string[];
  tagUsed: string | null;
  factCount: number;
  unit: string;
};

export type DurationBreakdown = {
  total: number;
  withStartDate: number;
  threeMonth: number; // 80-100 day duration
  annual: number; // 350-380 day duration
  sixMonthYTD: number; // 170-200 days (Q2 YTD)
  nineMonthYTD: number; // 260-290 days (Q3 YTD)
  other: number;
};

export type ParseDiagnostics = {
  tags: {
    netIncome: TagDiagnostic;
    equity: TagDiagnostic;
    revenue: TagDiagnostic;
    costOfRevenue: TagDiagnostic;
    eps: TagDiagnostic;
    longTermDebt: TagDiagnostic;
    shortTermDebt: TagDiagnostic;
    sharesOutstanding: TagDiagnostic;
  };
  durationBreakdown: {
    netIncome: DurationBreakdown;
    revenue: DurationBreakdown;
    costOfRevenue: DurationBreakdown;
    eps: DurationBreakdown;
  };
  ttmComputed: {
    netIncome: number;
    revenue: number;
    costOfRevenue: number;
    eps: number;
  };
  rows: {
    total: number;
    withNetIncomeTTM: number;
    withEquity: number;
    withROE: number;
    withDE: number;
    withMargin: number;
    withBookValue: number;
  };
};

function classifyDuration(facts: Fact[]): DurationBreakdown {
  const b: DurationBreakdown = {
    total: facts.length,
    withStartDate: 0,
    threeMonth: 0,
    annual: 0,
    sixMonthYTD: 0,
    nineMonthYTD: 0,
    other: 0,
  };
  for (const f of facts) {
    const d = durationDays(f);
    if (d == null) continue;
    b.withStartDate += 1;
    if (d >= 80 && d <= 100) b.threeMonth += 1;
    else if (d >= 350 && d <= 380) b.annual += 1;
    else if (d >= 170 && d <= 200) b.sixMonthYTD += 1;
    else if (d >= 260 && d <= 290) b.nineMonthYTD += 1;
    else b.other += 1;
  }
  return b;
}

function firstAvailableWithDiag(
  facts: FactsJson['facts'],
  tags: string[],
  unit: string
): { arr: Fact[]; diag: TagDiagnostic } {
  const diag: TagDiagnostic = { tagsTried: tags, tagUsed: null, factCount: 0, unit };
  if (!facts?.['us-gaap']) return { arr: [], diag };
  for (const tag of tags) {
    const node = facts['us-gaap'][tag];
    const arr = node?.units?.[unit];
    if (arr && arr.length > 0) {
      diag.tagUsed = tag;
      diag.factCount = arr.length;
      return { arr, diag };
    }
  }
  return { arr: [], diag };
}

// Union variant for tag lists where every entry is a SYNONYM (filers
// switched conventions between filings — e.g. JNJ uses StockholdersEquity
// for 2023+ filings but the longer-named NoncontrollingInterest variant
// for pre-2023). Combines facts across all tags and dedupes by period
// end so the same period reported under both tags doesn't double-count.
//
// Only safe when the listed tags genuinely measure the same concept.
// Don't use for EPS (basic vs diluted differ) or shortTermDebt (the
// listed tags are different debt categories that should sum, not unify).
function unionSynonymTagsWithDiag(
  facts: FactsJson['facts'],
  tags: string[],
  unit: string
): { arr: Fact[]; diag: TagDiagnostic } {
  const diag: TagDiagnostic = { tagsTried: tags, tagUsed: null, factCount: 0, unit };
  if (!facts?.['us-gaap']) return { arr: [], diag };
  const combined: Fact[] = [];
  const sources: string[] = [];
  for (const tag of tags) {
    const node = facts['us-gaap'][tag];
    const arr = node?.units?.[unit];
    if (arr && arr.length > 0) {
      combined.push(...arr);
      sources.push(`${tag}(${arr.length})`);
    }
  }
  if (combined.length === 0) return { arr: combined, diag };
  diag.tagUsed = sources.join(' + ');
  diag.factCount = combined.length;
  return { arr: combined, diag };
}

// Parse the EDGAR companyfacts JSON into per-filing rows AND a
// step-by-step diagnostic so we can see exactly where a symbol drops
// data (missing tag / wrong unit / no 3-month slices / etc).
export function parseWithDiagnostics(
  factsJson: FactsJson
): { rows: RowAtFiled[]; diagnostics: ParseDiagnostics } {
  const facts = factsJson.facts;
  // Synonym tags get unioned: TAGS.equity / TAGS.revenues /
  // TAGS.costOfRevenue / TAGS.longTermDebt are all alternative names for
  // the same underlying concept, and filers (notably JNJ) switch
  // between them across years. Without union we'd silently drop 15+
  // years of data per filer.
  //
  // First-available stays in place for tags that represent DIFFERENT
  // concepts: EPS basic vs diluted differ, sharesOutstanding's three
  // tags measure different things (point-in-time vs weighted average),
  // shortTermDebt's tags are distinct debt categories.
  const niRes = firstAvailableWithDiag(facts, TAGS.netIncome, 'USD');
  const eqRes = unionSynonymTagsWithDiag(facts, TAGS.equity, 'USD');
  const revRes = unionSynonymTagsWithDiag(facts, TAGS.revenues, 'USD');
  const costRes = unionSynonymTagsWithDiag(facts, TAGS.costOfRevenue, 'USD');
  const epsRes = firstAvailableWithDiag(facts, TAGS.eps, 'USD/shares');
  const ltRes = unionSynonymTagsWithDiag(facts, TAGS.longTermDebt, 'USD');
  const stRes = firstAvailableWithDiag(facts, TAGS.shortTermDebt, 'USD');
  const shRes = firstAvailableWithDiag(facts, TAGS.sharesOutstanding, 'shares');

  const ttmEps = rollingTTM(epsRes.arr);
  const ttmNetIncome = rollingTTM(niRes.arr);
  const ttmRevenue = rollingTTM(revRes.arr);
  const ttmCost = rollingTTM(costRes.arr);

  const equityByFiled = groupByFiled(eqRes.arr);
  const ltByFiled = groupByFiled(ltRes.arr);
  const stByFiled = groupByFiled(stRes.arr);
  const sharesByFiled = groupByFiled(shRes.arr);

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
  rows.sort((a, b) => a.asOfDate.getTime() - b.asOfDate.getTime());

  // Carry-forward balance-sheet items. Background: NetIncomeLoss is
  // reported many times — original 10-Q, the next 10-K's prior-period
  // section, subsequent quarters' comparison columns, restatements.
  // Each of those creates a new filed-date for the SAME period. But
  // StockholdersEquity is typically only reported once per period
  // (original filing) and NOT republished in later prior-period
  // sections. The original buildRows joined by exact filed-date, so any
  // NetIncome filing without a same-day equity got null equity → null
  // ROE → filter rejects "ROE n/a".
  //
  // Fix: walk rows chronologically and carry forward the most recently
  // reported equity / debt / shares. The point-in-time semantic is
  // "what was the latest known balance-sheet value as of this filing"
  // — which is exactly what an analyst would do.
  let lastEquity: number | null = null;
  let lastDebt: number | null = null;
  let lastShares: number | null = null;
  for (const r of rows) {
    if (r.equity != null) lastEquity = r.equity;
    else if (lastEquity != null) r.equity = lastEquity;

    if (r.totalDebt != null) lastDebt = r.totalDebt;
    else if (lastDebt != null) r.totalDebt = lastDebt;

    if (r.sharesOutstanding != null) lastShares = r.sharesOutstanding;
    else if (lastShares != null) r.sharesOutstanding = lastShares;
  }

  const diagnostics: ParseDiagnostics = {
    tags: {
      netIncome: niRes.diag,
      equity: eqRes.diag,
      revenue: revRes.diag,
      costOfRevenue: costRes.diag,
      eps: epsRes.diag,
      longTermDebt: ltRes.diag,
      shortTermDebt: stRes.diag,
      sharesOutstanding: shRes.diag,
    },
    durationBreakdown: {
      netIncome: classifyDuration(niRes.arr),
      revenue: classifyDuration(revRes.arr),
      costOfRevenue: classifyDuration(costRes.arr),
      eps: classifyDuration(epsRes.arr),
    },
    ttmComputed: {
      netIncome: ttmNetIncome.size,
      revenue: ttmRevenue.size,
      costOfRevenue: ttmCost.size,
      eps: ttmEps.size,
    },
    rows: {
      total: rows.length,
      withNetIncomeTTM: rows.filter((r) => r.netIncomeTTM != null).length,
      withEquity: rows.filter((r) => r.equity != null).length,
      withROE: rows.filter(
        (r) => r.netIncomeTTM != null && r.equity != null && r.equity > 0
      ).length,
      withDE: rows.filter((r) => r.totalDebt != null && r.equity != null && r.equity > 0)
        .length,
      withMargin: rows.filter(
        (r) => r.revenueTTM != null && r.costTTM != null && r.revenueTTM > 0
      ).length,
      withBookValue: rows.filter(
        (r) => r.equity != null && r.sharesOutstanding != null && r.sharesOutstanding > 0
      ).length,
    },
  };

  return { rows, diagnostics };
}

function buildRows(factsJson: FactsJson): RowAtFiled[] {
  return parseWithDiagnostics(factsJson).rows;
}

// TTM for any flow-item series (net income, revenue, cost, EPS).
//
// Two kinds of anchor points:
//   (1) 10-K filings (~365-day duration) — the FY value IS the trailing
//       12 months as of that period end. Use it directly.
//   (2) 10-Q filings (~90-day duration) — sum the 4 most recent unique
//       3-month slices with end ≤ this quarter's end. Because 10-Ks
//       normally include a 3-month Q4 context alongside the FY context,
//       this works even at year-end.
//
// The `fp` field is unreliable for distinguishing 3-month from YTD
// values (some filers tag YTD as Q2/Q3); duration-on-start/end is the
// authoritative signal.
function rollingTTM(facts: Fact[]): Map<string, number> {
  const quarters = dedupeByEnd(facts.filter(isQuarterDuration));
  const annuals = facts.filter(isAnnualDuration);

  const result = new Map<string, number>();

  // Anchor: FY value at 10-K filing date = TTM directly.
  for (const a of annuals) {
    if (!result.has(a.filed)) result.set(a.filed, a.val);
  }

  // Quarterly anchor: sum of last 4 unique 3-month slices ≤ this end.
  for (const q of quarters) {
    const window = quarters.filter((x) => x.end <= q.end).slice(-4);
    if (window.length === 4 && !result.has(q.filed)) {
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
  // Skip only if we have a healthy stockpile of computed ratios. Earlier
  // parser versions silently produced rows with null ROE because of a
  // filed-date alignment bug between NetIncomeLoss and StockholdersEquity
  // — those rows pass a plain row-count check but are useless to the
  // filter. Threshold of 30 healthy rows ≈ 7.5 years of quarterlies,
  // enough for any backtest window we run. Symbols below that get
  // wiped and re-parsed with the current code.
  const existing = await prisma.stockFundamentalsSnapshot.count({ where: { symbol } });
  if (existing >= 20) {
    const healthy = await prisma.stockFundamentalsSnapshot.count({
      where: { symbol, returnOnEquity: { not: null } },
    });
    if (healthy >= 30) {
      return { symbol, rowsWritten: 0, skippedReason: 'already backfilled' };
    }
    await prisma.stockFundamentalsSnapshot.deleteMany({ where: { symbol } });
    log.info('historical_fundamentals.refreshing_stale', {
      symbol,
      existing,
      healthy,
      reason: `healthy ${healthy} < 30 threshold`,
    });
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
  const { rows, diagnostics } = parseWithDiagnostics(json);

  // Rich diagnostic so we can see WHERE a symbol drops data. Split
  // into sub-logs so Railway's log viewer doesn't truncate.
  log.info('historical_fundamentals.parsed_tags', {
    symbol,
    netIncome: diagnostics.tags.netIncome,
    equity: diagnostics.tags.equity,
    revenue: diagnostics.tags.revenue,
    costOfRevenue: diagnostics.tags.costOfRevenue,
    eps: diagnostics.tags.eps,
  });
  log.info('historical_fundamentals.parsed_durations', {
    symbol,
    netIncome: diagnostics.durationBreakdown.netIncome,
    revenue: diagnostics.durationBreakdown.revenue,
    eps: diagnostics.durationBreakdown.eps,
  });
  log.info('historical_fundamentals.parsed_rows', {
    symbol,
    ttm: diagnostics.ttmComputed,
    ...diagnostics.rows,
  });

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
