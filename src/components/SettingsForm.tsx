'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type SettingsInitial = {
  expectedAnnualPct: number;
  riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  maxPositionPct: number;
  maxDailyTrades: number;
  maxDailyCryptoTrades: number;
  minCashReservePct: number;
  tradingHoursStart: string;
  tradingHoursEnd: string;
  agentCadenceMinutes: number;
  allowDayTrades: boolean;
  autoPromoteCandidates: boolean;
  optionsEnabled: boolean;
  cryptoEnabled: boolean;
  maxCryptoAllocationPct: number;
};

// All numeric fields are stored as strings internally so the input stays
// editable when the user clears the field (React number bindings
// round "" → 0 and re-render "0", which eats every keystroke).
type FormState = {
  expectedAnnualPct: string;
  riskTolerance: SettingsInitial['riskTolerance'];
  maxPositionPct: string;
  maxDailyTrades: string;
  maxDailyCryptoTrades: string;
  minCashReservePct: string;
  tradingHoursStart: string;
  tradingHoursEnd: string;
  agentCadenceMinutes: string;
  allowDayTrades: boolean;
  autoPromoteCandidates: boolean;
  optionsEnabled: boolean;
  cryptoEnabled: boolean;
  maxCryptoAllocationPct: string;
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

// Flag unrealistic APR targets without blocking them. For reference, Buffett's
// career avg is ~20%, S&P 500 long-run avg is ~10%. 30%+ is "I know what I'm
// doing and I accept that chasing this likely means taking losses".
function unrealisticAprWarning(raw: string): string | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n > 100)
    return `${n}%/yr means more than doubling every year — no strategy sustains that. The agent will take aggressive risk trying.`;
  if (n > 50)
    return `${n}%/yr is deep into hedge-fund-blowup territory. Expect the agent to size up and accept larger drawdowns.`;
  if (n > 30)
    return `${n}%/yr beats Buffett's career average. Aggressive but not absurd — the agent will lean into higher-conviction trades.`;
  return null;
}

function toForm(initial: SettingsInitial): FormState {
  return {
    expectedAnnualPct: String(initial.expectedAnnualPct),
    riskTolerance: initial.riskTolerance,
    maxPositionPct: String(initial.maxPositionPct),
    maxDailyTrades: String(initial.maxDailyTrades),
    maxDailyCryptoTrades: String(initial.maxDailyCryptoTrades),
    minCashReservePct: String(initial.minCashReservePct),
    tradingHoursStart: initial.tradingHoursStart,
    tradingHoursEnd: initial.tradingHoursEnd,
    agentCadenceMinutes: String(initial.agentCadenceMinutes),
    allowDayTrades: initial.allowDayTrades,
    autoPromoteCandidates: initial.autoPromoteCandidates,
    optionsEnabled: initial.optionsEnabled,
    cryptoEnabled: initial.cryptoEnabled,
    maxCryptoAllocationPct: String(initial.maxCryptoAllocationPct),
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
        maxDailyCryptoTrades: Math.round(
          num(form.maxDailyCryptoTrades, initial.maxDailyCryptoTrades)
        ),
        minCashReservePct: num(form.minCashReservePct, initial.minCashReservePct),
        tradingHoursStart: form.tradingHoursStart,
        tradingHoursEnd: form.tradingHoursEnd,
        agentCadenceMinutes: Math.round(num(form.agentCadenceMinutes, initial.agentCadenceMinutes)),
        allowDayTrades: form.allowDayTrades,
        autoPromoteCandidates: form.autoPromoteCandidates,
        optionsEnabled: form.optionsEnabled,
        cryptoEnabled: form.cryptoEnabled,
        maxCryptoAllocationPct: num(form.maxCryptoAllocationPct, initial.maxCryptoAllocationPct),
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
        <label htmlFor="settings-expected-annual-pct">
          Expected annual return (%)
        </label>
        <input
          id="settings-expected-annual-pct"
          type="number"
          inputMode="decimal"
          value={form.expectedAnnualPct}
          onChange={(e) => update('expectedAnnualPct', e.target.value)}
          min={0}
        />
        <p className="mt-1 text-[11px] text-ink-400">
          AgBro&apos;s survival goal. The agent will push harder when this is
          high and stay conservative when it&apos;s low. Safety rails below
          still apply no matter what.
        </p>
        {unrealisticAprWarning(form.expectedAnnualPct) && (
          <p className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
            ⚠ {unrealisticAprWarning(form.expectedAnnualPct)}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="settings-risk-tolerance">Risk tolerance</label>
        <select
          id="settings-risk-tolerance"
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
          <label htmlFor="settings-max-position-pct">Max position %</label>
          <input
            id="settings-max-position-pct"
            type="number"
            inputMode="decimal"
            value={form.maxPositionPct}
            onChange={(e) => update('maxPositionPct', e.target.value)}
            min={1}
            max={100}
          />
        </div>
        <div>
          <label htmlFor="settings-min-cash-reserve-pct">
            Min cash reserve %
          </label>
          <input
            id="settings-min-cash-reserve-pct"
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
          <label htmlFor="settings-max-daily-trades">
            Max stock trades / day
          </label>
          <input
            id="settings-max-daily-trades"
            type="number"
            inputMode="numeric"
            value={form.maxDailyTrades}
            onChange={(e) => update('maxDailyTrades', e.target.value)}
            min={0}
            max={20}
          />
          <p className="mt-0.5 text-[10px] text-ink-400">
            Agent-driven stock trades only. Crypto has its own cap below.
          </p>
        </div>
        <div>
          <label htmlFor="settings-max-daily-crypto-trades">
            Max crypto trades / day
          </label>
          <input
            id="settings-max-daily-crypto-trades"
            type="number"
            inputMode="numeric"
            value={form.maxDailyCryptoTrades}
            onChange={(e) => update('maxDailyCryptoTrades', e.target.value)}
            min={0}
            max={50}
          />
          <p className="mt-0.5 text-[10px] text-ink-400">
            Rule-based DCA + rebalance legs. Each DCA writes one trade per coin.
          </p>
        </div>
        <div>
          <label htmlFor="settings-agent-cadence">Agent cadence (min)</label>
          <input
            id="settings-agent-cadence"
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
          <label htmlFor="settings-trading-hours-start">
            Trading hours start (ET)
          </label>
          <input
            id="settings-trading-hours-start"
            type="time"
            value={form.tradingHoursStart}
            onChange={(e) => update('tradingHoursStart', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="settings-trading-hours-end">
            Trading hours end (ET)
          </label>
          <input
            id="settings-trading-hours-end"
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

      <div>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={form.autoPromoteCandidates}
            onChange={(e) => update('autoPromoteCandidates', e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-brand-500"
          />
          <span className="text-sm">Auto-promote high-conviction candidates</span>
        </label>
        <p className="mt-1 text-[11px] text-ink-400">
          When on, the weekly screen auto-adds candidates that clear a strict
          Buffett bar (real EDGAR data · ROE 5+ pts above your minimum · debt-
          to-equity ≤ 1.0 · gross margin ≥ 35% · 5y EPS growth ≥ 5%). Others
          still wait for your review on the Candidates page. Default off.
        </p>
      </div>

      <div>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={form.optionsEnabled}
            onChange={(e) => update('optionsEnabled', e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-brand-500"
          />
          <span className="text-sm">Enable options (covered calls + cash-secured puts only)</span>
        </label>
        <p className="mt-1 text-[11px] text-ink-400">
          Master switch. When on, the agent MAY sell covered calls on
          existing positions (strike ≥ your fair-value estimate) or cash-
          secured puts on watchlist names (strike ≤ your buy target). No
          naked options, no spreads, no long options — ever. Your active
          strategy must also permit options (Compounders + Boglehead don&apos;t).
          Requires options approval on your Alpaca account. Default off.
        </p>
      </div>

      <div>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={form.cryptoEnabled}
            onChange={(e) => update('cryptoEnabled', e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-brand-500"
          />
          <span className="text-sm">Enable crypto module (rule-based DCA only)</span>
        </label>
        <p className="mt-1 text-[11px] text-ink-400">
          Master switch for the Crypto tab. When on, a deterministic DCA
          engine runs on its own cron, buying the coins + percentages you
          set on the /crypto page. The LLM agent never reasons about
          crypto — it&apos;s pure rules. Off by default. Turning this off
          preserves your config but stops all DCA activity.
        </p>
      </div>

      <div>
        <label htmlFor="settings-max-crypto-allocation-pct">
          Crypto portfolio cap (% of total portfolio)
        </label>
        <input
          id="settings-max-crypto-allocation-pct"
          type="number"
          inputMode="decimal"
          value={form.maxCryptoAllocationPct}
          onChange={(e) => update('maxCryptoAllocationPct', e.target.value)}
          min={0}
          max={100}
        />
        <p className="mt-1 text-[11px] text-ink-400">
          This is a <em>ceiling</em>, not a target. Total crypto exposure
          (all coin market values combined) can never exceed this % of
          your whole portfolio (stocks + options + crypto). When hit, DCA
          scales down or skips; rebalance buys scale to fit; sells always
          proceed. Default 10% keeps crypto as a small asymmetric
          satellite. The <em>how much to buy each week</em> setting lives
          on the <a href="/crypto" className="text-brand-400">Crypto page</a>{' '}
          and is a different concept — it&apos;s a flow, not a ceiling.
        </p>
      </div>

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
