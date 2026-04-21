// Universe screener. "Don't miss fresh opportunities" — occasionally looks
// outside the user's curated watchlist for new names matching Buffett-style
// criteria, enriches each with SEC EDGAR fundamentals, and stores them as
// Tier 2 candidates pending user approval.
//
// Cadence discipline (matches how disciplined value shops actually work —
// constant reading, rare action):
//   - Agent-initiated screens are rate-limited to 7 days between runs
//     (enforced here via the most-recent discoveredAt on any screener row).
//   - User-initiated screens (from /candidates UI) bypass the rate limit
//     — if you're paying attention, we're not going to tell you to wait.
//   - Per screen: 1 Perplexity call + up to 5 EDGAR refreshes.
//     Budget impact ≈ $30-60/year incremental — negligible vs. the Opus
//     baseline but enough to pay attention to.
//
// Flow:
//   1. Ask Perplexity for US common stocks matching the criteria, explicitly
//      excluding the current watchlist + rejected list so it doesn't waste
//      slots re-suggesting names.
//   2. Parse the response for ticker symbols (forgiving parser).
//   3. For each candidate symbol (max 5 per screen):
//        a. SEC EDGAR refresh — pulls real fundamentals
//        b. Upsert into Stock with candidateSource='screener' + thesis
//   4. Return summary.

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { perplexitySearch } from '@/lib/research/perplexity';
import { fetchFundamentals } from './sec-edgar';

const SCREEN_COOLDOWN_DAYS = 7;
const MAX_CANDIDATES_PER_SCREEN = 5;

export type ScreenCriteria = {
  // Minimum return on equity (%). Default 15.
  minRoePct?: number;
  // Maximum trailing P/E. Default 22 (lets the agent adjust for current-era
  // multiples — real Buffett-style is 12-18).
  maxPeRatio?: number;
  // Minimum dividend yield (%). Default 0 (don't require dividends).
  minDividendYieldPct?: number;
  // Preferred sectors. Empty = all.
  preferredSectors?: string[];
  // Free-form thesis hint — e.g. "recent earnings miss overreactions" or
  // "dividend aristocrats trading below 10y avg P/E". Steers Perplexity.
  thesisHint?: string;
};

export type ScreenResult = {
  status: 'ok' | 'cooldown_active' | 'no_candidates' | 'error';
  daysSinceLastScreen: number;
  candidates: Array<{
    symbol: string;
    name: string | null;
    thesis: string;
    fundamentalsFetched: boolean;
    missingFields: string[];
  }>;
  cooldownDays: number;
  error?: string;
};

// -------------------- Rate-limit check --------------------

export async function getCooldownState(): Promise<{
  daysSinceLastScreen: number;
  blocked: boolean;
}> {
  const last = await prisma.stock.findFirst({
    where: { candidateSource: 'screener' },
    orderBy: { discoveredAt: 'desc' },
    select: { discoveredAt: true },
  });
  if (!last?.discoveredAt) return { daysSinceLastScreen: 9999, blocked: false };
  const daysSince = (Date.now() - last.discoveredAt.getTime()) / 86_400_000;
  return { daysSinceLastScreen: Math.floor(daysSince), blocked: daysSince < SCREEN_COOLDOWN_DAYS };
}

// -------------------- Ticker extraction --------------------

// Forgiving ticker parser. Perplexity returns markdown with tickers sprinkled
// throughout; we pull anything that looks like a US common-stock ticker.
// Max 6 chars, letters only (optionally with a dot/dash class suffix).
const TICKER_RE = /\b([A-Z]{1,5}(?:[.\-][A-Z])?)\b/g;

// Conservative stop-list of words that match the ticker regex but aren't
// actually tickers. Keep minimal; the SEC CIK lookup in fetchFundamentals
// filters out everything that isn't a real filer.
const NOT_TICKERS = new Set([
  'A', 'I', 'US', 'USA', 'CEO', 'CFO', 'CTO', 'COO', 'USD', 'EPS', 'ROE',
  'ROIC', 'ROA', 'P', 'PE', 'PB', 'EBITDA', 'FCF', 'GAAP', 'IPO', 'ETF',
  'SEC', 'FDA', 'FTC', 'FED', 'FY', 'Q', 'TTM', 'YOY', 'YTD', 'NASDAQ',
  'NYSE', 'AMEX', 'OTC', 'UK', 'EU', 'AI', 'ML', 'AR', 'VR', 'SaaS', 'AWS',
  'MOAT', 'MOS',
]);

function extractCandidateTickers(text: string, exclude: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(TICKER_RE)) {
    const t = m[1].toUpperCase();
    if (NOT_TICKERS.has(t)) continue;
    if (exclude.has(t)) continue;
    if (t.length < 2) continue; // single-letter tickers exist (F, T) but
                                // are rare enough that this filter trades
                                // a small recall cost for much higher
                                // precision on noisy Perplexity responses
    found.add(t);
  }
  return [...found];
}

// -------------------- Screen --------------------

export type ScreenOptions = {
  // Bypass the 7-day cooldown. Used by the user-triggered /candidates
  // manual refresh; NEVER passed from the agent path.
  bypassCooldown?: boolean;
};

export async function runScreen(
  criteria: ScreenCriteria,
  options: ScreenOptions = {}
): Promise<ScreenResult> {
  const cooldown = await getCooldownState();
  if (cooldown.blocked && !options.bypassCooldown) {
    return {
      status: 'cooldown_active',
      daysSinceLastScreen: cooldown.daysSinceLastScreen,
      cooldownDays: SCREEN_COOLDOWN_DAYS,
      candidates: [],
    };
  }

  // Build exclusion list: everything already in the Stock table. This covers
  // the active watchlist, prior screener hits (avoids duplicates), and
  // user-rejected names (so Perplexity doesn't keep re-suggesting them).
  const allStock = await prisma.stock.findMany({ select: { symbol: true } });
  const exclude = new Set(allStock.map((s) => s.symbol.toUpperCase()));

  const c = {
    minRoePct: criteria.minRoePct ?? 15,
    maxPeRatio: criteria.maxPeRatio ?? 22,
    minDividendYieldPct: criteria.minDividendYieldPct ?? 0,
    preferredSectors: criteria.preferredSectors ?? [],
    thesisHint: criteria.thesisHint ?? '',
  };

  const prompt = buildScreenPrompt(c, exclude);
  let perplexity;
  try {
    perplexity = await perplexitySearch(prompt, { system: SCREENER_SYSTEM });
  } catch (err) {
    log.error('screener.perplexity_failed', err);
    return {
      status: 'error',
      daysSinceLastScreen: cooldown.daysSinceLastScreen,
      cooldownDays: SCREEN_COOLDOWN_DAYS,
      candidates: [],
      error: (err as Error).message,
    };
  }

  // Diagnostic trail: the whole point of adding these is so that when a
  // screen returns zero candidates we can tell *why* — did Perplexity return
  // prose with no tickers, did every ticker land in the exclude set, or
  // did the regex miss the format?
  const rawMatches = [...perplexity.summary.matchAll(TICKER_RE)].map((m) =>
    m[1].toUpperCase()
  );
  const uniqueRaw = [...new Set(rawMatches)];
  log.info('screener.perplexity_response', {
    summaryLength: perplexity.summary.length,
    summaryPreview: perplexity.summary.slice(0, 1500),
    citations: perplexity.citations.length,
    rawMatchCount: rawMatches.length,
    uniqueRaw: uniqueRaw.slice(0, 40),
    excludeSize: exclude.size,
  });

  const tickers = extractCandidateTickers(perplexity.summary, exclude).slice(
    0,
    MAX_CANDIDATES_PER_SCREEN
  );
  log.info('screener.candidates_after_filter', {
    keptCount: tickers.length,
    kept: tickers,
    droppedByFilter: uniqueRaw.filter((t) => !tickers.includes(t)).slice(0, 40),
  });

  if (tickers.length === 0) {
    return {
      status: 'no_candidates',
      daysSinceLastScreen: cooldown.daysSinceLastScreen,
      cooldownDays: SCREEN_COOLDOWN_DAYS,
      candidates: [],
    };
  }

  // For each extracted ticker, enrich with EDGAR + persist as a Tier 2
  // candidate. Sequential to stay polite vs. SEC's rate limit.
  const results: ScreenResult['candidates'] = [];
  for (const symbol of tickers) {
    const snap = await fetchFundamentals(symbol).catch(() => null);
    // Per-candidate thesis: grab the sentence(s) mentioning this ticker
    // from the Perplexity response so the user has context at review time.
    const thesis = extractThesisFor(symbol, perplexity.summary);

    await prisma.stock.upsert({
      where: { symbol },
      create: {
        symbol,
        name: symbol, // best-effort; EDGAR refresh below will overwrite if
                      // we actually get company metadata back
        onWatchlist: false,
        candidateSource: 'screener',
        candidateNotes: thesis,
        discoveredAt: new Date(),
        lastAnalyzedAt: snap ? new Date() : null,
        ...(snap
          ? {
              epsTTM: snap.epsTTM ?? undefined,
              bookValuePerShare: snap.bookValuePerShare ?? undefined,
              dividendPerShare: snap.dividendPerShare ?? undefined,
              sharesOutstanding: snap.sharesOutstanding ?? undefined,
              debtToEquity: snap.debtToEquity ?? undefined,
              returnOnEquity: snap.returnOnEquityPct ?? undefined,
              grossMarginPct: snap.grossMarginPct ?? undefined,
              epsGrowthPct5y: snap.epsGrowthPct5y ?? undefined,
              fundamentalsSource: 'edgar',
              fundamentalsUpdatedAt: new Date(),
            }
          : {}),
      },
      update: {
        // Only touch candidate metadata; preserve anything user or prior
        // runs have set.
        candidateSource: 'screener',
        candidateNotes: thesis,
        discoveredAt: new Date(),
      },
    });

    results.push({
      symbol,
      name: snap?.symbol ?? symbol,
      thesis,
      fundamentalsFetched: snap != null,
      missingFields: snap?.missingFields ?? [],
    });

    log.info('screener.candidate_added', {
      symbol,
      fundamentalsFetched: snap != null,
    });
  }

  return {
    status: 'ok',
    daysSinceLastScreen: cooldown.daysSinceLastScreen,
    cooldownDays: SCREEN_COOLDOWN_DAYS,
    candidates: results,
  };
}

// -------------------- Helpers --------------------

// Screener-specific system prompt. The default perplexitySearch prompt wants
// a Bull/Bear narrative per ticker, which pushes the model toward prose and
// sometimes omits symbols in a machine-readable form. Here we want the exact
// opposite: a tight, line-per-ticker list so the regex extractor sees every
// pick it should.
const SCREENER_SYSTEM =
  'You are a stock screener that returns NEW US common stock tickers matching a user\'s value-investing criteria. Your entire response MUST be a plain list where each line starts with an uppercase ticker symbol followed by a colon. Example: "COST: Costco Wholesale — rare retailer with a moat from membership flywheel." Do not add preambles, headings, or bullet points. Never wrap tickers in markdown. Respect any exclusion list the user supplies.';

function buildScreenPrompt(
  c: Required<ScreenCriteria>,
  excludeSet: Set<string>
): string {
  // Bumped from 80 — if the exclude list is truncated, Perplexity will keep
  // re-suggesting watchlist names it thinks aren't excluded, and those get
  // silently dropped by extractCandidateTickers with no candidates persisted.
  const excludeList = [...excludeSet].sort().slice(0, 250).join(', ');
  const sectors = c.preferredSectors.length
    ? `Preferred sectors: ${c.preferredSectors.join(', ')}.`
    : 'Any sector.';
  const divLine =
    c.minDividendYieldPct > 0
      ? `Minimum dividend yield: ${c.minDividendYieldPct}%.`
      : 'Dividend optional.';
  const hintLine = c.thesisHint ? `Focus area: ${c.thesisHint}.` : '';
  return `I'm a value-investing research assistant looking for NEW US common stocks
to add to a watchlist. I already follow these names — PLEASE EXCLUDE them
from your recommendations:

${excludeList}

Screening criteria:
- US-listed common stocks only (NYSE or NASDAQ). No OTC. No ADRs unless they're
  blue-chip names that file with SEC.
- Return on equity ≥ ${c.minRoePct}%
- Trailing P/E ≤ ${c.maxPeRatio}x
- ${divLine}
- ${sectors}
- Durable competitive moat (brand, switching costs, network effects, scale, or
  regulatory). No unprofitable growth stories, no penny stocks, no recent IPOs.
- Ideally trading at a discount to intrinsic value (margin of safety ≥ 15%).
${hintLine}

Return 3-5 candidates I haven't already heard of. For each candidate, give me:
  Symbol (ticker) — Company Name — one-sentence thesis explaining WHY this
  looks cheap right now or why the moat is underappreciated.

Format each line as:
  TICKER: Company Name — thesis sentence.

Be ruthless about excluding my existing names above. Give me FRESH ideas.`;
}

// Pull the sentence(s) mentioning a ticker from the Perplexity response so
// the user has context at review time. Falls back to an empty string if
// Perplexity didn't write anything identifiable.
function extractThesisFor(symbol: string, text: string): string {
  const re = new RegExp(`[^.!?\\n]*\\b${symbol}\\b[^.!?\\n]*[.!?]?`, 'g');
  const matches = text.match(re) ?? [];
  return matches
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
    .slice(0, 500);
}
