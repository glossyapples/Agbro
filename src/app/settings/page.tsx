import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { formatPct, formatUsd } from '@/lib/money';
import { SettingsForm } from '@/components/SettingsForm';
import { DepositForm } from '@/components/DepositForm';
import { SignOutButton } from '@/components/SignOutButton';
import { CredentialManager } from '@/components/CredentialManager';
import { SafetyRailsForm } from '@/components/SafetyRailsForm';
import { BudgetForm } from '@/components/BudgetForm';
import { RebootSchedulerButton } from '@/components/RebootSchedulerButton';
import { checkApiBudget } from '@/lib/safety/budget';

export default async function SettingsPage() {
  const user = await requirePageUser('/settings');
  const a = user.account!;
  const budget = await checkApiBudget(user.id);

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-xs text-ink-400">Limits, schedule, risk, disclaimer.</p>
      </header>

      <section className="card">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold">Principal</h2>
            <p className="mt-1 text-sm text-ink-200">
              Deposited: <strong>{formatUsd(a.depositedCents)}</strong> · Plan{' '}
              <strong>{formatPct(a.planningAssumption)}</strong> / yr assumed
            </p>
          </div>
          <Link href="/wallet" className="text-xs text-brand-400">
            Wallet →
          </Link>
        </div>
        <DepositForm />
      </section>

      <SettingsForm
        initial={{
          planningAssumption: a.planningAssumption,
          riskTolerance: a.riskTolerance as 'conservative' | 'moderate' | 'aggressive',
          maxPositionPct: a.maxPositionPct,
          maxDailyTrades: a.maxDailyTrades,
          maxDailyCryptoTrades: a.maxDailyCryptoTrades,
          minCashReservePct: a.minCashReservePct,
          tradingHoursStart: a.tradingHoursStart,
          tradingHoursEnd: a.tradingHoursEnd,
          agentCadenceMinutes: a.agentCadenceMinutes,
          allowDayTrades: a.allowDayTrades,
          autoPromoteCandidates: a.autoPromoteCandidates,
          optionsEnabled: a.optionsEnabled,
          cryptoEnabled: a.cryptoEnabled,
          maxCryptoAllocationPct: a.maxCryptoAllocationPct,
        }}
      />

      <SafetyRailsForm
        initial={{
          dailyLossKillPct: a.dailyLossKillPct,
          drawdownPauseThresholdPct: a.drawdownPauseThresholdPct,
          maxTradeNotionalCents: a.maxTradeNotionalCents.toString(),
          killSwitchTriggeredAt: a.killSwitchTriggeredAt?.toISOString() ?? null,
          killSwitchReason: a.killSwitchReason,
          allowAgentPolicyProposals: a.allowAgentPolicyProposals,
        }}
      />

      <BudgetForm
        initial={{
          monthlyApiBudgetUsd: a.monthlyApiBudgetUsd,
          budgetAlarmThresholdPct: a.budgetAlarmThresholdPct,
          mtdUsd: budget.mtdUsd,
          state: budget.state,
        }}
      />

      <RebootSchedulerButton />

      <CredentialManager />

      <Link href="/help" className="card text-center text-sm text-brand-400">
        Help &amp; docs →
      </Link>

      <Link href="/disclaimer" className="card text-center text-sm text-brand-400">
        Read the full disclaimer →
      </Link>

      <Link href="/analytics" className="card text-center text-sm text-brand-400">
        Analytics / progress →
      </Link>

      <section className="card flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Session</h2>
          <p className="mt-1 text-xs text-ink-400">Signed in as {user.email}</p>
        </div>
        <SignOutButton />
      </section>
    </div>
  );
}
