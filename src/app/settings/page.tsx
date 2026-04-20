import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { formatPct, formatUsd } from '@/lib/money';
import { SettingsForm } from '@/components/SettingsForm';
import { DepositForm } from '@/components/DepositForm';

export default async function SettingsPage() {
  const user = await getCurrentUser();
  const a = user.account!;

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-xs text-ink-400">Limits, schedule, risk, disclaimer.</p>
      </header>

      <section className="card">
        <h2 className="text-sm font-semibold">Principal</h2>
        <p className="mt-1 text-sm text-ink-200">
          Deposited: <strong>{formatUsd(a.depositedCents)}</strong> · Target gain{' '}
          <strong>{formatPct(a.expectedAnnualPct)}</strong> / yr
        </p>
        <DepositForm />
      </section>

      <SettingsForm
        initial={{
          expectedAnnualPct: a.expectedAnnualPct,
          riskTolerance: a.riskTolerance as 'conservative' | 'moderate' | 'aggressive',
          maxPositionPct: a.maxPositionPct,
          maxDailyTrades: a.maxDailyTrades,
          minCashReservePct: a.minCashReservePct,
          tradingHoursStart: a.tradingHoursStart,
          tradingHoursEnd: a.tradingHoursEnd,
          agentCadenceMinutes: a.agentCadenceMinutes,
          allowDayTrades: a.allowDayTrades,
        }}
      />

      <Link href="/disclaimer" className="card text-center text-sm text-brand-400">
        Read the full disclaimer →
      </Link>

      <Link href="/analytics" className="card text-center text-sm text-brand-400">
        Analytics / progress →
      </Link>
    </div>
  );
}
