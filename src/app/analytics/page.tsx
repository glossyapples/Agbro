import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { formatPct, formatUsd } from '@/lib/money';
import { getDividends } from '@/lib/alpaca';
import { ManualSellButton } from '@/components/ManualSellButton';

// First-of-month at ~midnight ET. Close enough for a "this month" filter —
// a trade that fills in the first 5 hours of a new month UTC would still
// get counted in "this month" per ET, which is what a US-equities trader
// would expect to see.
function startOfMonthET(now: Date): Date {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  // 5am UTC ≈ midnight/1am ET depending on DST. Imprecise at the exact
  // boundary (~5 hours) but the filter is informational, not tax-reporting.
  return new Date(`${year}-${month}-01T05:00:00Z`);
}

export default async function AnalyticsPage() {
  const user = await requirePageUser('/analytics');
  const now = new Date();
  const monthStart = startOfMonthET(now);
  const monthStartIso = monthStart.toISOString().slice(0, 10);

  const [trades, runs, positions, watchlist, optionPositions, dividends] =
    await Promise.all([
      prisma.trade.findMany({
        where: { userId: user.id },
        orderBy: { submittedAt: 'desc' },
      }),
      prisma.agentRun.findMany({
        where: { userId: user.id },
        take: 30,
        orderBy: { startedAt: 'desc' },
      }),
      prisma.position.findMany({ where: { userId: user.id } }),
      // B2.2: per-user watchlist via UserWatchlist + Stock join; promote the
      // Stock rows back to the top level to preserve the existing shape.
      prisma.userWatchlist
        .findMany({
          where: { userId: user.id, onWatchlist: true },
          include: { stock: true },
        })
        .then((rows) =>
          rows
            .map((r) => r.stock)
            .sort((a, b) => (b.buffettScore ?? -1) - (a.buffettScore ?? -1))
        ),
      prisma.optionPosition.findMany({ where: { userId: user.id } }),
      getDividends(monthStartIso).catch(() => []),
    ]);

  const buys = trades.filter((t) => t.side === 'buy').length;
  const sells = trades.filter((t) => t.side === 'sell').length;
  const closed = trades.filter((t) => t.closedAt);
  const wins = closed.filter((t) => (t.realizedPnlCents ?? 0n) > 0n).length;
  const losses = closed.filter((t) => (t.realizedPnlCents ?? 0n) < 0n).length;
  const totalPnlCents = closed.reduce<bigint>(
    (acc, t) => acc + (t.realizedPnlCents ?? 0n),
    0n
  );

  // ── Attribution ─────────────────────────────────────────────────────
  // Two views per category: "this month" (for the current month's scorecard)
  // and "all-time" (the raw cumulative since account open). Pulls from three
  // sources:
  //   - Trade rows with assetClass='stock' vs 'crypto', filtered by closedAt
  //     for month view. Existing realizedPnlCents populated on sell submit.
  //   - OptionPosition.totalCreditCents for premium collected (gross).
  //     Assignment P/L flows through the resulting stock trade, so we're
  //     not double-counting — the CREDIT is the income, and any share
  //     impact hits the stocks bucket.
  //   - Alpaca's /v2/account/activities?DIV feed, queried since month
  //     start for the month view + since epoch for all-time.
  const sumPnl = (filter: (t: (typeof trades)[number]) => boolean): bigint =>
    trades.filter(filter).reduce<bigint>((a, t) => a + (t.realizedPnlCents ?? 0n), 0n);

  const stockPnlMonth = sumPnl(
    (t) =>
      (t.assetClass === 'stock' || t.assetClass === null) &&
      t.side === 'sell' &&
      t.closedAt != null &&
      t.closedAt >= monthStart
  );
  const stockPnlAll = sumPnl(
    (t) => (t.assetClass === 'stock' || t.assetClass === null) && t.side === 'sell'
  );
  const cryptoPnlMonth = sumPnl(
    (t) =>
      t.assetClass === 'crypto' &&
      t.side === 'sell' &&
      t.closedAt != null &&
      t.closedAt >= monthStart
  );
  const cryptoPnlAll = sumPnl((t) => t.assetClass === 'crypto' && t.side === 'sell');

  const optionPremiumMonth = optionPositions
    .filter((o) => o.openedAt >= monthStart)
    .reduce<bigint>((a, o) => a + o.totalCreditCents, 0n);
  const optionPremiumAll = optionPositions.reduce<bigint>(
    (a, o) => a + o.totalCreditCents,
    0n
  );

  const dividendsMonth = dividends.reduce<bigint>(
    (a, d) => a + d.netAmountCents,
    0n
  );
  // All-time dividends would need a full-history activities pull (paginated);
  // for the first pass, "month" is the main signal. Display a hint in the
  // all-time column so the number isn't misread.
  const dividendsAll: bigint | null = null;

  const monthAttributionTotal =
    stockPnlMonth + cryptoPnlMonth + optionPremiumMonth + dividendsMonth;

  const runsOk = runs.filter((r) => r.status === 'completed').length;
  const runsSkipped = runs.filter((r) => r.status === 'skipped').length;
  const runsErr = runs.filter((r) => r.status === 'errored').length;

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3 pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Analytics</h1>
          <p className="text-xs text-ink-400">Scoreboard. The brain watches these closely.</p>
        </div>
        <a href="/backtest" className="text-xs text-brand-400">
          Backtest →
        </a>
      </header>

      <section className="card">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">P/L attribution</h2>
          <span className="text-[11px] text-ink-400">
            month-to-date · all-time
          </span>
        </div>
        <p className="mt-1 text-[11px] text-ink-400">
          Where the money is coming from. Without this, we stare at total
          return and can&apos;t tell whether it was stocks, options income,
          crypto, or dividends doing the work.
        </p>
        <div className="mt-3 divide-y divide-ink-700/60 text-sm">
          <AttributionRow
            label="Stocks (realised)"
            month={stockPnlMonth}
            all={stockPnlAll}
          />
          <AttributionRow
            label="Options premium (gross)"
            month={optionPremiumMonth}
            all={optionPremiumAll}
            hint="assignment P/L flows through stocks bucket"
          />
          <AttributionRow
            label="Crypto (realised)"
            month={cryptoPnlMonth}
            all={cryptoPnlAll}
          />
          <AttributionRow
            label="Dividends"
            month={dividendsMonth}
            all={dividendsAll}
            hint="all-time requires a deeper activities pull"
          />
          <div className="flex items-center justify-between pt-2 text-sm font-semibold">
            <span>Month-to-date total</span>
            <span className={monthAttributionTotal >= 0n ? 'text-brand-400' : 'text-red-300'}>
              {formatUsd(monthAttributionTotal)}
            </span>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">Trading</h2>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
          <Stat label="Total trades" value={trades.length.toString()} />
          <Stat label="Buys / Sells" value={`${buys} / ${sells}`} />
          <Stat label="Closed positions" value={closed.length.toString()} />
          <Stat label="Win / Loss" value={`${wins} / ${losses}`} />
          <Stat label="Realized P/L" value={formatUsd(totalPnlCents)} />
          <Stat
            label="Plan / yr"
            value={formatPct(user.account?.planningAssumption)}
          />
        </div>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">Agent</h2>
        <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
          <Stat label="Completed" value={runsOk.toString()} />
          <Stat label="Skipped" value={runsSkipped.toString()} />
          <Stat label="Errored" value={runsErr.toString()} />
        </div>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">Open positions ({positions.length})</h2>
        {positions.length === 0 ? (
          <p className="mt-1 text-xs text-ink-400">None yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-ink-700/60 text-sm">
            {positions.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2">
                <span>{p.symbol} · {p.qty}</span>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-ink-400">avg {formatUsd(p.avgCostCents)}</span>
                  <ManualSellButton symbol={p.symbol} heldQty={p.qty} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">Watchlist (top {watchlist.length})</h2>
        <ul className="mt-2 divide-y divide-ink-700/60 text-sm">
          {watchlist.slice(0, 20).map((s) => (
            <li key={s.symbol} className="flex items-center justify-between py-2">
              <div>
                <span className="font-semibold">{s.symbol}</span>{' '}
                <span className="text-ink-400">· {s.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="pill">Buffett {s.buffettScore}</span>
                <span className="pill">Moat {s.moatScore}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="stat-label">{label}</p>
      <p className="text-lg font-semibold text-ink-50">{value}</p>
    </div>
  );
}

// Two-column P/L row: month-to-date on the left, all-time on the right.
// Null all-time means "not available yet" (see dividends note above).
function AttributionRow({
  label,
  month,
  all,
  hint,
}: {
  label: string;
  month: bigint;
  all: bigint | null;
  hint?: string;
}) {
  const monthColor = month >= 0n ? 'text-brand-400' : 'text-red-300';
  const allColor =
    all == null ? 'text-ink-400' : all >= 0n ? 'text-brand-400' : 'text-red-300';
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <p className="text-ink-100">{label}</p>
        {hint && <p className="mt-0.5 text-[10px] text-ink-500">{hint}</p>}
      </div>
      <div className="flex items-center gap-3 text-right">
        <span className={`w-24 ${monthColor}`}>{formatUsd(month)}</span>
        <span className={`w-24 ${allColor}`}>
          {all == null ? '—' : formatUsd(all)}
        </span>
      </div>
    </div>
  );
}
