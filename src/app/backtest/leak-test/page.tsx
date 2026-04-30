import Link from 'next/link';
import { requirePageUser } from '@/lib/auth';
import { LeakTestRunner } from '@/components/LeakTestRunner';

export const runtime = 'nodejs';

export default async function LeakTestPage() {
  await requirePageUser('/backtest/leak-test');
  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between pt-2">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-400">
            AgBro / Backtest
          </p>
          <h1 className="text-2xl font-semibold">W0 — leak test</h1>
          <p className="mt-1 text-xs text-ink-400">
            Asks one question: can Claude be constrained to a
            point-in-time view of the world via prompting alone, or
            does training-data hindsight leak into &quot;as-of-2021&quot;
            research and contaminate every historical backtest?
          </p>
        </div>
        <Link href="/backtest/walk-forward" className="text-xs text-brand-400">
          ← Walk-forward
        </Link>
      </header>

      <section className="card">
        <h2 className="text-sm font-semibold text-ink-100">
          What this run does
        </h2>
        <ul className="mt-2 space-y-1.5 text-xs text-ink-300">
          <li>
            • For each (symbol, decision-date) pair, asks the model
            for a 12-month price target TWICE — once with the strict
            point-in-time scaffold, once unrestricted.
          </li>
          <li>
            • Looks up the actual 12-month return from Alpaca bars.
          </li>
          <li>
            • Counts how often the unrestricted arm was closer to
            actual. <strong>If unrestricted wins ≥ 70% of the time,
            the model is leaking training-data hindsight</strong> and
            agent_deep_research backtests are contaminated.
          </li>
          <li>
            • Default fixture is 61 pairs spanning 2019-2023, mixing
            famous-hindsight cases with weak-prior controls.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold text-ink-100">
          How to read the result
        </h2>
        <ul className="mt-2 space-y-1.5 text-xs text-ink-300">
          <li>
            <strong className="text-emerald-300">45-55%:</strong> No
            leak detectable. Strict scaffold is working. W5 walk-forward
            is worth running.
          </li>
          <li>
            <strong className="text-amber-300">60-70%:</strong>{' '}
            Moderate leak. Iterate on the scaffold prompt, re-run W0
            before W5.
          </li>
          <li>
            <strong className="text-rose-300">70%+:</strong> Strong
            leak. Model can&apos;t be constrained to PIT via prompting
            alone. Don&apos;t run W5 — every alpha number would be
            hindsight.
          </li>
        </ul>
      </section>

      <LeakTestRunner />
    </div>
  );
}
