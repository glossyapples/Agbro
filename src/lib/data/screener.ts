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
    description: string | null;
    thesis: string;
    fundamentalsFetched: boolean;
    missingFields: string[];
    autoPromoted: boolean;
  }>;
  cooldownDays: number;
  error?: string;
};

// -------------------- Rate-limit check --------------------

export async function getCooldownState(userId?: string): Promise<{
  daysSinceLastScreen: number;
  blocked: boolean;
}> {
  // B2.2: per-user cooldown when userId is supplied. Legacy callers
  // without userId still hit the global Stock (preserves old behaviour
  // until B2.3 removes that column).
  const last = userId
    ? await prisma.userWatchlist.findFirst({
        where: { userId, candidateSource: 'screener' },
        orderBy: { discoveredAt: 'desc' },
        select: { discoveredAt: true },
      })
    : await prisma.stock.findFirst({
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

export type ParsedCandidate = {
  symbol: string;
  name: string | null;
  description: string | null;
  thesis: string;
};

// Line-based parser. The screener system prompt asks for
//   TICKER | Company Name | What it does | Thesis
// one per line, which this function parses natively. When the model reverts
// to prose (old em-dash format or loose markdown), we fall back to capturing
// just the ticker + whatever sentence mentions it. That keeps the screener
// robust across Perplexity model drift.
function parseCandidates(text: string, exclude: Set<string>): ParsedCandidate[] {
  const seen = new Set<string>();
  const out: ParsedCandidate[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const raw of lines) {
    const line = raw
      .replace(/^[-*•>\s]+/, '')
      .replace(/^\*\*+|\*\*+$/g, '')
      .trim();
    const m = line.match(/^([A-Z]{2,5}(?:[.\-][A-Z])?)\b/);
    if (!m) continue;
    const symbol = m[1].toUpperCase();
    if (NOT_TICKERS.has(symbol)) continue;
    if (exclude.has(symbol)) continue;
    if (seen.has(symbol)) continue;

    const rest = line
      .slice(m[0].length)
      .replace(/^\s*[:\-—|]+\s*/, '')
      .trim();

    let name: string | null = null;
    let description: string | null = null;
    let thesis = rest;

    const pipeParts = rest.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
    if (pipeParts.length >= 3) {
      name = pipeParts[0] || null;
      description = pipeParts[1] || null;
      thesis = pipeParts.slice(2).join(' | ');
    } else if (pipeParts.length === 2) {
      // Name + thesis, no description
      name = pipeParts[0] || null;
      thesis = pipeParts[1];
    } else {
      // No pipes — try em-dash / hyphen split for "Name — thesis" form
      const dashSplit = rest.split(/\s+[—–]\s+/);
      if (dashSplit.length >= 2) {
        name = dashSplit[0] || null;
        thesis = dashSplit.slice(1).join(' — ');
      }
    }

    seen.add(symbol);
    out.push({ symbol, name, description, thesis: thesis || rest || '' });
  }

  // If line-based parsing found nothing (Perplexity returned a paragraph),
  // fall back to the old regex-over-whole-text approach. Still better than
  // returning zero candidates.
  if (out.length === 0) {
    for (const m of text.matchAll(TICKER_RE)) {
      const symbol = m[1].toUpperCase();
      if (NOT_TICKERS.has(symbol)) continue;
      if (exclude.has(symbol)) continue;
      if (seen.has(symbol)) continue;
      if (symbol.length < 2) continue;
      seen.add(symbol);
      out.push({ symbol, name: null, description: null, thesis: '' });
    }
  }

  return out;
}

// -------------------- Screen --------------------

export type ScreenOptions = {
  // Bypass the 7-day cooldown. Used by the user-triggered /candidates
  // manual refresh; NEVER passed from the agent path.
  bypassCooldown?: boolean;
  // When true, candidates that clear the high-conviction bar are promoted
  // to the watchlist automatically (Account.autoPromoteCandidates). Still
  // written into the Stock table as screener rows first so they get the
  // usual fundamentals + thesis; the flip to onWatchlist=true happens after
  // fundamentals land. If false, every candidate waits for user review.
  autoPromoteHighConviction?: boolean;
};

// High-conviction bar for auto-promote. All four must pass, and we must have
// real EDGAR data (never auto-promote on fabricated seed numbers). Thresholds
// are Buffett-style strict so the bar only trips on clearly durable names.
//   - ROE ≥ criteria minRoePct + 5 (ex: 15 → 20)
//   - Debt/Equity ≤ 1.0 (low leverage)
//   - Gross margin ≥ 35% (pricing power / moat signal)
//   - 5y EPS growth ≥ 5% (growing business, not melting ice cube)
function passesHighConvictionBar(
  snap: { returnOnEquityPct: number | null; debtToEquity: number | null; grossMarginPct: number | null; epsGrowthPct5y: number | null } | null,
  minRoePct: number
): boolean {
  if (!snap) return false;
  if (snap.returnOnEquityPct == null || snap.returnOnEquityPct < minRoePct + 5) return false;
  if (snap.debtToEquity == null || snap.debtToEquity > 1.0) return false;
  if (snap.grossMarginPct == null || snap.grossMarginPct < 35) return false;
  if (snap.epsGrowthPct5y == null || snap.epsGrowthPct5y < 5) return false;
  return true;
}

export async function runScreen(
  criteria: ScreenCriteria,
  options: ScreenOptions = {},
  userId?: string
): Promise<ScreenResult> {
  const cooldown = await getCooldownState(userId);
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
  // did the parser miss the format?
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

  const parsed = parseCandidates(perplexity.summary, exclude).slice(
    0,
    MAX_CANDIDATES_PER_SCREEN
  );
  log.info('screener.candidates_after_filter', {
    keptCount: parsed.length,
    kept: parsed.map((p) => p.symbol),
  });

  if (parsed.length === 0) {
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
  for (const p of parsed) {
    const { symbol } = p;
    const snap = await fetchFundamentals(symbol).catch(() => null);
    // Prefer the parsed thesis from the pipe-formatted line; fall back to
    // extracting the sentence mentioning this ticker if the parser couldn't
    // pull a thesis field (e.g. the model returned prose).
    const thesis = p.thesis || extractThesisFor(symbol, perplexity.summary);
    const description = p.description;
    const displayName = p.name ?? snap?.symbol ?? symbol;

    const highConviction =
      !!options.autoPromoteHighConviction &&
      snap != null &&
      passesHighConvictionBar(snap, c.minRoePct);

    await prisma.stock.upsert({
      where: { symbol },
      create: {
        symbol,
        // Use the model's company name if we parsed one, else the ticker —
        // a later EDGAR refresh can overwrite with the canonical filing name.
        name: displayName,
        onWatchlist: highConviction,
        candidateSource: highConviction ? 'watchlist' : 'screener',
        candidateNotes: thesis,
        businessDescription: description,
        discoveredAt: new Date(),
        autoPromotedAt: highConviction ? new Date() : null,
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
        // runs have set. Do NOT auto-promote existing rows — if a name is
        // already in the DB, there's a reason (including a past user reject).
        candidateSource: 'screener',
        candidateNotes: thesis,
        businessDescription: description,
        discoveredAt: new Date(),
      },
    });

    // B2.1 dual-write: mirror screener state to UserWatchlist. We do
    // this AFTER the Stock upsert so a UserWatchlist row never exists
    // without its Stock catalog counterpart (FK relation). userId is
    // optional on this function for migration; once all callers pass
    // it, it becomes required in B2.3.
    if (userId) {
      const { markCandidate } = await import('./user-watchlist');
      await markCandidate(userId, symbol, {
        source: 'screener',
        notes: thesis,
        autoPromoted: highConviction,
      });
    }

    results.push({
      symbol,
      name: displayName,
      description,
      thesis,
      fundamentalsFetched: snap != null,
      missingFields: snap?.missingFields ?? [],
      autoPromoted: highConviction,
    });

    log.info(highConviction ? 'screener.candidate_auto_promoted' : 'screener.candidate_added', {
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
// opposite: a tight pipe-separated line per ticker so the parser can recover
// (a) the ticker, (b) the company name, (c) a plain-English "what it does"
// description, and (d) the value thesis.
const SCREENER_SYSTEM =
  'You are a stock screener that returns NEW US common stock tickers matching a user\'s value-investing criteria. Your ENTIRE response MUST be a plain list where EACH line has exactly this format: TICKER | Company Name | What the company does in one plain-English sentence (avoid finance jargon) | One-sentence value thesis (why it looks cheap today or why the moat is underappreciated). Example: "COST | Costco Wholesale | Operates membership-only warehouse stores selling groceries and bulk goods. | Membership flywheel compounds, yet the stock trades near its historical P/E mean." Do NOT add preambles, headings, bullet points, markdown, or bold. One candidate per line, no blank lines. Respect any exclusion list the user supplies.';

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

Return 3-5 candidates I haven't already heard of. Format EACH candidate on
its own line with exactly four pipe-separated fields:

  TICKER | Company Name | What the company does (one plain-English sentence, no finance jargon) | Value-investing thesis (one sentence explaining why it looks cheap today or why the moat is underappreciated)

Example:
  COST | Costco Wholesale | Operates membership-only warehouse stores selling groceries and bulk goods. | Membership flywheel compounds, yet trades near historical P/E mean despite accelerating international growth.

No preambles, no headings, no bullet points, no markdown, no blank lines
between candidates. Just the list.

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
