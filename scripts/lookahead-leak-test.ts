// CLI for the lookahead-bias leak test (sprint W0).
//
// Cheap iteration: defaults to Haiku 4.5 + a few names + one
// decision date. A 6-pair Haiku run costs ~$0.06 and tells us
// directionally whether the strict-PIT prompt scaffold is working.
// Same code with `--model claude-opus-4-7` and a bigger pair list
// produces the rigorous answer next month.
//
// Usage:
//   npx tsx scripts/lookahead-leak-test.ts                # default cheap run
//   npx tsx scripts/lookahead-leak-test.ts --opus         # use Opus 4.7
//   npx tsx scripts/lookahead-leak-test.ts --pairs custom.json
//   npx tsx scripts/lookahead-leak-test.ts --cap 1.0      # $1 cost cap
//   npx tsx scripts/lookahead-leak-test.ts --out report.json
//
// Output: prints headline metrics + per-pair table to stdout, optionally
// writes a full JSON report (including raw model text) for later analysis.

import { readFileSync, writeFileSync } from 'node:fs';
import { runLeakBatch, type LeakPair } from '../src/lib/agents/lookahead/leak-test';
import { FAST_MODEL, TRADE_DECISION_MODEL } from '../src/lib/agents/models';

// Default pairs span the eras we walk-forward over. Six names from the
// existing Burry universe (so we have prior context on each) plus SPY
// as a control. Each name appears at decision dates that span the
// 2019-2023 walk-forward windows so any leak signal isn't a one-date
// fluke. Total: 7 names × 1 date = 7 pairs ≈ $0.07 with Haiku.
const DEFAULT_PAIRS: LeakPair[] = [
  { symbol: 'GEO', decisionDateISO: '2021-01-04' },
  { symbol: 'BMY', decisionDateISO: '2021-01-04' },
  { symbol: 'GILD', decisionDateISO: '2021-01-04' },
  { symbol: 'M', decisionDateISO: '2021-01-04' },
  { symbol: 'CVX', decisionDateISO: '2021-01-04' },
  { symbol: 'NVDA', decisionDateISO: '2022-01-03' },
  { symbol: 'SPY', decisionDateISO: '2021-01-04' },
];

function parseArgs(): {
  model: string;
  pairs: LeakPair[];
  costCapUsd: number;
  outPath: string | null;
} {
  const args = process.argv.slice(2);
  let model = FAST_MODEL;
  let pairs = DEFAULT_PAIRS;
  let costCapUsd = 1.0;
  let outPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--opus') model = TRADE_DECISION_MODEL;
    else if (a === '--model') model = args[++i];
    else if (a === '--cap') costCapUsd = Number(args[++i]);
    else if (a === '--out') outPath = args[++i];
    else if (a === '--pairs') {
      const raw = readFileSync(args[++i], 'utf8');
      pairs = JSON.parse(raw);
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: tsx scripts/lookahead-leak-test.ts [--opus|--model X] [--pairs file.json] [--cap USD] [--out report.json]'
      );
      process.exit(0);
    } else {
      console.warn(`Ignoring unknown arg: ${a}`);
    }
  }
  return { model, pairs, costCapUsd, outPath };
}

async function main() {
  const { model, pairs, costCapUsd, outPath } = parseArgs();
  console.log(`Lookahead leak test`);
  console.log(`  Model: ${model}`);
  console.log(`  Pairs: ${pairs.length}`);
  console.log(`  Cost cap: $${costCapUsd.toFixed(2)}`);
  console.log('');

  const summary = await runLeakBatch({
    pairs,
    model,
    costCapUsd,
    onPair: (i, r) => {
      const tag = `[${i + 1}/${pairs.length}] ${r.pair.symbol} @ ${r.pair.decisionDateISO}`;
      const s = r.strict.parsed?.twelve_month_price_target_usd?.toFixed(2) ?? 'PARSE-FAIL';
      const u = r.unrestricted.parsed?.twelve_month_price_target_usd?.toFixed(2) ?? 'PARSE-FAIL';
      const actual =
        r.actualReturnPct != null ? `${r.actualReturnPct >= 0 ? '+' : ''}${r.actualReturnPct.toFixed(1)}%` : 'NO-DATA';
      const cost = (r.strict.costUsd + r.unrestricted.costUsd).toFixed(4);
      console.log(`${tag}  strict=$${s}  unrestricted=$${u}  actual=${actual}  cost=$${cost}`);
    },
  });

  console.log('');
  console.log('─── Headline metrics ───────────────────────────────────────');
  console.log(`Pairs run: ${summary.pairCount}`);
  console.log(`Both arms parsed: ${summary.parsedBoth}`);
  console.log(`Pairs with actual 1-yr return data: ${summary.withActualReturn}`);
  console.log('');
  console.log(`Unrestricted win rate (closer to actual): ${fmtPct(summary.unrestrictedWinRate)}`);
  console.log(`  (0.5 = no leak | 0.7+ = strong leak | <0.4 = strict somehow MORE accurate, suspicious)`);
  console.log('');
  console.log(`Mean target divergence: ${fmtPct(summary.meanTargetDivergencePct, 1)} of decision price`);
  console.log(`  (0% = arms produce identical targets, strict scaffold is doing nothing)`);
  console.log('');
  console.log(`Mean conviction divergence: ${summary.meanConvictionDivergence?.toFixed(1) ?? '—'} points (out of 100)`);
  console.log('');
  console.log(`Total cost: $${summary.totalCostUsd.toFixed(4)}`);

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`\nFull report written to ${outPath}`);
  }
}

function fmtPct(v: number | null, digits = 0): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

main().catch((err) => {
  console.error('leak-test failed:', err);
  process.exit(1);
});
