// Behavior-alpha card on /analytics. Renders the Governor's
// protective actions over the last 7 days as a single readable
// summary, with a per-reason breakdown for the curious.
//
// Design tenets:
//   • One headline line the user reads at a glance — "Blocked 3
//     trades that would have broken your rules. 8 passed cleanly."
//   • Numbers, not narrative, in the grid. Users can do their own
//     pattern-matching; we don't editorialise.
//   • Reason breakdown is collapsed by default — the card stays
//     small when everything's quiet.

import Link from 'next/link';
import type { GovernorStats } from '@/lib/safety/governor-stats';
import { summarise } from '@/lib/safety/governor-stats';
import type { ReasonCode } from '@/lib/safety/reason-codes';

// Human-readable label for each reason code. Kept local to the
// component because these are UI labels, not the rendered template
// strings in reason-codes.ts — those are for per-decision
// explanations, these are for rollup counts.
const REASON_LABEL: Record<ReasonCode, string> = {
  INVALID_INPUT: 'Invalid input',
  LIMIT_PRICE_REQUIRED: 'Missing limit price',
  ACCOUNT_STOPPED: 'Account stopped',
  ACCOUNT_PAUSED: 'Account paused',
  MOS_INSUFFICIENT: 'MOS too thin',
  EARNINGS_BLACKOUT: 'Earnings blackout',
  WASH_SALE_VIOLATION: 'Wash-sale rule',
  WALLET_INSUFFICIENT: 'Not enough cash',
  NOTIONAL_CAP_EXCEEDED: 'Per-trade cap',
  NO_PRICE_FOR_CAP: 'Price unavailable',
  DAILY_TRADE_CAP_EXCEEDED: 'Daily trade cap',
  OBSERVE_MODE_INTERCEPTED: 'Observe mode intercept',
  PROPOSE_MODE_REQUIRES_APPROVAL: 'Queued for approval',
  BUDGET_EXCEEDED: 'API budget',
  MANDATE_CONCENTRATION_BREACH: 'Over concentration cap',
  MANDATE_SECTOR_BREACH: 'Over sector cap',
  MANDATE_FORBIDDEN_SYMBOL: 'Forbidden symbol',
  MANDATE_FORBIDDEN_SECTOR: 'Forbidden sector',
  MANDATE_CASH_RESERVE_BREACH: 'Cash-reserve floor',
};

function usd(cents: bigint): string {
  const n = Number(cents) / 100;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function GovernorActivityCard({ stats }: { stats: GovernorStats }) {
  const { totals, rejectionsByReason, protectedDollarsCents, approvals } = stats;
  const rejectionEntries = Object.entries(rejectionsByReason).sort(
    (a, b) => b[1] - a[1]
  );

  return (
    <section className="card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Governor activity</h2>
        <span className="text-[11px] text-ink-400">last {stats.windowDays} days</span>
      </div>

      <p className="mt-2 text-sm text-ink-200">{summarise(stats)}</p>

      <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="stat-label">Approved</p>
          <p className="mt-0.5 text-base font-semibold tabular-nums text-emerald-400">
            {totals.approved}
          </p>
        </div>
        <div>
          <p className="stat-label">Blocked</p>
          <p className="mt-0.5 text-base font-semibold tabular-nums text-rose-400">
            {totals.rejected}
          </p>
        </div>
        <div>
          <p className="stat-label">Queued</p>
          <p className="mt-0.5 text-base font-semibold tabular-nums text-amber-400">
            {totals.requires_approval}
          </p>
        </div>
      </div>

      {protectedDollarsCents > 0n && (
        <p className="mt-3 text-xs text-ink-400">
          Protected <span className="font-semibold text-ink-100">{usd(protectedDollarsCents)}</span> of order
          notional from size / cash / cap breaches this window.
        </p>
      )}

      {(approvals.approvedByUser > 0 ||
        approvals.rejectedByUser > 0 ||
        approvals.expired > 0 ||
        approvals.pending > 0) && (
        <div className="mt-3 rounded-sm border border-ink-800 p-2 text-xs text-ink-400">
          <p className="font-semibold text-ink-200">Approval queue</p>
          <div className="mt-1 grid grid-cols-4 gap-2 tabular-nums">
            <span>{approvals.pending} pending</span>
            <span>{approvals.approvedByUser} approved</span>
            <span>{approvals.rejectedByUser} rejected</span>
            <span>{approvals.expired} expired</span>
          </div>
          {approvals.pending > 0 && (
            <Link href="/approvals" className="mt-2 inline-block text-brand-400">
              Review pending →
            </Link>
          )}
        </div>
      )}

      {rejectionEntries.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer select-none text-ink-400">
            Why the blocks fired
          </summary>
          <ul className="mt-2 divide-y divide-ink-800">
            {rejectionEntries.map(([code, n]) => (
              <li key={code} className="flex items-center justify-between py-1.5">
                <span className="text-ink-200">
                  {REASON_LABEL[code as ReasonCode] ?? code}
                </span>
                <span className="tabular-nums text-ink-400">{n}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
