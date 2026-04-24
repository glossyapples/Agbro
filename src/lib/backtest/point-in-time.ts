// Point-in-time fundamentals lookup + strategy-filter evaluation for the
// backtester. Enforces the anti-look-ahead rule: a decision made on
// 2008-07-15 can only see fundamentals whose filing date was on or
// before 2008-07-15.
//
// Small cache keyed by (symbol, asOfDate-bucket) so the simulator
// doesn't re-query Prisma for the same symbol multiple times per
// rebalance cycle. Bucket is per-day because snapshots advance
// per-quarter at most.

import { prisma } from '@/lib/db';

export type PointInTimeFundamentals = {
  symbol: string;
  asOfDate: Date;
  // Price is required to compute P/E; callers pass the price that was
  // trading on the decision date.
  priceAtDate: number;
  epsTTM: number | null;
  peRatio: number | null;
  returnOnEquity: number | null;
  debtToEquity: number | null;
  grossMarginPct: number | null;
  dividendYield: number | null;
  bookValuePerShare: number | null;
};

const memoryCache = new Map<string, PointInTimeFundamentals | null>();

// Scope prefix keeps parallel grid cells from racing each other on a
// single module-level Map — each cell's reset used to wipe every
// other in-flight cell's entries. Pass a stable `scope` string (e.g.
// a runId) through every lookup / reset and the cache becomes
// per-run-safe without any thread-pool heroics. Missing scope falls
// back to 'default' so non-grid callers keep their old behaviour.
function cacheKey(
  scope: string,
  symbol: string,
  asOfYmd: string,
  price: number
): string {
  // Round price to cents so micro differences don't blow up cache entries.
  return `${scope}|${symbol}|${asOfYmd}|${Math.round(price * 100)}`;
}

// Look up the latest known fundamentals for a symbol as of `decisionDate`.
//
// Why "latest known per metric" instead of just the latest snapshot:
// EDGAR filings often produce snapshots where some metrics are null
// because the underlying TTM rolling sum couldn't gather four quarters
// at that filing or because a balance-sheet item wasn't republished.
// The original "first row wins" lookup landed on null-metric rows
// at random based on filing alignment, causing the filter to reject
// symbols whose data was actually fine just one quarter back.
//
// Now we fetch the most recent ~15 years of snapshots ≤ decisionDate
// and compose the result from the latest non-null value of each
// metric. The semantic this implements is what an analyst does
// manually — "the latest known ROE as of date X" — independent of
// whether the very most recent snapshot happened to compute it.
export async function lookupFundamentalsAt(
  symbol: string,
  decisionDate: Date,
  priceAtDate: number,
  scope: string = 'default'
): Promise<PointInTimeFundamentals | null> {
  const ymd = decisionDate.toISOString().slice(0, 10);
  const key = cacheKey(scope, symbol, ymd, priceAtDate);
  const cached = memoryCache.get(key);
  if (cached !== undefined) return cached;

  const snaps = await prisma.stockFundamentalsSnapshot.findMany({
    where: {
      symbol,
      asOfDate: { lte: decisionDate },
    },
    orderBy: { asOfDate: 'desc' },
    take: 60, // ~15 years of quarterlies — enough for any null-gap recovery
  });
  if (snaps.length === 0) {
    memoryCache.set(key, null);
    return null;
  }

  const firstNonNull = (
    extract: (s: (typeof snaps)[number]) => number | null
  ): number | null => {
    for (const s of snaps) {
      const v = extract(s);
      if (v != null) return v;
    }
    return null;
  };

  const epsTTM = firstNonNull((s) => s.epsTTM);
  const result: PointInTimeFundamentals = {
    symbol,
    asOfDate: snaps[0].asOfDate,
    priceAtDate,
    epsTTM,
    peRatio: epsTTM != null && epsTTM > 0 ? priceAtDate / epsTTM : null,
    returnOnEquity: firstNonNull((s) => s.returnOnEquity),
    debtToEquity: firstNonNull((s) => s.debtToEquity),
    grossMarginPct: firstNonNull((s) => s.grossMarginPct),
    dividendYield: firstNonNull((s) => s.dividendYield),
    bookValuePerShare: firstNonNull((s) => s.bookValuePerShare),
  };
  memoryCache.set(key, result);
  return result;
}

export type FilterSpec = {
  minROE?: number; // percent, e.g. 15
  maxPE?: number;
  maxDE?: number;
  minGrossMarginPct?: number;
  minDividendYieldPct?: number;
};

export type FilterResult = {
  symbol: string;
  pass: boolean;
  reason?: string; // which filter blocked, if any
  fundamentals: PointInTimeFundamentals | null;
  // True when the symbol passed only because we had no fundamentals at
  // all to evaluate it against. Caller should surface this distinctly
  // so the audit shows "passed filter" vs. "pipeline couldn't screen".
  passedWithoutData?: boolean;
};

// Apply a strategy's filter spec to a single symbol at a decision date.
//
// Fail-safe behaviour (backtest-specific):
//   - If the filter spec is empty, pass automatically.
//   - If we have NO fundamentals snapshot at all, pass with
//     passedWithoutData=true. The symbol enters the book as it would
//     under Tier 1; the audit trail flags that we couldn't actually
//     screen it. This is deliberately permissive for backtests: a
//     partial EDGAR feed shouldn't flatline an entire run. Strict
//     rejection is the right call for live trading, not historical sim.
//   - If we have fundamentals BUT a specific required metric is null,
//     reject (strict on known-bad data).
export async function evaluateFilter(
  symbol: string,
  decisionDate: Date,
  priceAtDate: number,
  spec: FilterSpec,
  scope: string = 'default'
): Promise<FilterResult> {
  const hasAnyFilter =
    spec.minROE != null ||
    spec.maxPE != null ||
    spec.maxDE != null ||
    spec.minGrossMarginPct != null ||
    spec.minDividendYieldPct != null;

  if (!hasAnyFilter) {
    // Lookup is still useful for the caller (logging), but pass is
    // automatic.
    const f = await lookupFundamentalsAt(symbol, decisionDate, priceAtDate, scope);
    return { symbol, pass: true, fundamentals: f };
  }

  const f = await lookupFundamentalsAt(symbol, decisionDate, priceAtDate, scope);
  if (!f) {
    return {
      symbol,
      pass: true,
      passedWithoutData: true,
      reason: 'no fundamentals available — passed through as Tier 1',
      fundamentals: null,
    };
  }

  if (spec.minROE != null) {
    if (f.returnOnEquity == null || f.returnOnEquity < spec.minROE) {
      return {
        symbol,
        pass: false,
        reason: `ROE ${f.returnOnEquity?.toFixed(1) ?? 'n/a'}% < ${spec.minROE}%`,
        fundamentals: f,
      };
    }
  }
  if (spec.maxPE != null) {
    if (f.peRatio == null || f.peRatio > spec.maxPE) {
      return {
        symbol,
        pass: false,
        reason: `P/E ${f.peRatio?.toFixed(1) ?? 'n/a'} > ${spec.maxPE}`,
        fundamentals: f,
      };
    }
  }
  if (spec.maxDE != null) {
    if (f.debtToEquity == null || f.debtToEquity > spec.maxDE) {
      return {
        symbol,
        pass: false,
        reason: `D/E ${f.debtToEquity?.toFixed(2) ?? 'n/a'} > ${spec.maxDE}`,
        fundamentals: f,
      };
    }
  }
  if (spec.minGrossMarginPct != null) {
    if (f.grossMarginPct == null || f.grossMarginPct < spec.minGrossMarginPct) {
      return {
        symbol,
        pass: false,
        reason: `gross margin ${f.grossMarginPct?.toFixed(1) ?? 'n/a'}% < ${spec.minGrossMarginPct}%`,
        fundamentals: f,
      };
    }
  }
  if (spec.minDividendYieldPct != null) {
    if (f.dividendYield == null || f.dividendYield < spec.minDividendYieldPct) {
      return {
        symbol,
        pass: false,
        reason: `div yield ${f.dividendYield?.toFixed(2) ?? 'n/a'}% < ${spec.minDividendYieldPct}%`,
        fundamentals: f,
      };
    }
  }

  return { symbol, pass: true, fundamentals: f };
}

// Reset the in-process cache. Called between distinct backtest runs so
// a prior run's price-derived P/E doesn't leak into a different run.
// Reset only the scope's entries so parallel grid cells don't wipe
// each other's caches. Omit scope (or pass undefined) to clear
// everything — still useful for test teardown.
export function resetPointInTimeCache(scope?: string): void {
  if (!scope) {
    memoryCache.clear();
    return;
  }
  const prefix = `${scope}|`;
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) memoryCache.delete(key);
  }
  return;
}
