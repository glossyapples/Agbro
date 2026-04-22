'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CRYPTO_PRESETS,
  CRYPTO_PRESET_KEYS,
  type CryptoPresetKey,
} from '@/lib/crypto/presets';

// Preset allowlist. We intentionally cap the v1 universe to the three
// highest-liquidity, best-tracked pairs Alpaca supports. Adding more is a
// server-side whitelist change; the UI doesn't expose a free-form field.
const ALLOWED_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const;

export type CryptoConfigInitial = {
  allowlist: string[];
  targetAllocations: Record<string, number>;
  dcaAmountUsd: number;
  dcaCadenceDays: number;
  rebalanceBandPct: number;
  rebalanceCadenceDays: number;
  lastDcaAt: string | null;
  presetKey: CryptoPresetKey | null;
};

export function CryptoConfigForm({ initial }: { initial: CryptoConfigInitial }) {
  const router = useRouter();
  // Default to Custom for legacy configs with no preset tag — they've
  // been editing the raw fields freely and we shouldn't silently retag
  // their config as a named strategy.
  const [presetKey, setPresetKey] = useState<CryptoPresetKey>(initial.presetKey ?? 'custom');
  const [allowed, setAllowed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(ALLOWED_SYMBOLS.map((s) => [s, initial.allowlist.includes(s)]))
  );
  const [alloc, setAlloc] = useState<Record<string, string>>(() =>
    Object.fromEntries(ALLOWED_SYMBOLS.map((s) => [s, String(initial.targetAllocations[s] ?? 0)]))
  );
  const [dcaAmount, setDcaAmount] = useState(String(initial.dcaAmountUsd));
  const [dcaCadence, setDcaCadence] = useState(String(initial.dcaCadenceDays));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);

  const currentPreset = CRYPTO_PRESETS[presetKey];
  const locked = currentPreset.locked;

  // When user picks a non-Custom preset, overwrite allowlist / allocations
  // from the preset definition. DCA amount + cadence stay as-is — those
  // are user-specific and don't belong to the preset.
  function applyPreset(key: CryptoPresetKey) {
    setPresetKey(key);
    setSaved(false);
    if (key === 'custom') return;
    const preset = CRYPTO_PRESETS[key];
    setAllowed(
      Object.fromEntries(ALLOWED_SYMBOLS.map((s) => [s, preset.allowlist.includes(s)]))
    );
    setAlloc(
      Object.fromEntries(
        ALLOWED_SYMBOLS.map((s) => [s, String(preset.targetAllocations[s] ?? 0)])
      )
    );
  }

  const allocSum = Object.entries(alloc)
    .filter(([sym]) => allowed[sym])
    .reduce((s, [, v]) => s + (Number(v) || 0), 0);
  const allocValid = allocSum > 0 && allocSum <= 100;

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const allowlist = ALLOWED_SYMBOLS.filter((s) => allowed[s]);
      const targetAllocations: Record<string, number> = {};
      for (const s of allowlist) {
        const n = Number(alloc[s]);
        if (Number.isFinite(n) && n > 0) targetAllocations[s] = n;
      }
      const payload = {
        allowlist,
        targetAllocations,
        dcaAmountUsd: Number(dcaAmount) || 0,
        dcaCadenceDays: Math.max(1, Math.round(Number(dcaCadence) || 7)),
        rebalanceBandPct: currentPreset.rebalanceBandPct,
        rebalanceCadenceDays: currentPreset.rebalanceCadenceDays,
        presetKey,
      };
      const res = await fetch('/api/crypto/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'save failed');
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
    <section className="card flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold">Strategy</h2>
        <p className="mt-1 text-[11px] text-ink-400">
          Pick a preset for opinionated defaults — coins, weights, and
          rebalance cadence are set for you. Choose <em>Custom</em> for
          expert mode, where you pick everything.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {CRYPTO_PRESET_KEYS.map((key) => {
          const p = CRYPTO_PRESETS[key];
          const active = presetKey === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => applyPreset(key)}
              className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition ${
                active
                  ? 'border-brand-500 bg-brand-500/10'
                  : 'border-ink-700/60 bg-ink-800/40 hover:border-ink-600'
              }`}
            >
              <span className="text-sm font-semibold text-ink-100">{p.label}</span>
              <span className="text-[11px] text-ink-400">{p.oneLiner}</span>
            </button>
          );
        })}
      </div>

      <p className="rounded-md border border-ink-700/60 bg-ink-800/40 p-2 text-[11px] text-ink-300">
        {currentPreset.description}
      </p>

      <div>
        <h3 className="text-sm font-semibold">
          Allowlist &amp; allocation targets{' '}
          {locked && (
            <span className="ml-1 text-[10px] font-normal text-ink-400">
              (locked by preset — choose Custom to edit)
            </span>
          )}
        </h3>
        <p className="mt-1 text-[11px] text-ink-400">
          Which coins the engine can trade and how each DCA buy is split.
          Targets sum must be ≤ 100% — residual stays as cash.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {ALLOWED_SYMBOLS.map((sym) => (
          <div key={sym} className="flex items-center gap-2">
            <label className="flex flex-1 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allowed[sym]}
                onChange={(e) => setAllowed((a) => ({ ...a, [sym]: e.target.checked }))}
                disabled={locked}
                className="h-4 w-4 accent-brand-500 disabled:opacity-50"
              />
              <span className={locked ? 'text-ink-300' : undefined}>{sym}</span>
            </label>
            <div className="flex items-center gap-1 text-sm">
              <input
                type="number"
                inputMode="decimal"
                value={alloc[sym]}
                onChange={(e) => setAlloc((a) => ({ ...a, [sym]: e.target.value }))}
                disabled={locked || !allowed[sym]}
                className="w-20 disabled:opacity-50"
                min={0}
                max={100}
              />
              <span className="text-ink-400">%</span>
            </div>
          </div>
        ))}
        <p className={`text-[11px] ${allocValid ? 'text-ink-400' : 'text-amber-400'}`}>
          Total target: {allocSum.toFixed(0)}%{' '}
          {!allocValid && '— must be > 0 and ≤ 100'}
        </p>
      </div>

      <div>
        <h3 className="text-sm font-semibold">DCA schedule — how much you BUY each period</h3>
        <p className="mt-1 text-[11px] text-ink-400">
          Every <em>{dcaCadence}</em> day(s) the engine spends{' '}
          <em>${Number(dcaAmount) || 0}</em>, split across your allowlist
          above. This is the <em>accumulation flow</em> — separate from the
          portfolio cap (in Settings) which is the <em>maximum</em> crypto
          can grow to as a share of your whole portfolio. When the book
          nears the cap, DCA auto-scales or pauses. Set amount to $0 to
          hold without adding more. These two fields are yours regardless
          of the preset above.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label>DCA amount (USD)</label>
          <input
            type="number"
            inputMode="decimal"
            value={dcaAmount}
            onChange={(e) => setDcaAmount(e.target.value)}
            min={0}
            max={10000}
          />
        </div>
        <div>
          <label>Cadence (days)</label>
          <input
            type="number"
            inputMode="numeric"
            value={dcaCadence}
            onChange={(e) => setDcaCadence(e.target.value)}
            min={1}
            max={90}
          />
        </div>
      </div>

      <p className="text-[11px] text-ink-400">
        Rebalance:{' '}
        {currentPreset.allowlist.length > 1 || !locked ? (
          <>
            drift band <span className="text-ink-200">{currentPreset.rebalanceBandPct}%</span> ·
            cadence <span className="text-ink-200">{currentPreset.rebalanceCadenceDays} days</span>
            {locked && ' (set by preset)'}
          </>
        ) : (
          <>n/a for single-asset preset</>
        )}
      </p>

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-ink-400">
          {initial.lastDcaAt
            ? `Last DCA: ${new Date(initial.lastDcaAt).toLocaleDateString()}`
            : 'No DCAs yet.'}
        </p>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-red-400">{error}</span>}
          {saved && <span className="text-xs text-brand-400">Saved ✓</span>}
          <button
            onClick={save}
            disabled={saving || !allocValid}
            className="btn-primary disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="flex items-start justify-between gap-3 border-t border-ink-700/60 pt-3">
        <div>
          <p className="text-sm font-medium text-ink-100">Run DCA now</p>
          <p className="mt-0.5 text-[11px] text-ink-400">
            Triggers the DCA engine immediately for your account. Same
            rate-limit as the cron — if the cadence hasn&apos;t elapsed yet
            it returns a skip reason instead of acting.
          </p>
          {runMsg && <p className="mt-1 text-[11px] text-ink-300">{runMsg}</p>}
        </div>
        <button
          onClick={async () => {
            setRunMsg(null);
            setRunning(true);
            try {
              const res = await fetch('/api/crypto/run', { method: 'POST' });
              const data = await res.json();
              if (!res.ok) {
                setRunMsg(typeof data.error === 'string' ? data.error : 'run failed');
              } else {
                const parts: string[] = [];
                if (data.dca?.ran) {
                  parts.push(`DCA placed ${data.dca.trades.length} order(s)`);
                } else if (data.dca?.skippedReason) {
                  parts.push(`DCA skipped — ${data.dca.skippedReason}`);
                }
                if (data.rebalance?.ran) {
                  parts.push(
                    `rebalance placed ${data.rebalance.trades.length} order(s) (max drift ${data.rebalance.maxDriftPct?.toFixed(1)}%)`
                  );
                } else if (data.rebalance?.skippedReason) {
                  parts.push(`rebalance skipped — ${data.rebalance.skippedReason}`);
                }
                setRunMsg(parts.join(' · ') || 'nothing to do');
                if (data.dca?.ran || data.rebalance?.ran) router.refresh();
              }
            } catch {
              setRunMsg('Network error — try again.');
            } finally {
              setRunning(false);
            }
          }}
          disabled={running}
          className="btn-ghost disabled:opacity-50"
        >
          {running ? 'Running…' : 'Run DCA now'}
        </button>
      </div>
    </section>
  );
}
