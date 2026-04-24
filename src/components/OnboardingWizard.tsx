'use client';

// Single-screen plan wizard. Per the four-week sprint proposal this
// would be 7-9 screens; v1 ships a mobile-scrollable form with the
// same field set + copy tone. Screen-per-question can come as
// polish later without changing the data shape.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AUTONOMY_LEVELS,
  AUTONOMY_LABEL,
  AUTONOMY_DESCRIPTION,
  type AutonomyLevel,
} from '@/lib/safety/autonomy';

export type OnboardingInitial = {
  planningAssumption: number;
  timeHorizonYears: number;
  maxPositionPct: number;
  drawdownPauseThresholdPct: number;
  autonomyLevel: AutonomyLevel;
  forbiddenSectors: string[];
  forbiddenSymbols: string[];
};

export function OnboardingWizard({ initial }: { initial: OnboardingInitial }) {
  const router = useRouter();
  const [horizon, setHorizon] = useState(String(initial.timeHorizonYears));
  const [plan, setPlan] = useState(String(initial.planningAssumption));
  const [maxPos, setMaxPos] = useState(String(initial.maxPositionPct));
  const [drawdown, setDrawdown] = useState(String(initial.drawdownPauseThresholdPct));
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(initial.autonomyLevel);
  const [sectors, setSectors] = useState(initial.forbiddenSectors.join(', '));
  const [symbols, setSymbols] = useState(initial.forbiddenSymbols.join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          planningAssumption: Number(plan),
          timeHorizonYears: Number(horizon),
          maxPositionPct: Number(maxPos),
          drawdownPauseThresholdPct: Number(drawdown),
          autonomyLevel: autonomy,
          forbiddenSectors: sectors.split(',').map((s) => s.trim()).filter(Boolean),
          forbiddenSymbols: symbols.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(typeof body.error === 'string' ? body.error : 'save failed');
        setBusy(false);
        return;
      }
      router.push('/');
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="card">
        <h2 className="text-sm font-semibold">How long are you investing for?</h2>
        <p className="mt-1 text-xs text-ink-400">
          Your horizon shapes the agent&apos;s patience. A 2022-style
          drawdown at a 3-year horizon is a very different problem than
          the same drawdown at a 20-year horizon.
        </p>
        <input
          type="number"
          min={1}
          max={60}
          value={horizon}
          onChange={(e) => setHorizon(e.target.value)}
          className="mt-3 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-lg"
        />
        <p className="mt-1 text-[11px] text-ink-400">years</p>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">Planning assumption (% / yr)</h2>
        <p className="mt-1 text-xs text-ink-400">
          A planning input only — not a forecast, not a promise. The
          agent uses it to calibrate aggressiveness. 10-12% is
          conservative, 15-20% is balanced, 25%+ pushes hard.
        </p>
        <input
          type="number"
          min={0}
          max={60}
          step={0.5}
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          className="mt-3 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-lg"
        />
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">
          If the portfolio dropped 20% next month, what would you want?
        </h2>
        <p className="mt-1 text-xs text-ink-400">
          Drawdown pause threshold. The agent will automatically halt
          and require your sign-off to resume trading once the
          30-day-peak-to-current move crosses this line.
        </p>
        <input
          type="number"
          min={-80}
          max={0}
          step={1}
          value={drawdown}
          onChange={(e) => setDrawdown(e.target.value)}
          className="mt-3 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-lg"
        />
        <p className="mt-1 text-[11px] text-ink-400">
          Negative percent (e.g. -15 means halt at 15% below the 30-day peak).
        </p>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">No single stock over…</h2>
        <p className="mt-1 text-xs text-ink-400">
          Concentration cap. The agent will never size a position
          larger than this % of the portfolio. 5% is broadly
          diversified; 20% means 5-name conviction book.
        </p>
        <input
          type="number"
          min={1}
          max={40}
          step={1}
          value={maxPos}
          onChange={(e) => setMaxPos(e.target.value)}
          className="mt-3 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-lg"
        />
        <p className="mt-1 text-[11px] text-ink-400">% of portfolio per name</p>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">Autonomy</h2>
        <p className="mt-1 text-xs text-ink-400">
          How much rope does the agent get?
        </p>
        <div className="mt-3 space-y-2">
          {AUTONOMY_LEVELS.map((lvl) => (
            <label
              key={lvl}
              className={`flex cursor-pointer items-start gap-3 rounded-sm border p-3 ${
                autonomy === lvl
                  ? 'border-brand-500 bg-brand-500/10'
                  : 'border-ink-700'
              }`}
            >
              <input
                type="radio"
                name="autonomy"
                checked={autonomy === lvl}
                onChange={() => setAutonomy(lvl)}
                className="mt-1"
              />
              <div>
                <p className="text-sm font-semibold">{AUTONOMY_LABEL[lvl]}</p>
                <p className="mt-0.5 text-xs text-ink-400">
                  {AUTONOMY_DESCRIPTION[lvl]}
                </p>
              </div>
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="text-sm font-semibold">Off-limits (optional)</h2>
        <p className="mt-1 text-xs text-ink-400">
          Sectors or symbols you never want touched. The agent will
          refuse to propose trades in these. Comma-separated.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3">
          <label className="text-xs text-ink-400">
            Forbidden sectors
            <input
              type="text"
              value={sectors}
              onChange={(e) => setSectors(e.target.value)}
              placeholder="e.g. Tobacco, Defense"
              className="mt-1 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-sm"
            />
          </label>
          <label className="text-xs text-ink-400">
            Forbidden symbols
            <input
              type="text"
              value={symbols}
              onChange={(e) => setSymbols(e.target.value)}
              placeholder="e.g. TSLA, META"
              className="mt-1 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-sm"
            />
          </label>
        </div>
      </section>

      {err ? (
        <p className="rounded-sm bg-rose-950 p-2 text-xs text-rose-300">{err}</p>
      ) : null}

      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="sticky bottom-4 rounded-md bg-brand-600 px-4 py-3 text-sm font-semibold disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save plan & continue'}
      </button>
    </div>
  );
}
