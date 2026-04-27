// SEC EDGAR filings text fetcher. Sister module to sec-edgar.ts which
// pulls structured XBRL fundamentals — this one pulls the raw filing
// TEXT (10-K, 10-Q, 8-K) so the deep-research agent can read what the
// company actually said in its most recent filings.
//
// This is the moat-building work for Sprint W2. Chat-Claude doesn't
// have point-in-time access to SEC filings; an agent that does is a
// real differentiator. Once W3 wires this into the research prompt,
// notes will quote the company's own MD&A and Risk Factors back at
// the user instead of generic compounder talk.
//
// Endpoints:
//   1. https://data.sec.gov/submissions/CIK{padded10}.json
//        — index of every filing for a CIK (form, date, accession).
//   2. https://www.sec.gov/Archives/edgar/data/{cik_no_pad}/{acc_no_dashes}/{primary_doc}
//        — the primary document of a specific filing (usually .htm).
//
// SEC's fair-use policy: same User-Agent rules + ~10 req/sec rate
// limit as sec-edgar.ts. We process one symbol at a time during a
// research call (max 2-3 fetches per symbol — index + 1 or 2 filings)
// so we stay well under the limit.
//
// Caching: filings are immutable once filed, so we cache the parsed
// text by accession number for the process lifetime. The submissions
// index is cached for 1h since it accumulates new filings over time.

import { log } from '@/lib/logger';
import { lookupCik } from './sec-edgar';

const USER_AGENT =
  process.env.AGBRO_SEC_USER_AGENT ??
  'AgBro/1.0 (agbro-trading@example.com) value-investing agent';

const SUBMISSIONS_URL = (cik10: string) =>
  `https://data.sec.gov/submissions/CIK${cik10}.json`;

// SEC archive URLs use the CIK with leading zeros stripped, and the
// accession number with the dashes removed.
function archiveUrl(cik10: string, accession: string, primaryDoc: string): string {
  const cikNoPad = String(parseInt(cik10, 10));
  const accNoDashes = accession.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${accNoDashes}/${primaryDoc}`;
}

// Submissions index shape — only the fields we use. Real response
// has many more fields (addresses, former names, etc.) we ignore.
type SubmissionsIndex = {
  cik: string;
  name: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];   // YYYY-MM-DD
      form: string[];         // "10-K", "10-Q", "8-K", etc.
      primaryDocument: string[];
      // Other parallel arrays we don't currently use:
      // reportDate, acceptanceDateTime, act, fileNumber, items,
      // size, isXBRL, isInlineXBRL, primaryDocDescription
    };
  };
};

export type FilingMeta = {
  symbol: string;
  cik10: string;
  accession: string;
  form: string;
  filingDateISO: string;
  primaryDocument: string;
  url: string;
};

const submissionsCache = new Map<string, { idx: SubmissionsIndex; fetchedMs: number }>();
const SUBMISSIONS_TTL_MS = 60 * 60_000; // 1 hour

async function fetchSubmissionsIndex(cik10: string): Promise<SubmissionsIndex> {
  const hit = submissionsCache.get(cik10);
  if (hit && Date.now() - hit.fetchedMs < SUBMISSIONS_TTL_MS) {
    return hit.idx;
  }
  const res = await fetch(SUBMISSIONS_URL(cik10), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`sec submissions ${res.status} for CIK ${cik10}`);
  }
  const idx = (await res.json()) as SubmissionsIndex;
  submissionsCache.set(cik10, { idx, fetchedMs: Date.now() });
  return idx;
}

export type ListFilingsOpts = {
  // Form types to include. Defaults to ['10-K', '10-Q'] — the two
  // periodic reports a research agent cares about most.
  forms?: string[];
  // Point-in-time cutoff. Only return filings with filingDate < this
  // date. Critical for backtest: prevents the agent from reading a
  // filing that wasn't yet public on its decision date.
  filedBeforeISO?: string;
  // Cap the result. Newest first.
  limit?: number;
};

// List recent filings for a symbol. Returns newest-first. PIT-safe
// when filedBeforeISO is set.
export async function listFilings(
  symbol: string,
  opts: ListFilingsOpts = {}
): Promise<FilingMeta[]> {
  const cik10 = await lookupCik(symbol);
  if (!cik10) {
    log.warn('sec_filings.cik_not_found', { symbol });
    return [];
  }
  const idx = await fetchSubmissionsIndex(cik10);
  const forms = new Set(opts.forms ?? ['10-K', '10-Q']);
  const limit = opts.limit ?? 20;

  const r = idx.filings.recent;
  const out: FilingMeta[] = [];
  for (let i = 0; i < r.accessionNumber.length; i++) {
    const form = r.form[i];
    if (!forms.has(form)) continue;
    const filingDate = r.filingDate[i];
    if (opts.filedBeforeISO && filingDate >= opts.filedBeforeISO) continue;
    out.push({
      symbol: symbol.toUpperCase(),
      cik10,
      accession: r.accessionNumber[i],
      form,
      filingDateISO: filingDate,
      primaryDocument: r.primaryDocument[i],
      url: archiveUrl(cik10, r.accessionNumber[i], r.primaryDocument[i]),
    });
  }
  // Newest first by filing date.
  out.sort((a, b) => b.filingDateISO.localeCompare(a.filingDateISO));
  return out.slice(0, limit);
}

const filingTextCache = new Map<string, string>();

// Fetch the primary document of a filing and strip to plain text.
// Cached forever (filings are immutable once filed). Returns the
// text or throws on network / HTTP errors.
export async function fetchFilingText(filing: FilingMeta): Promise<string> {
  const cacheKey = `${filing.cik10}|${filing.accession}`;
  const hit = filingTextCache.get(cacheKey);
  if (hit) return hit;

  const res = await fetch(filing.url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`sec filing ${res.status} for ${filing.symbol} ${filing.accession}`);
  }
  const html = await res.text();
  const text = htmlToText(html);
  filingTextCache.set(cacheKey, text);
  return text;
}

// Strip HTML to readable text. SEC filings are often XBRL-tagged
// HTML with heavy inline styling — we want the human-readable text
// that a contemporaneous analyst would have seen, minus the noise.
//
// Pure helper exported for tests.
export function htmlToText(html: string): string {
  return html
    // Remove script + style blocks entirely (content is irrelevant).
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    // XBRL-only blocks (ix:header) are metadata, not content.
    .replace(/<ix:header\b[^<]*(?:(?!<\/ix:header>)<[^<]*)*<\/ix:header>/gi, ' ')
    // Treat block-level tags as line breaks so paragraph structure
    // survives the strip. Without this, "Item 1.Business" runs
    // together with the prior heading.
    .replace(/<\/(p|div|tr|li|h[1-6]|br|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove every other tag.
    .replace(/<[^>]+>/g, ' ')
    // Decode the entities we actually see in SEC filings.
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    // Collapse runs of whitespace (filings have lots of indentation).
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Extract a specific "Item" section from a 10-K / 10-Q filing.
// `itemTag` is the item identifier without the word "Item" — e.g.
// "1A" for Risk Factors, "7" for MD&A. Case-insensitive.
//
// Returns the text from the start of the named item up to the start
// of the next "Item" heading (or end of document). Returns null if
// the section can't be located.
//
// Pure helper exported for tests.
export function extractItemSection(text: string, itemTag: string): string | null {
  // Build a regex that finds "Item 1A" / "ITEM 1A." / "Item 1A —" etc.
  // We anchor with word boundaries on the item tag so "Item 1" doesn't
  // match "Item 1A" and vice versa.
  const tagEsc = itemTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(
    `(?:^|\\n)\\s*ITEM\\s+${tagEsc}(?:\\b|\\.|\\s)`,
    'i'
  );
  // The "next item" heading. Any item identifier — digits, optionally
  // followed by a single letter (1A, 7A, etc.).
  const nextItemRe = /\n\s*ITEM\s+\d+[A-Z]?(?:\b|\.|\s)/i;

  const startMatch = startRe.exec(text);
  if (!startMatch) return null;
  const sliceStart = startMatch.index + startMatch[0].length;

  const remainder = text.slice(sliceStart);
  const nextMatch = nextItemRe.exec(remainder);
  const sliceEnd = nextMatch ? sliceStart + nextMatch.index : text.length;

  const section = text.slice(sliceStart, sliceEnd).trim();
  return section.length > 0 ? section : null;
}

// High-level helper: fetch the most recent 10-K + most recent 10-Q
// (PIT-aware) and return their key narrative sections, ready to be
// pasted into the research agent's prompt. Token-budget-aware: each
// section is truncated to a sensible character cap so a single
// research call doesn't blow the context window.
//
// Defaults are tuned for the deep-research agent's prompt:
//   - 10-K Risk Factors (Item 1A): up to 12,000 chars (~3k tokens)
//   - 10-K MD&A (Item 7): up to 12,000 chars (~3k tokens)
//   - 10-Q MD&A (Item 2 in 10-Q): up to 8,000 chars (~2k tokens)
// Together: ~8k tokens of filing context, plus the existing fundamentals
// snapshot. Leaves headroom in the 200k Opus context for thinking.
export type ResearchFilings = {
  symbol: string;
  cik10: string;
  latest10K: { filing: FilingMeta; riskFactors: string | null; mda: string | null } | null;
  latest10Q: { filing: FilingMeta; mda: string | null } | null;
};

export async function getResearchFilings(
  symbol: string,
  opts: { filedBeforeISO?: string } = {}
): Promise<ResearchFilings> {
  const RISK_CAP = 12_000;
  const MDA_CAP = 12_000;
  const Q_MDA_CAP = 8_000;

  const cik10 = await lookupCik(symbol);
  if (!cik10) {
    return { symbol, cik10: '', latest10K: null, latest10Q: null };
  }

  const filings = await listFilings(symbol, {
    forms: ['10-K', '10-Q'],
    filedBeforeISO: opts.filedBeforeISO,
    limit: 8,
  });
  const latest10KMeta = filings.find((f) => f.form === '10-K') ?? null;
  const latest10QMeta = filings.find((f) => f.form === '10-Q') ?? null;

  let latest10K: ResearchFilings['latest10K'] = null;
  if (latest10KMeta) {
    try {
      const text = await fetchFilingText(latest10KMeta);
      const risk = extractItemSection(text, '1A');
      const mda = extractItemSection(text, '7');
      latest10K = {
        filing: latest10KMeta,
        riskFactors: risk ? truncate(risk, RISK_CAP) : null,
        mda: mda ? truncate(mda, MDA_CAP) : null,
      };
    } catch (err) {
      log.warn('sec_filings.10k_fetch_failed', {
        symbol,
        accession: latest10KMeta.accession,
        error: String(err),
      });
    }
  }

  let latest10Q: ResearchFilings['latest10Q'] = null;
  if (latest10QMeta) {
    try {
      const text = await fetchFilingText(latest10QMeta);
      // 10-Q's MD&A is "Item 2" of Part I (not Item 7 like in 10-K).
      const mda = extractItemSection(text, '2');
      latest10Q = {
        filing: latest10QMeta,
        mda: mda ? truncate(mda, Q_MDA_CAP) : null,
      };
    } catch (err) {
      log.warn('sec_filings.10q_fetch_failed', {
        symbol,
        accession: latest10QMeta.accession,
        error: String(err),
      });
    }
  }

  return { symbol, cik10, latest10K, latest10Q };
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + '\n\n[…truncated; see filing for full text]';
}

// Test hook to clear caches between scenarios.
export function _clearSecFilingsCacheForTests(): void {
  submissionsCache.clear();
  filingTextCache.clear();
}
