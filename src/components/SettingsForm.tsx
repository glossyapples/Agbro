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

// All numeric fields are stored as strings internally so the input stays
// editable when the user clears the field (React number bindings
// round "" → 0 and re-render "0", which eats every keystroke).
type FormState = {
  expectedAnnualPct: string;
  riskTolerance: SettingsInitial['riskTolerance'];
  maxPositionPct: string;
  maxDailyTrades: string;
  minCashReservePct: string;
  tradingHoursStart: string;
  tradingHoursEnd: string;
  agentCadenceMinutes: string;
  allowDayTrades: boolean;
};

// Zod's flatten() output comes through as { fieldErrors, formErrors }. Pick
// the first field message if any; otherwise the first form-level message;
// otherwise a generic fallback. Keeps error rendering to a single line.
function formatApiError(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const maybe = raw as {
      fieldErrors?: Record<string, string[] | undefined>;
      formErrors?: string[];
    };
    if (maybe.fieldErrors) {
      for (const [field, messages] of Object.entries(maybe.fieldErrors)) {
        const msg = messages?.[0];
        if (msg) return `${field}: ${msg}`;
      }
    }
    const formMsg = maybe.formErrors?.[0];
    if (formMsg) return formMsg;
  }
  return 'Save failed — check your inputs.';
}

function toForm(initial: SettingsInitial): FormState {
  return {
    expectedAnnualPct: String(initial.expectedAnnualPct),
    riskTolerance: initial.riskTolerance,
    maxPositionPct: String(initial.maxPositionPct),
    maxDailyTrades: String(initial.maxDailyTrades),
    minCashReservePct: String(initial.minCashReservePct),
    tradingHoursStart: initial.tradingHoursStart,
    tradingHoursEnd: initial.tradingHoursEnd,
    agentCadenceMinutes: String(initial.agentCadenceMinutes),
    allowDayTrades: initial.allowDayTrades,
  };
}

export function SettingsForm({ initial }: { initial: SettingsInitial }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => toForm(initial));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
    setError(null);
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      // Parse numerics at submit time. Empty or non-numeric values fall back
      // to the initial value so we never post NaN / 0 accidentally.
      const num = (s: string, fallback: number) => {
        const n = Number(s);
        return Number.isFinite(n) && s.trim() !== '' ? n : fallback;
      };
      const payload = {
        expectedAnnualPct: num(form.expectedAnnualPct, initial.expectedAnnualPct),
        riskTolerance: form.riskTolerance,
        maxPositionPct: num(form.maxPositionPct, initial.maxPositionPct),
        maxDailyTrades: Math.round(num(form.maxDailyTrades, initial.maxDailyTrades)),
        minCashReservePct: num(form.minCashReservePct, initial.minCashReservePct),
        tradingHoursStart: form.tradingHoursStart,
        tradingHoursEnd: form.tradingHoursEnd,
        agentCadenceMinutes: Math.round(num(form.agentCadenceMinutes, initial.agentCadenceMinutes)),
        allowDayTrades: form.allowDayTrades,
      };
      const res = await fetch('/api/account/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(formatApiError(body.error));
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError('Network error — try again.');
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
          inputMode="decimal"
          value={form.expectedAnnualPct}
          onChange={(e) => update('expectedAnnualPct', e.target.value)}
          min={0}
          max={100}
        />
        <p className="mt-1 text-[11px] text-ink-400">
          AgBro&apos;s survival goal. 0–100%. Miss this for too long and we re-evaluate the strategy.
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
            inputMode="decimal"
            value={form.maxPositionPct}
            onChange={(e) => update('maxPositionPct', e.target.value)}
            min={1}
            max={100}
          />
        </div>
        <div>
          <label>Min cash reserve %</label>
          <input
            type="number"
            inputMode="decimal"
            value={form.minCashReservePct}
            onChange={(e) => update('minCashReservePct', e.target.value)}
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
            inputMode="numeric"
            value={form.maxDailyTrades}
            onChange={(e) => update('maxDailyTrades', e.target.value)}
            min={0}
            max={20}
          />
        </div>
        <div>
          <label>Agent cadence (min)</label>
          <input
            type="number"
            inputMode="numeric"
            value={form.agentCadenceMinutes}
            onChange={(e) => update('agentCadenceMinutes', e.target.value)}
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
        {error && <span className="text-xs text-red-400">{error}</span>}
        {saved && <span className="text-xs text-brand-400">Saved ✓</span>}
        <button onClick={save} disabled={saving} className="btn-primary disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
