// CLI: pulls fresh fundamentals from SEC EDGAR for every stock currently on
// the watchlist. Use this after deploy to replace the hand-entered seed
// values with authoritative SEC-filed numbers.
//
// Usage:
//   npm run fundamentals:refresh              # refresh all watchlist symbols
//   npm run fundamentals:refresh -- AAPL KO  # refresh specific symbols
//
// Prints a summary and exits non-zero if every symbol failed (so a CI job
// can alarm). A partial success (most OK, a couple missing) exits zero.

import { PrismaClient } from '@prisma/client';
import {
  refreshFundamentalsForSymbol,
  refreshWatchlistFundamentals,
} from '../src/lib/data/refresh-fundamentals';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const results =
    args.length > 0
      ? await Promise.all(args.map((s) => refreshFundamentalsForSymbol(s)))
      : await refreshWatchlistFundamentals();

  const ok = results.filter((r) => r.status === 'updated');
  const missing = results.filter((r) => r.status === 'not_found');
  const errored = results.filter((r) => r.status === 'error');

  console.log('\n── SEC EDGAR fundamentals refresh ──');
  for (const r of results) {
    if (r.status === 'updated') {
      const s = r.snapshot!;
      const miss = s.missingFields.length ? ` · missing: ${s.missingFields.join(',')}` : '';
      console.log(
        `  ✓ ${r.symbol.padEnd(6)} asOf ${s.asOf}  ` +
          `EPS ${fmt(s.epsTTM)}  BV/sh ${fmt(s.bookValuePerShare)}  ` +
          `ROE ${fmt(s.returnOnEquityPct)}%  D/E ${fmt(s.debtToEquity)}${miss}`
      );
    } else if (r.status === 'not_found') {
      console.log(`  ? ${r.symbol.padEnd(6)} not found in EDGAR (non-US ADR, ETF, or ticker changed)`);
    } else {
      console.log(`  ✗ ${r.symbol.padEnd(6)} ${r.error}`);
    }
  }
  console.log(`\n${ok.length} updated · ${missing.length} not in EDGAR · ${errored.length} errored`);

  if (results.length > 0 && ok.length === 0) process.exit(1);
}

function fmt(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(2);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
