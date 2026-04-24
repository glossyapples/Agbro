// Structured reason codes for every pre-trade decision the safety
// gate makes. Every gate that used to throw a plain-string error now
// also emits a (code, params) pair so the Governor audit table and
// the approval queue can render user-facing explanations without
// screen-scraping the error string.
//
// Design rules:
//   1. Adding a reason is additive — append to REASON_CODES, add a
//      template in RENDER. Removing / renaming a code is a breaking
//      change; callers will fail the type-narrow.
//   2. Templates are pure functions over a typed params object, not
//      interpolated strings, so a missing param fails at compile time.
//   3. No i18n today. Copy is plain English, ≤ 140 chars per template,
//      written for the end-user to read — not the agent, not the logs.
//   4. The decision-code triple (approved | rejected | requires_approval)
//      stays separate from reason codes; the same code can appear in
//      either rejected or requires_approval context (e.g. MANDATE_…
//      breaches become approval-required at 'propose' autonomy).

export const REASON_CODES = [
  // Input / plumbing rejections
  'INVALID_INPUT',
  'LIMIT_PRICE_REQUIRED',

  // Account-state rejections
  'ACCOUNT_STOPPED',
  'ACCOUNT_PAUSED',

  // Strategy-rule rejections
  'MOS_INSUFFICIENT',

  // Event-driven rejections
  'EARNINGS_BLACKOUT',
  'WASH_SALE_VIOLATION',

  // Cash / sizing rejections
  'WALLET_INSUFFICIENT',
  'NOTIONAL_CAP_EXCEEDED',
  'NO_PRICE_FOR_CAP',

  // Cadence rejections
  'DAILY_TRADE_CAP_EXCEEDED',

  // Autonomy-ladder outcomes (never appear at 'auto' level)
  'OBSERVE_MODE_INTERCEPTED',
  'PROPOSE_MODE_REQUIRES_APPROVAL',

  // Budget (BYOK cost governor)
  'BUDGET_EXCEEDED',

  // Future — Mandate-driven rejections; wired when the Mandate fields
  // land. Declared here so the approval queue's UI code can stabilize
  // on the full enum without a second deploy.
  'MANDATE_CONCENTRATION_BREACH',
  'MANDATE_SECTOR_BREACH',
  'MANDATE_FORBIDDEN_SYMBOL',
  'MANDATE_FORBIDDEN_SECTOR',
  'MANDATE_CASH_RESERVE_BREACH',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export function isReasonCode(x: unknown): x is ReasonCode {
  return typeof x === 'string' && (REASON_CODES as readonly string[]).includes(x);
}

// Governor decision outcomes. The approval queue is the home for
// 'requires_approval'; 'rejected' never lands in the queue.
export const DECISIONS = ['approved', 'rejected', 'requires_approval'] as const;
export type Decision = (typeof DECISIONS)[number];

// Typed params for each reason code's render template. Keeping the
// codes → param-type mapping explicit makes "adding a new code" a
// three-step edit (enum, params, template) that TypeScript enforces.
export type ReasonParams = {
  INVALID_INPUT: { message: string };
  LIMIT_PRICE_REQUIRED: Record<string, never>;
  ACCOUNT_STOPPED: Record<string, never>;
  ACCOUNT_PAUSED: Record<string, never>;
  MOS_INSUFFICIENT: { mosPct: number; strategyMinPct: number; strategyName: string };
  EARNINGS_BLACKOUT: { symbol: string; nextEarningsAt: Date | null };
  WASH_SALE_VIOLATION: { symbol: string; windowEndsAt: Date | null };
  WALLET_INSUFFICIENT: {
    symbol: string;
    needCents: bigint;
    haveCents: bigint;
    walletCents: bigint;
  };
  NOTIONAL_CAP_EXCEEDED: { symbol: string; needCents: bigint; capCents: bigint };
  NO_PRICE_FOR_CAP: { symbol: string };
  DAILY_TRADE_CAP_EXCEEDED: { cap: number };
  OBSERVE_MODE_INTERCEPTED: { symbol: string };
  PROPOSE_MODE_REQUIRES_APPROVAL: { symbol: string };
  BUDGET_EXCEEDED: { mtdSpendUsd: number; budgetUsd: number };
  MANDATE_CONCENTRATION_BREACH: {
    symbol: string;
    wouldBePct: number;
    capPct: number;
  };
  MANDATE_SECTOR_BREACH: {
    sector: string;
    wouldBePct: number;
    capPct: number;
  };
  MANDATE_FORBIDDEN_SYMBOL: { symbol: string };
  MANDATE_FORBIDDEN_SECTOR: { symbol: string; sector: string };
  MANDATE_CASH_RESERVE_BREACH: {
    floorPct: number;
    wouldBePct: number;
  };
};

// Quick currency helper — avoids a toolbox dep just for this.
function usd(cents: bigint | number): string {
  const n = typeof cents === 'bigint' ? Number(cents) : cents;
  return `$${(n / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

type Renderer<K extends ReasonCode> = (p: ReasonParams[K]) => string;
type RenderMap = { [K in ReasonCode]: Renderer<K> };

export const RENDER: RenderMap = {
  INVALID_INPUT: (p) => `Trade input rejected: ${p.message}`,
  LIMIT_PRICE_REQUIRED: () =>
    'Limit orders need a limit price. Resubmit with limitPrice set, or switch to a market order.',
  ACCOUNT_STOPPED: () =>
    'Trading is stopped on this account. Restart from Settings to resume.',
  ACCOUNT_PAUSED: () =>
    'Trading is paused on this account. Unpause from Settings or clear the kill switch.',
  MOS_INSUFFICIENT: (p) =>
    `Margin of safety ${p.mosPct.toFixed(1)}% is below ${p.strategyName}'s minimum of ${p.strategyMinPct}%. Either find a cheaper entry or revise the strategy bar.`,
  EARNINGS_BLACKOUT: (p) =>
    p.nextEarningsAt
      ? `Buys on ${p.symbol} are blocked until after earnings on ${p.nextEarningsAt.toISOString().slice(0, 10)}. Sells and trims are unaffected.`
      : `Buys on ${p.symbol} are in the pre-earnings blackout window. Wait for the report.`,
  WASH_SALE_VIOLATION: (p) =>
    p.windowEndsAt
      ? `Rebuying ${p.symbol} before ${p.windowEndsAt.toISOString().slice(0, 10)} would disallow the loss on the recent sale (IRS §1091). Wait out the 30-day window.`
      : `Rebuying ${p.symbol} would trigger the IRS §1091 wash-sale rule. Wait 30 days from the loss sale.`,
  WALLET_INSUFFICIENT: (p) =>
    `Not enough spendable cash for ${p.symbol}: need ~${usd(p.needCents)}, have ${usd(p.haveCents)} (${usd(p.walletCents)} is parked in the wallet). Transfer to active cash to enable this trade.`,
  NOTIONAL_CAP_EXCEEDED: (p) =>
    `${p.symbol} order of ~${usd(p.needCents)} exceeds the per-trade cap of ${usd(p.capCents)}. Raise the cap in Settings or split the order.`,
  NO_PRICE_FOR_CAP: (p) =>
    `Cannot size the order for ${p.symbol} — live price is unavailable and no limit price was supplied. Retry when market data is healthy, or submit as a limit order.`,
  DAILY_TRADE_CAP_EXCEEDED: (p) =>
    `Daily stock-trade cap of ${p.cap} has been reached. The agent will resume tomorrow; raise the cap in Settings if needed.`,
  OBSERVE_MODE_INTERCEPTED: (p) =>
    `In Observe mode, trade proposals are never executed. Logged ${p.symbol} as an idea for your review.`,
  PROPOSE_MODE_REQUIRES_APPROVAL: (p) =>
    `In Propose mode, every trade needs your sign-off. ${p.symbol} is waiting for you in the approval queue.`,
  BUDGET_EXCEEDED: (p) =>
    `API-cost budget hit: spent $${p.mtdSpendUsd.toFixed(2)} of your $${p.budgetUsd.toFixed(0)} monthly limit. The agent is paused; raise the budget in Settings to resume.`,
  MANDATE_CONCENTRATION_BREACH: (p) =>
    `This trade would push your ${p.symbol} position to ${p.wouldBePct.toFixed(1)}% of portfolio, above your ${p.capPct.toFixed(0)}% single-name cap.`,
  MANDATE_SECTOR_BREACH: (p) =>
    `This trade would push your ${p.sector} exposure to ${p.wouldBePct.toFixed(1)}%, above your ${p.capPct.toFixed(0)}% sector cap.`,
  MANDATE_FORBIDDEN_SYMBOL: (p) =>
    `Your Plan forbids trading ${p.symbol}. Update the Plan to remove the restriction, or skip this trade.`,
  MANDATE_FORBIDDEN_SECTOR: (p) =>
    `Your Plan forbids the ${p.sector} sector, which ${p.symbol} belongs to. Update the Plan or skip this trade.`,
  MANDATE_CASH_RESERVE_BREACH: (p) =>
    `This trade would drop your cash reserve to ${p.wouldBePct.toFixed(1)}%, below your Plan's ${p.floorPct.toFixed(0)}% floor.`,
};

export function renderReason<K extends ReasonCode>(code: K, params: ReasonParams[K]): string {
  return RENDER[code](params);
}

// A single reason-coded decision. Sent into the Governor audit table
// and used by the approval queue's UI rendering.
export type CodedReason = {
  [K in ReasonCode]: { code: K; params: ReasonParams[K] };
}[ReasonCode];

export function renderCodedReason(r: CodedReason): string {
  return renderReason(r.code, r.params as never);
}

// The full decision that the trade gate emits. Approved trades carry
// an empty reasons array; rejected trades carry ≥1 reason; requires_approval
// carries the reason that escalated (e.g. PROPOSE_MODE_REQUIRES_APPROVAL)
// plus any Mandate context the approver should see.
export type GovernorVerdict = {
  decision: Decision;
  reasons: CodedReason[];
};

// First reason wins for the human-facing one-liner. Approved → empty.
export function summarize(verdict: GovernorVerdict): string {
  if (verdict.reasons.length === 0) return 'Approved.';
  return renderCodedReason(verdict.reasons[0]);
}
