// AgBro Financial Analyzer
// Internal calculators used by the agent BEFORE any trade decision.
// Every input here is numeric and deterministic so the LLM can't hallucinate maths.

export type AnalyzerInput = {
  symbol: string;
  price: number;               // current share price, dollars
  eps: number;                 // trailing 12m earnings per share
  epsGrowthPct: number;        // projected annual EPS growth (5y), e.g. 8 for 8%
  bookValuePerShare: number;
  dividendPerShare: number;
  fcfPerShare: number;         // free cash flow per share
  sharesOutstanding: number;
  totalDebt: number;           // dollars
  totalEquity: number;
  returnOnEquityPct: number;
  grossMarginPct: number;
  sector?: string;
  aaaBondYieldPct?: number;    // for Graham; default 4.5
  discountRatePct?: number;    // for DCF; default 10
  terminalGrowthPct?: number;  // for DCF; default 2.5
};

export type AnalyzerReport = {
  symbol: string;
  price: number;
  valuations: {
    grahamNumber: number | null;       // sqrt(22.5 * eps * bv)
    grahamFormulaValue: number | null; // EPS * (8.5 + 2g) * 4.4/Y
    dcfIntrinsic: number | null;
    dividendDiscountValue: number | null;
    peFairValue: number | null;        // EPS * sector-fair P/E
  };
  marginOfSafetyPct: number | null;    // (intrinsic - price)/intrinsic * 100
  buffettScore: number;                // 0..100 heuristic
  moatSignal: 'none' | 'narrow' | 'wide';
  verdict: 'strong_buy' | 'buy' | 'hold' | 'avoid';
  rationale: string[];
  warnings: string[];
};

const avg = (nums: Array<number | null | undefined>): number | null => {
  const xs = nums.filter((n): n is number => typeof n === 'number' && !Number.isNaN(n));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
};

export function grahamNumber(eps: number, bvps: number): number | null {
  if (eps <= 0 || bvps <= 0) return null;
  return Math.sqrt(22.5 * eps * bvps);
}

// Classic Graham formula with Y = AAA corporate bond yield.
export function grahamFormulaValue(
  eps: number,
  growthPct: number,
  aaaBondYieldPct = 4.5
): number | null {
  if (eps <= 0) return null;
  const y = Math.max(aaaBondYieldPct, 1); // protect against div by 0
  return (eps * (8.5 + 2 * growthPct) * 4.4) / y;
}

// 10-year two-stage DCF on FCF per share.
export function dcfIntrinsic(
  fcfPerShare: number,
  growthPct: number,
  discountRatePct = 10,
  terminalGrowthPct = 2.5,
  years = 10
): number | null {
  if (fcfPerShare <= 0) return null;
  const r = discountRatePct / 100;
  const g = growthPct / 100;
  const tg = terminalGrowthPct / 100;
  if (r <= tg) return null; // invalid terminal
  let pv = 0;
  let fcf = fcfPerShare;
  for (let t = 1; t <= years; t++) {
    fcf *= 1 + g;
    pv += fcf / Math.pow(1 + r, t);
  }
  const terminal = (fcf * (1 + tg)) / (r - tg);
  pv += terminal / Math.pow(1 + r, years);
  return pv;
}

// Gordon growth DDM. Only meaningful for dividend payers with r > g.
export function dividendDiscountValue(
  dps: number,
  growthPct: number,
  discountRatePct = 10
): number | null {
  if (dps <= 0) return null;
  const r = discountRatePct / 100;
  const g = growthPct / 100;
  if (r <= g) return null;
  return (dps * (1 + g)) / (r - g);
}

// Sector-based fair P/E — rough, refined by agents over time.
const SECTOR_FAIR_PE: Record<string, number> = {
  'Technology': 22,
  'Consumer Defensive': 20,
  'Consumer Cyclical': 16,
  'Healthcare': 18,
  'Financial Services': 12,
  'Energy': 11,
  'Industrials': 17,
  'Basic Materials': 13,
  'Utilities': 17,
  'Real Estate': 18,
  'Communication Services': 17,
};

export function peFairValue(eps: number, sector?: string): number | null {
  if (eps <= 0) return null;
  const fair = sector ? (SECTOR_FAIR_PE[sector] ?? 15) : 15;
  return eps * fair;
}

// Moat heuristic from fundamentals. Replace/refine as the brain learns.
export function moatSignal(input: AnalyzerInput): 'none' | 'narrow' | 'wide' {
  let score = 0;
  if (input.returnOnEquityPct >= 15) score += 1;
  if (input.returnOnEquityPct >= 25) score += 1;
  if (input.grossMarginPct >= 40) score += 1;
  if (input.grossMarginPct >= 60) score += 1;
  const de = input.totalEquity > 0 ? input.totalDebt / input.totalEquity : Infinity;
  if (de < 1) score += 1;
  if (score >= 4) return 'wide';
  if (score >= 2) return 'narrow';
  return 'none';
}

// 0..100 "how Buffett-like is this?" combining value + quality + moat.
export function buffettScore(input: AnalyzerInput, report: Pick<AnalyzerReport, 'marginOfSafetyPct' | 'moatSignal'>): number {
  let score = 0;
  // Margin of safety
  if (report.marginOfSafetyPct != null) {
    if (report.marginOfSafetyPct >= 40) score += 30;
    else if (report.marginOfSafetyPct >= 25) score += 22;
    else if (report.marginOfSafetyPct >= 10) score += 12;
    else if (report.marginOfSafetyPct >= 0) score += 4;
  }
  // Moat
  if (report.moatSignal === 'wide') score += 25;
  else if (report.moatSignal === 'narrow') score += 12;
  // ROE
  if (input.returnOnEquityPct >= 20) score += 15;
  else if (input.returnOnEquityPct >= 12) score += 8;
  // Dividend
  if (input.dividendPerShare > 0) score += 10;
  // Leverage
  const de = input.totalEquity > 0 ? input.totalDebt / input.totalEquity : Infinity;
  if (de < 0.5) score += 10;
  else if (de < 1) score += 5;
  // Growth sanity
  if (input.epsGrowthPct >= 5 && input.epsGrowthPct <= 20) score += 10;
  return Math.max(0, Math.min(100, score));
}

export function analyze(input: AnalyzerInput): AnalyzerReport {
  const warnings: string[] = [];
  if (input.eps <= 0) warnings.push('Negative/zero EPS — most valuation formulas are unreliable.');
  if (input.totalEquity <= 0) warnings.push('Non-positive equity — treat as red flag.');

  const graham = grahamNumber(input.eps, input.bookValuePerShare);
  const grahamFV = grahamFormulaValue(input.eps, input.epsGrowthPct, input.aaaBondYieldPct);
  const dcf = dcfIntrinsic(input.fcfPerShare, input.epsGrowthPct, input.discountRatePct, input.terminalGrowthPct);
  const ddm = dividendDiscountValue(input.dividendPerShare, Math.min(input.epsGrowthPct, 6), input.discountRatePct);
  const peFV = peFairValue(input.eps, input.sector);

  const intrinsic = avg([graham, grahamFV, dcf, ddm, peFV]);
  const mos = intrinsic && intrinsic > 0 ? ((intrinsic - input.price) / intrinsic) * 100 : null;

  const moat = moatSignal(input);
  const score = buffettScore(input, { marginOfSafetyPct: mos, moatSignal: moat });

  let verdict: AnalyzerReport['verdict'] = 'avoid';
  if (score >= 70 && (mos ?? -1) >= 20) verdict = 'strong_buy';
  else if (score >= 55 && (mos ?? -1) >= 10) verdict = 'buy';
  else if (score >= 40) verdict = 'hold';

  const rationale: string[] = [];
  if (mos != null) rationale.push(`Margin of safety vs blended intrinsic: ${mos.toFixed(1)}%`);
  rationale.push(`Moat signal: ${moat}`);
  rationale.push(`ROE ${input.returnOnEquityPct.toFixed(1)}%, gross margin ${input.grossMarginPct.toFixed(1)}%`);
  if (input.dividendPerShare > 0)
    rationale.push(`Dividend yield ${((input.dividendPerShare / input.price) * 100).toFixed(2)}%`);

  return {
    symbol: input.symbol,
    price: input.price,
    valuations: {
      grahamNumber: graham,
      grahamFormulaValue: grahamFV,
      dcfIntrinsic: dcf,
      dividendDiscountValue: ddm,
      peFairValue: peFV,
    },
    marginOfSafetyPct: mos,
    buffettScore: score,
    moatSignal: moat,
    verdict,
    rationale,
    warnings,
  };
}

// Position sizing — Kelly-lite, capped by account policy.
//
// All money math is done in BigInt cents so we don't lose precision on large
// portfolios (Number(BigInt) starts losing pennies past ~$90T but the larger
// risk is silent rounding drift on smaller portfolios). Percent inputs and
// the score*confidence scale are floats — they're bounded 0..100 / 0..1 so
// fixed-point rasterisation (×10_000) is plenty.
export function positionSizeCents(args: {
  portfolioValueCents: bigint;
  cashCents: bigint;
  buffettScore: number;      // 0..100
  confidence: number;        // 0..1
  maxPositionPct: number;    // e.g. 15
  minCashReservePct: number; // e.g. 10
}): bigint {
  const { portfolioValueCents, cashCents, buffettScore, confidence, maxPositionPct, minCashReservePct } = args;
  if (buffettScore < 40 || confidence < 0.5) return 0n;
  if (portfolioValueCents <= 0n || cashCents <= 0n) return 0n;

  // Rasterise the percent inputs to basis-point integers (×100). Clamp to [0, 100%].
  const reserveBps = bpsFromPct(minCashReservePct);
  const capBps = bpsFromPct(maxPositionPct);

  // reserveCents = portfolioValueCents * reserveBps / 10_000
  const reserveCents = (portfolioValueCents * reserveBps) / 10_000n;
  const deployableCents = cashCents > reserveCents ? cashCents - reserveCents : 0n;
  if (deployableCents === 0n) return 0n;

  // capCents = portfolioValueCents * capBps / 10_000
  const capCents = (portfolioValueCents * capBps) / 10_000n;
  if (capCents === 0n) return 0n;

  // Scale ∈ [0, 1]. Rasterise to a millionths integer so we keep BigInt math.
  const scaleNum = (buffettScore / 100) * confidence;
  const SCALE_DEN = 1_000_000n;
  const scaleScaled = BigInt(Math.max(0, Math.min(1_000_000, Math.round(scaleNum * 1_000_000))));
  const scaledDeployable = (deployableCents * scaleScaled) / SCALE_DEN;

  return scaledDeployable < capCents ? scaledDeployable : capCents;
}

function bpsFromPct(pct: number): bigint {
  if (!Number.isFinite(pct) || pct <= 0) return 0n;
  if (pct >= 100) return 10_000n;
  return BigInt(Math.round(pct * 100));
}
