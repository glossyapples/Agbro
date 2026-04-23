// GET /api/backtest/debug-fundamentals?symbol=JNJ
//
// Read-only diagnostic endpoint. Dumps the end-to-end state of the
// point-in-time fundamentals pipeline for a single symbol so we can
// pinpoint exactly where data drops when Tier 2 rejects a name.
//
// Returns, in order:
//   1. CIK lookup result (can we find it in SEC's ticker file?)
//   2. EDGAR companyfacts fetch status
//   3. Parser diagnostics — which tags matched, duration breakdown of
//      each flow series, how many TTM entries got computed, how many
//      rows carry ROE/D/E/margin.
//   4. What's actually in the DB for this symbol (row count, healthy
//      count, last 5 rows verbatim).
//   5. A small sample of the raw EDGAR facts so we can inspect shape
//      when something unexpected is going on.
//
// Does NOT write anything. Safe to hit repeatedly.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseWithDiagnostics } from '@/lib/backtest/historical-fundamentals';

export const runtime = 'nodejs';
export const maxDuration = 60;

// TEMPORARY: auth disabled so the operator can hit this endpoint
// directly during a diagnostic session. Read-only, no user data
// surfaced (SEC EDGAR is fully public; DB summary is just counts +
// last 5 rows for a named symbol). RE-ADD requireUser before merging.

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const FACTS_URL = (cik10: string) =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;

const USER_AGENT =
  process.env.AGBRO_SEC_USER_AGENT ??
  'AgBro/1.0 (agbro-trading@example.com) value-investing agent';

async function secFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
}

type RawFactPreview = {
  start?: string;
  end: string;
  val: number;
  fp?: string;
  form?: string;
  filed: string;
};

function pickSample(arr: RawFactPreview[] | undefined): RawFactPreview[] {
  if (!arr || arr.length === 0) return [];
  const first = arr.slice(0, 3);
  const last = arr.slice(-3);
  return [...first, ...last];
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawSymbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
  if (!rawSymbol || rawSymbol.length > 12) {
    return NextResponse.json(
      { error: 'symbol query param required (1-12 chars)' },
      { status: 400 }
    );
  }

  const diag: Record<string, unknown> = { symbol: rawSymbol };

  // 1) CIK lookup
  const tickersRes = await secFetch(TICKERS_URL);
  diag.tickersFetch = { ok: tickersRes.ok, status: tickersRes.status };
  let cik: string | null = null;
  if (tickersRes.ok) {
    const tickers = (await tickersRes.json()) as Record<
      string,
      { ticker: string; cik_str: number }
    >;
    for (const row of Object.values(tickers)) {
      if (row.ticker.toUpperCase() === rawSymbol) {
        cik = String(row.cik_str).padStart(10, '0');
        break;
      }
    }
  }
  diag.cik = cik;
  if (!cik) {
    diag.conclusion = 'SYMBOL_NOT_IN_TICKER_FILE — likely an ETF or non-US-filer';
    diag.databaseSnapshots = await summarizeDB(rawSymbol);
    return NextResponse.json(diag);
  }

  // 2) EDGAR companyfacts
  const factsRes = await secFetch(FACTS_URL(cik));
  diag.factsFetch = { ok: factsRes.ok, status: factsRes.status, url: FACTS_URL(cik) };
  if (!factsRes.ok) {
    diag.conclusion = `EDGAR_${factsRes.status}`;
    diag.databaseSnapshots = await summarizeDB(rawSymbol);
    return NextResponse.json(diag);
  }
  const factsBody = await factsRes.text();
  diag.factsBodyBytes = factsBody.length;
  let factsJson: {
    facts?: { 'us-gaap'?: Record<string, { units?: Record<string, RawFactPreview[]> }> };
  };
  try {
    factsJson = JSON.parse(factsBody);
  } catch (err) {
    diag.conclusion = 'EDGAR_JSON_PARSE_FAILED';
    diag.parseError = (err as Error).message;
    return NextResponse.json(diag);
  }

  const usGaap = factsJson.facts?.['us-gaap'] ?? {};
  diag.usGaapTagCount = Object.keys(usGaap).length;

  // 3) Parser diagnostics
  const { rows, diagnostics } = parseWithDiagnostics(factsJson);
  diag.parse = diagnostics;
  diag.parsedRowCount = rows.length;
  diag.parsedRowsSample = {
    first: rows.slice(0, 3).map((r) => ({
      asOfDate: r.asOfDate.toISOString().slice(0, 10),
      netIncomeTTM: r.netIncomeTTM,
      equity: r.equity,
      totalDebt: r.totalDebt,
      roeComputed:
        r.netIncomeTTM != null && r.equity != null && r.equity > 0
          ? (r.netIncomeTTM / r.equity) * 100
          : null,
    })),
    last: rows.slice(-3).map((r) => ({
      asOfDate: r.asOfDate.toISOString().slice(0, 10),
      netIncomeTTM: r.netIncomeTTM,
      equity: r.equity,
      totalDebt: r.totalDebt,
      roeComputed:
        r.netIncomeTTM != null && r.equity != null && r.equity > 0
          ? (r.netIncomeTTM / r.equity) * 100
          : null,
    })),
  };

  // 4) Raw EDGAR fact samples for the tags we care about. Shows exactly
  // what shape SEC is handing us — whether `start` is present, what
  // duration the "Q3" entries actually span, etc.
  diag.rawFactsSample = {
    NetIncomeLoss: pickSample(usGaap['NetIncomeLoss']?.units?.['USD']),
    StockholdersEquity: pickSample(usGaap['StockholdersEquity']?.units?.['USD']),
    Revenues: pickSample(usGaap['Revenues']?.units?.['USD']),
  };

  // 5) Database state
  diag.databaseSnapshots = await summarizeDB(rawSymbol);

  // 6) Interpretation hint
  if (diagnostics.rows.withROE === 0 && diagnostics.tags.netIncome.factCount > 0) {
    if (diagnostics.durationBreakdown.netIncome.threeMonth === 0) {
      diag.conclusion =
        "PARSER_BUG — NetIncomeLoss has facts but no 3-month slices. Filer likely reports only YTD values. Need to derive quarterly from YTD deltas.";
    } else if (diagnostics.ttmComputed.netIncome === 0) {
      diag.conclusion =
        "PARSER_BUG — 3-month slices exist but TTM window never hit 4. Check dedupe/ordering.";
    } else if (diagnostics.tags.equity.factCount === 0) {
      diag.conclusion = "DATA_GAP — no StockholdersEquity tag in the feed.";
    } else {
      diag.conclusion =
        'ROW_ALIGNMENT_BUG — TTM computed at some filings, equity at others, union produces zero overlap.';
    }
  } else if (diagnostics.rows.withROE > 0) {
    diag.conclusion = `OK — ${diagnostics.rows.withROE}/${diagnostics.rows.total} rows carry ROE.`;
  } else {
    diag.conclusion = `NO_TAG_DATA — NetIncomeLoss not found under us-gaap/USD for this filer.`;
  }

  return NextResponse.json(diag);
}

async function summarizeDB(symbol: string) {
  const total = await prisma.stockFundamentalsSnapshot.count({ where: { symbol } });
  const withROE = await prisma.stockFundamentalsSnapshot.count({
    where: { symbol, returnOnEquity: { not: null } },
  });
  const withDE = await prisma.stockFundamentalsSnapshot.count({
    where: { symbol, debtToEquity: { not: null } },
  });
  const mostRecent = await prisma.stockFundamentalsSnapshot.findMany({
    where: { symbol },
    orderBy: { asOfDate: 'desc' },
    take: 5,
  });
  return {
    total,
    withROE,
    withDE,
    mostRecent: mostRecent.map((r) => ({
      asOfDate: r.asOfDate.toISOString().slice(0, 10),
      returnOnEquity: r.returnOnEquity,
      debtToEquity: r.debtToEquity,
      grossMarginPct: r.grossMarginPct,
      epsTTM: r.epsTTM,
    })),
  };
}
