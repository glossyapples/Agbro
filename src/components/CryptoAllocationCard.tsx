// Portfolio-allocation card for /crypto. Shows at-a-glance:
//   - current crypto book value vs. total portfolio value
//   - the defensive cap (Account.maxCryptoAllocationPct) as a line on the
//     bar, so the user sees how close they are to it
//   - headroom in dollars until the cap is hit — the number DCA respects
//   - a clear explanation of how the cap and DCA interact
//
// Exists because users kept asking "there are two crypto settings, which
// one controls what?" This card answers that visually without requiring
// the user to cross-reference two pages.

import Link from 'next/link';
import { formatUsd } from '@/lib/money';

export function CryptoAllocationCard({
  cryptoBookUsd,
  portfolioValueUsd,
  capPct,
}: {
  cryptoBookUsd: number;
  portfolioValueUsd: number;
  capPct: number;
}) {
  const currentPct = portfolioValueUsd > 0 ? (cryptoBookUsd / portfolioValueUsd) * 100 : 0;
  const capUsd = (portfolioValueUsd * capPct) / 100;
  const headroomUsd = Math.max(0, capUsd - cryptoBookUsd);
  const overCap = currentPct > capPct;

  // Bar scales so the cap line sits at ~70% width — gives room on the
  // right to show "over cap" states clearly without the bar clipping off.
  const barMaxPct = Math.max(capPct * 1.4, currentPct * 1.1, 1);
  const barFillPct = Math.min(100, (currentPct / barMaxPct) * 100);
  const capMarkPct = Math.min(100, (capPct / barMaxPct) * 100);

  return (
    <section className="card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink-100">Portfolio allocation</h2>
        <span className={`text-xs font-medium ${overCap ? 'text-red-300' : 'text-ink-300'}`}>
          {currentPct.toFixed(1)}% of portfolio
        </span>
      </div>

      <div className="mt-3 flex items-baseline justify-between text-xs text-ink-400">
        <span>
          Crypto book: <span className="text-ink-200">{formatUsd(BigInt(Math.round(cryptoBookUsd * 100)))}</span>
        </span>
        <span>
          Total: <span className="text-ink-200">{formatUsd(BigInt(Math.round(portfolioValueUsd * 100)))}</span>
        </span>
      </div>

      <div className="relative mt-2 h-2 w-full overflow-hidden rounded-full bg-ink-700/40">
        {/* Current allocation fill */}
        <div
          className={`absolute inset-y-0 left-0 ${overCap ? 'bg-red-500/70' : 'bg-brand-400/80'}`}
          style={{ width: `${barFillPct}%` }}
        />
        {/* Cap line marker */}
        <div
          className="absolute inset-y-[-2px] w-[2px] bg-ink-300"
          style={{ left: `calc(${capMarkPct}% - 1px)` }}
          title={`Cap: ${capPct}%`}
        />
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px]">
        <span className="text-ink-400">
          {overCap ? (
            <span className="text-red-300">
              Over cap by {(currentPct - capPct).toFixed(1)}pt — DCA is skipped, only sells and
              rebalance-to-reduce run until this resolves.
            </span>
          ) : (
            <>
              Headroom before cap:{' '}
              <span className="text-ink-200">
                {formatUsd(BigInt(Math.round(headroomUsd * 100)))}
              </span>
            </>
          )}
        </span>
        <Link href="/settings" className="text-brand-400">
          Edit cap ({capPct}%) →
        </Link>
      </div>

      <p className="mt-3 rounded-md border border-ink-700/60 bg-ink-800/40 p-2 text-[11px] text-ink-400">
        <span className="text-ink-200">How these settings work together:</span> the <em>cap</em>{' '}
        (above, set in Settings) is the maximum crypto can grow to as a share of your whole
        portfolio. The <em>DCA amount</em> (below, set here) is how much you buy each period
        toward that cap. When crypto nears the cap, DCA automatically scales down or pauses so
        the cap is never breached. Rebalancing between coins happens inside the cap.
      </p>
    </section>
  );
}
