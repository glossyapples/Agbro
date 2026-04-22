'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
};

export function CryptoConfigForm({ initial }: { initial: CryptoConfigInitial }) {
  const router = useRouter();
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
    <section className="card flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">Allowlist & allocation targets</h2>
        <p className="mt-1 text-[11px] text-ink-400">
          Pick which coins the engine can trade and how to split each DCA
          buy. Anything not in the allowlist is ignored entirely. Targets
          sum must be ≤ 100% — residual stays as cash.
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
                className="h-4 w-4 accent-brand-500"
              />
              <span>{sym}</span>
            </label>
            <div className="flex items-center gap-1 text-sm">
              <input
                type="number"
                inputMode="decimal"
                value={alloc[sym]}
                onChange={(e) => setAlloc((a) => ({ ...a, [sym]: e.target.value }))}
                disabled={!allowed[sym]}
                className="w-20"
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
        <h2 className="text-sm font-semibold">DCA schedule</h2>
        <p className="mt-1 text-[11px] text-ink-400">
          Every <em>{dcaCadence}</em> day(s) the engine will spend{' '}
          <em>${Number(dcaAmount) || 0}</em>, split across your targets.
          Set amount to $0 to hold without adding more.
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
