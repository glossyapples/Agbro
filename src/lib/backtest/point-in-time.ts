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

function cacheKey(symbol: string, asOfYmd: string, price: number): string {
  // Round price to cents so micro differences don't blow up cache entries.
  return `${symbol}|${asOfYmd}|${Math.round(price * 100)}`;
}

// Look up the most recent fundamentals snapshot for a symbol whose
// asOfDate <= the decision date. Enriches with the caller-supplied
// price to derive a point-in-time P/E.
export async function lookupFundamentalsAt(
  symbol: string,
  decisionDate: Date,
  priceAtDate: number
): Promise<PointInTimeFundamentals | null> {
  const ymd = decisionDate.toISOString().slice(0, 10);
  const key = cacheKey(symbol, ymd, priceAtDate);
  const cached = memoryCache.get(key);
  if (cached !== undefined) return cached;

  const snap = await prisma.stockFundamentalsSnapshot.findFirst({
    where: {
      symbol,
      asOfDate: { lte: decisionDate },
    },
    orderBy: { asOfDate: 'desc' },
  });
  if (!snap) {
    memoryCache.set(key, null);
    return null;
  }
  const result: PointInTimeFundamentals = {
    symbol,
    asOfDate: snap.asOfDate,
    priceAtDate,
    epsTTM: snap.epsTTM,
    peRatio:
      snap.epsTTM != null && snap.epsTTM > 0 ? priceAtDate / snap.epsTTM : null,
    returnOnEquity: snap.returnOnEquity,
    debtToEquity: snap.debtToEquity,
    grossMarginPct: snap.grossMarginPct,
    dividendYield: snap.dividendYield,
    bookValuePerShare: snap.bookValuePerShare,
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
  spec: FilterSpec
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
    const f = await lookupFundamentalsAt(symbol, decisionDate, priceAtDate);
    return { symbol, pass: true, fundamentals: f };
  }

  const f = await lookupFundamentalsAt(symbol, decisionDate, priceAtDate);
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
export function resetPointInTimeCache(): void {
  memoryCache.clear();
}
