// Unit tests for the pure parts of the deep-research agent — the
// prompt builder and the JSON parser. The agent's network call
// (Anthropic + EDGAR + Alpaca) is not exercised here; that's tested
// the day budget allows by clicking the button on a real holding.

import { describe, it, expect } from 'vitest';
import {
  buildResearchPrompt,
  parseDeepResearchOutput,
} from './deep-research';
import type { FundamentalsSnapshot } from '@/lib/data/sec-edgar';

const FULL_FUNDAMENTALS: FundamentalsSnapshot = {
  symbol: 'AAPL',
  cik: '0000320193',
  asOf: '2024-09-30',
  source: 'edgar',
  epsTTM: 6.42,
  bookValuePerShare: 4.40,
  dividendPerShare: 0.97,
  sharesOutstanding: 15_400_000_000,
  totalDebt: 106_000_000_000,
  totalEquity: 67_000_000_000,
  netIncome: 99_000_000_000,
  revenues: 391_000_000_000,
  costOfRevenue: 215_000_000_000,
  returnOnEquityPct: 147.4,
  grossMarginPct: 45.0,
  debtToEquity: 1.58,
  epsGrowthPct5y: 12.3,
  missingFields: [],
};

describe('buildResearchPrompt', () => {
  it('formats fundamentals + price into a structured prompt', () => {
    const prompt = buildResearchPrompt({
      symbol: 'AAPL',
      currentPriceUsd: 230,
      fundamentals: FULL_FUNDAMENTALS,
      asOfISO: '2024-12-15',
    });
    expect(prompt).toMatch(/Symbol: AAPL/);
    expect(prompt).toMatch(/As of: 2024-12-15/);
    expect(prompt).toMatch(/Current price: \$230\.00/);
    expect(prompt).toMatch(/EPS \(TTM\): \$6\.42/);
    expect(prompt).toMatch(/Return on equity: 147\.4%/);
    expect(prompt).toMatch(/Revenue \(TTM\): \$391\.00B/);
    expect(prompt).toMatch(/Implied P\/E \(price\/EPS\): 35\.8/);
    expect(prompt).toMatch(/Implied dividend yield: 0\.42%/);
    // Output schema instruction must be in the prompt — without it the
    // model has no schema target and the parser will fail.
    expect(prompt).toMatch(/"convictionScore"/);
    expect(prompt).toMatch(/"killCriteria"/);
  });

  it('handles missing fundamentals gracefully', () => {
    const prompt = buildResearchPrompt({
      symbol: 'XYZ',
      currentPriceUsd: 50,
      fundamentals: null,
      asOfISO: '2024-12-15',
    });
    expect(prompt).toMatch(/Symbol: XYZ/);
    expect(prompt).toMatch(/Current price: \$50\.00/);
    expect(prompt).toMatch(/Latest reported fundamentals: \(not available/);
    // Schema must still be present so the model knows what to return
    // even when inputs are sparse.
    expect(prompt).toMatch(/"convictionScore"/);
  });

  it('handles missing price (closed market, delisted, etc.)', () => {
    const prompt = buildResearchPrompt({
      symbol: 'XYZ',
      currentPriceUsd: null,
      fundamentals: FULL_FUNDAMENTALS,
      asOfISO: '2024-12-15',
    });
    expect(prompt).toMatch(/Current price: \(not available\)/);
    // Implied P/E and dividend yield require price — skip when null.
    expect(prompt).not.toMatch(/Implied P\/E/);
    expect(prompt).not.toMatch(/Implied dividend yield/);
  });

  it('lists XBRL extraction gaps when present', () => {
    const sparse: FundamentalsSnapshot = {
      ...FULL_FUNDAMENTALS,
      epsTTM: null,
      revenues: null,
      missingFields: ['epsTTM', 'revenues', 'totalDebt'],
    };
    const prompt = buildResearchPrompt({
      symbol: 'X',
      currentPriceUsd: 100,
      fundamentals: sparse,
      asOfISO: '2024-12-15',
    });
    expect(prompt).toMatch(/XBRL extraction missed: epsTTM, revenues, totalDebt/);
  });

  it('excludes implied P/E when EPS is zero or negative (avoids divide-by-zero noise)', () => {
    const moneyLosing: FundamentalsSnapshot = { ...FULL_FUNDAMENTALS, epsTTM: -1.5 };
    const prompt = buildResearchPrompt({
      symbol: 'X',
      currentPriceUsd: 100,
      fundamentals: moneyLosing,
      asOfISO: '2024-12-15',
    });
    expect(prompt).toMatch(/EPS \(TTM\): \$-1\.50/);
    expect(prompt).not.toMatch(/Implied P\/E/);
  });
});

describe('parseDeepResearchOutput', () => {
  const valid = {
    thesis: 'Quality compounder with stretched valuation',
    convictionScore: 62,
    bullCase: 'Services flywheel...',
    bearCase: 'iPhone unit growth has stalled...',
    summary: 'Apple sits at the intersection of...',
    killCriteria: ['Services revenue growth < 5% for 2 quarters', 'Gross margin contracts > 200bps'],
    primaryRisks: ['Regulatory: DOJ antitrust', 'China demand softening'],
  };

  it('parses a clean JSON object', () => {
    expect(parseDeepResearchOutput(JSON.stringify(valid))).toEqual(valid);
  });

  it('strips ```json fences if the model wraps despite instructions', () => {
    const fenced = '```json\n' + JSON.stringify(valid) + '\n```';
    expect(parseDeepResearchOutput(fenced)).toEqual(valid);
  });

  it('extracts the first JSON object even with leading prose', () => {
    const messy = "Sure, here's the analysis:\n" + JSON.stringify(valid) + '\n\nLet me know.';
    expect(parseDeepResearchOutput(messy)).toEqual(valid);
  });

  it('returns null when required fields are missing', () => {
    const partial = { thesis: 'x', convictionScore: 50 };
    expect(parseDeepResearchOutput(JSON.stringify(partial))).toBeNull();
  });

  it('returns null when types are wrong (e.g., string conviction)', () => {
    const wrong = { ...valid, convictionScore: '62' as unknown as number };
    expect(parseDeepResearchOutput(JSON.stringify(wrong))).toBeNull();
  });

  it('returns null on empty / unparseable text', () => {
    expect(parseDeepResearchOutput('')).toBeNull();
    expect(parseDeepResearchOutput('I cannot help with that.')).toBeNull();
  });

  it('handles braces in string fields (e.g., the model writes JSON-like text in the thesis)', () => {
    const tricky = { ...valid, thesis: 'price target { $250-280 } range' };
    const parsed = parseDeepResearchOutput(JSON.stringify(tricky));
    expect(parsed?.thesis).toBe('price target { $250-280 } range');
  });
});
