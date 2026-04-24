// Persists EDGAR fundamentals into the Stock table. Safe to call repeatedly
// — idempotent upsert keyed by symbol. Each run stamps `fundamentalsSource`
// and `fundamentalsUpdatedAt` so the UI can show "refreshed 2h ago from EDGAR"
// instead of blindly trusting whatever's in the row.
//
// If EDGAR returns null (symbol not found, network failure, parsing gap), we
// leave existing values untouched. The caller sees the null return and can
// decide whether to fall back to Perplexity, the agent, or just skip.

import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { fetchFundamentals, type FundamentalsSnapshot } from './sec-edgar';

export type RefreshResult = {
  symbol: string;
  status: 'updated' | 'not_found' | 'error';
  snapshot?: FundamentalsSnapshot;
  error?: string;
};

export async function refreshFundamentalsForSymbol(symbol: string): Promise<RefreshResult> {
  const sym = symbol.toUpperCase();
  try {
    const snap = await fetchFundamentals(sym);
    if (!snap) return { symbol: sym, status: 'not_found' };

    // Compose the update payload — only overwrite fields we actually got.
    // Preserves any agent-entered values in fields EDGAR didn't return.
    const patch: Record<string, unknown> = {
      fundamentalsSource: 'edgar',
      fundamentalsUpdatedAt: new Date(),
      lastAnalyzedAt: new Date(),
    };
    if (snap.epsTTM != null) patch.epsTTM = snap.epsTTM;
    if (snap.bookValuePerShare != null) patch.bookValuePerShare = snap.bookValuePerShare;
    if (snap.dividendPerShare != null) patch.dividendPerShare = snap.dividendPerShare;
    if (snap.sharesOutstanding != null) patch.sharesOutstanding = snap.sharesOutstanding;
    if (snap.debtToEquity != null) patch.debtToEquity = snap.debtToEquity;
    if (snap.returnOnEquityPct != null) patch.returnOnEquity = snap.returnOnEquityPct;
    if (snap.grossMarginPct != null) patch.grossMarginPct = snap.grossMarginPct;
    if (snap.epsGrowthPct5y != null) patch.epsGrowthPct5y = snap.epsGrowthPct5y;
    if (snap.dividendPerShare != null && snap.bookValuePerShare != null) {
      // Dividend yield requires price; leave null here — the agent fills it
      // at analysis time when it has a live quote.
    }

    await prisma.stock.update({
      where: { symbol: sym },
      data: patch,
    });

    log.info('fundamentals.refreshed', {
      symbol: sym,
      asOf: snap.asOf,
      missingFields: snap.missingFields,
      // Surface share-class adjustments so we can audit them in Railway logs
      // — catches any future dual-class ticker we add to the watchlist
      // without realising it needs an override.
      ...(snap.shareClassAdjustment
        ? {
            shareClassAdjustment: {
              ratio: snap.shareClassAdjustment.ratio,
              note: snap.shareClassAdjustment.note,
            },
          }
        : {}),
    });
    return { symbol: sym, status: 'updated', snapshot: snap };
  } catch (err) {
    const msg = (err as Error).message;
    log.error('fundamentals.refresh_error', err, { symbol: sym });
    return { symbol: sym, status: 'error', error: msg };
  }
}

// Pace requests to stay polite vs. the SEC's 10 req/sec soft limit.
export async function refreshWatchlistFundamentals(options?: {
  delayMs?: number;
}): Promise<RefreshResult[]> {
  const delayMs = options?.delayMs ?? 200; // 5 req/sec, half the SEC ceiling
  // B2.2: union of symbols any user has on their watchlist. Fundamentals
  // themselves are global (Apple's EPS is the same for everyone), so one
  // batch refresh covers all users' watchlists. `distinct: ['symbol']`
  // dedupes the same symbol across multiple users.
  const watchlistRows = await prisma.userWatchlist.findMany({
    where: { onWatchlist: true },
    select: { symbol: true },
    distinct: ['symbol'],
  });

  const out: RefreshResult[] = [];
  for (const s of watchlistRows) {
    const r = await refreshFundamentalsForSymbol(s.symbol);
    out.push(r);
    if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
  }
  return out;
}
