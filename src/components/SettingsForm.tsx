'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type SettingsInitial = {
  expectedAnnualPct: number;
  riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  maxPositionPct: number;
  maxDailyTrades: number;
  minCashReservePct: number;
  tradingHoursStart: string;
  tradingHoursEnd: string;
  agentCadenceMinutes: number;
  allowDayTrades: boolean;
};

export function SettingsForm({ initial }: { initial: SettingsInitial }) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function update<K extends keyof SettingsInitial>(k: K, v: SettingsInitial[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch('/api/account/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      setSaved(true);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Trading rules & schedule</h2>

      <div>
        <label>Expected annual return (%)</label>
        <input
          type="number"
          value={form.expectedAnnualPct}
          onChange={(e) => update('expectedAnnualPct', Number(e.target.value))}
          min={0}
          max={100}
        />
        <p className="mt-1 text-[11px] text-ink-400">
          AgBro's survival goal. Miss this for too long and we re-evaluate the strategy.
        </p>
      </div>

      <div>
        <label>Risk tolerance</label>
        <select
          value={form.riskTolerance}
          onChange={(e) => update('riskTolerance', e.target.value as SettingsInitial['riskTolerance'])}
        >
          <option value="conservative">Conservative</option>
          <option value="moderate">Moderate</option>
          <option value="aggressive">Aggressive</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label>Max position %</label>
          <input
            type="number"
            value={form.maxPositionPct}
            onChange={(e) => update('maxPositionPct', Number(e.target.value))}
            min={1}
            max={100}
          />
        </div>
        <div>
          <label>Min cash reserve %</label>
          <input
            type="number"
            value={form.minCashReservePct}
            onChange={(e) => update('minCashReservePct', Number(e.target.value))}
            min={0}
            max={100}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label>Max trades / day</label>
          <input
            type="number"
            value={form.maxDailyTrades}
            onChange={(e) => update('maxDailyTrades', Number(e.target.value))}
            min={0}
            max={20}
          />
        </div>
        <div>
          <label>Agent cadence (min)</label>
          <input
            type="number"
            value={form.agentCadenceMinutes}
            onChange={(e) => update('agentCadenceMinutes', Number(e.target.value))}
            min={5}
            max={1440}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label>Trading hours start (ET)</label>
          <input
            type="time"
            value={form.tradingHoursStart}
            onChange={(e) => update('tradingHoursStart', e.target.value)}
          />
        </div>
        <div>
          <label>Trading hours end (ET)</label>
          <input
            type="time"
            value={form.tradingHoursEnd}
            onChange={(e) => update('tradingHoursEnd', e.target.value)}
          />
        </div>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.allowDayTrades}
          onChange={(e) => update('allowDayTrades', e.target.checked)}
          className="h-4 w-4 shrink-0 accent-brand-500"
        />
        <span className="text-sm">Allow day trades (not recommended)</span>
      </label>

      <div className="flex items-center justify-end gap-2">
        {saved && <span className="text-xs text-brand-400">Saved ✓</span>}
        <button onClick={save} disabled={saving} className="btn-primary disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
