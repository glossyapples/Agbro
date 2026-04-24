'use client';

// BYOK API cost-governor form. Lets the user cap month-to-date
// Anthropic spend; at 100% of cap the scheduler auto-pauses with
// a BUDGET_EXCEEDED kill-switch reason. Null cap = disabled.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type BudgetInitial = {
  monthlyApiBudgetUsd: number | null;
  budgetAlarmThresholdPct: number;
  mtdUsd: number;
  state: 'disabled' | 'ok' | 'warning' | 'exceeded';
};

export function BudgetForm({ initial }: { initial: BudgetInitial }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.monthlyApiBudgetUsd != null);
  const [budget, setBudget] = useState(String(initial.monthlyApiBudgetUsd ?? 50));
  const [threshold, setThreshold] = useState(String(initial.budgetAlarmThresholdPct));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/budget', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          monthlyApiBudgetUsd: enabled ? Number(budget) : null,
          budgetAlarmThresholdPct: Number(threshold),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'save failed');
        setBusy(false);
        return;
      }
      setSavedAt(new Date().toLocaleTimeString());
      setBusy(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const pct =
    initial.monthlyApiBudgetUsd && initial.monthlyApiBudgetUsd > 0
      ? (initial.mtdUsd / initial.monthlyApiBudgetUsd) * 100
      : 0;

  return (
    <section className="card">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">API cost governor</h2>
        <span className="text-xs text-ink-400">
          ${initial.mtdUsd.toFixed(2)} MTD
        </span>
      </div>
      <p className="mb-3 text-xs text-ink-400">
        BYOK protection — we aggregate your agent-run cost since the 1st
        of the month. At the alarm threshold you get a banner; at 100%
        the agent pauses automatically with a clearable kill switch.
      </p>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable monthly cap
      </label>

      {enabled ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="text-xs text-ink-400">
              Monthly cap ($)
              <input
                type="number"
                min={5}
                max={5_000}
                step={5}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="mt-1 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-sm"
              />
            </label>
            <label className="text-xs text-ink-400">
              Alarm threshold (%)
              <input
                type="number"
                min={10}
                max={99}
                step={5}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className="mt-1 w-full rounded-sm border border-ink-700 bg-ink-950 p-2 text-sm"
              />
            </label>
          </div>
          {initial.monthlyApiBudgetUsd && initial.monthlyApiBudgetUsd > 0 ? (
            <div className="mt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-sm bg-ink-800">
                <div
                  className={`h-full ${
                    initial.state === 'exceeded'
                      ? 'bg-rose-500'
                      : initial.state === 'warning'
                        ? 'bg-amber-400'
                        : 'bg-emerald-500'
                  }`}
                  style={{ width: `${Math.min(100, pct).toFixed(0)}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-ink-400">
                {pct.toFixed(0)}% of current cap
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-xs text-ink-400">
          Cap disabled. You will not be paused on API spend.
        </p>
      )}

      {error ? (
        <p className="mt-3 rounded-sm bg-rose-950 p-2 text-xs text-rose-300">{error}</p>
      ) : null}
      <div className="mt-4 flex items-center justify-end gap-3">
        {savedAt ? (
          <span className="text-xs text-ink-400">saved {savedAt}</span>
        ) : null}
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-sm bg-brand-600 px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
