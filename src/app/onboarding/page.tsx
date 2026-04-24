import { redirect } from 'next/navigation';
import { requirePageUser } from '@/lib/auth';
import { OnboardingWizard } from '@/components/OnboardingWizard';

export const runtime = 'nodejs';

export default async function OnboardingPage() {
  const user = await requirePageUser('/onboarding');
  if (user.account?.onboardingCompletedAt) {
    // Already done — don't let anyone re-wizard their plan through
    // this path; /settings is the edit surface.
    redirect('/');
  }

  const a = user.account!;
  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-semibold">Your Plan</h1>
        <p className="mt-1 text-xs text-ink-400">
          A one-time setup. These answers shape how the agent acts and
          which trades reach you for sign-off. You can change them
          later from Settings.
        </p>
      </header>

      <OnboardingWizard
        initial={{
          planningAssumption: a.planningAssumption,
          timeHorizonYears: a.timeHorizonYears ?? 10,
          maxPositionPct: a.maxPositionPct,
          drawdownPauseThresholdPct: a.drawdownPauseThresholdPct,
          autonomyLevel: (a.autonomyLevel as 'observe' | 'propose' | 'auto') ?? 'propose',
          forbiddenSectors: a.forbiddenSectors,
          forbiddenSymbols: a.forbiddenSymbols,
        }}
      />
    </div>
  );
}
