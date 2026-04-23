'use client';

// User-facing controls for the kill-switch thresholds. Rendered on
// /settings below the existing risk/schedule settings. If the kill
// switch is currently active, this card shows the halt state +
// "Clear & resume" action inline so the user doesn't have to bounce
// back to the home page.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type SafetyRailsInitial = {
  dailyLossKillPct: number;
  drawdownPauseThresholdPct: number;
  maxTradeNotionalCents: string; // bigint serialised
  killSwitchTriggeredAt: string | null;
  killSwitchReason: string | null;
  allowAgentPolicyProposals: boolean;
};

export function SafetyRailsForm({ initial }: { initial: SafetyRailsInitial }) {
  const router = useRouter();
  const [dailyLoss, setDailyLoss] = useState(String(initial.dailyLossKillPct));
  const [drawdown, setDrawdown] = useState(String(initial.drawdownPauseThresholdPct));
  const [maxTradeUsd, setMaxTradeUsd] = useState(
    String(Number(initial.maxTradeNotionalCents) / 100)
  );
  const [allowProposals, setAllowProposals] = useState(initial.allowAgentPolicyProposals);
  const [busy, setBusy] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/safety', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dailyLossKillPct: Number(dailyLoss),
          drawdownPauseThresholdPct: Number(drawdown),
          maxTradeNotionalCents: Math.round(Number(maxTradeUsd) * 100),
          allowAgentPolicyProposals: allowProposals,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'save failed');
        return;
      }
      setSavedAt(new Date().toLocaleTimeString());
      router.refresh();
    } catch (e) {
      setError(`Network error: ${(e as Error).message.slice(0, 120)}`);
    } finally {
      setBusy(false);
    }
  }

  async function clearHalt() {
    setClearBusy(true);
    try {
      await fetch('/api/safety/clear-kill-switch', { method: 'POST' });
      router.refresh();
    } finally {
      setClearBusy(false);
    }
  }

  const isHalted = !!initial.killSwitchTriggeredAt;

  return (
    <section className="card flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">Safety rails</h2>
        <p className="mt-0.5 text-[11px] text-ink-400">
          Automatic halts. When any threshold trips, the agent pauses
          immediately and a banner appears on home asking you to review.
          Reset manually once you&apos;re ready to resume.
        </p>
      </div>

      {isHalted && (
        <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-[11px]">
          <p className="font-semibold text-red-200">Currently halted</p>
          <p className="mt-1 text-red-100/90">{initial.killSwitchReason}</p>
          <button
            type="button"
            onClick={clearHalt}
            disabled={clearBusy}
            className="btn-primary mt-2 text-[11px]"
          >
            {clearBusy ? 'Clearing…' : 'Clear & resume'}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-[11px]">
          <span className="flex items-center justify-between">
            <span className="text-ink-300">Daily loss kill (%)</span>
            <span className="text-ink-500">
              current: {initial.dailyLossKillPct}%
            </span>
          </span>
          <input
            type="number"
            step="0.5"
            value={dailyLoss}
            onChange={(e) => setDailyLoss(e.target.value)}
            className="font-mono"
          />
          <span className="text-[10px] text-ink-500">
            Negative number. -5 means pause if today&apos;s equity drops ≥5%. 0
            disables.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-[11px]">
          <span className="flex items-center justify-between">
            <span className="text-ink-300">30-day drawdown pause (%)</span>
            <span className="text-ink-500">
              current: {initial.drawdownPauseThresholdPct}%
            </span>
          </span>
          <input
            type="number"
            step="1"
            value={drawdown}
            onChange={(e) => setDrawdown(e.target.value)}
            className="font-mono"
          />
          <span className="text-[10px] text-ink-500">
            Negative number. -15 means pause when equity is ≥15% below the
            30-day peak. Catches grinding declines a daily check misses.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-[11px]">
          <span className="flex items-center justify-between">
            <span className="text-ink-300">Max trade notional (USD)</span>
            <span className="text-ink-500">
              current: $
              {(Number(initial.maxTradeNotionalCents) / 100).toLocaleString()}
            </span>
          </span>
          <input
            type="number"
            step="100"
            min="100"
            value={maxTradeUsd}
            onChange={(e) => setMaxTradeUsd(e.target.value)}
            className="font-mono"
          />
          <span className="text-[10px] text-ink-500">
            No single buy may exceed this dollar amount. Complements the
            per-position % cap — protects against a bad price fetch.
          </span>
        </label>

        <label className="mt-2 flex items-start gap-2 rounded-md border border-ink-700/60 bg-ink-900/40 p-2 text-[11px]">
          <input
            type="checkbox"
            checked={allowProposals}
            onChange={(e) => setAllowProposals(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-semibold text-ink-200">
              Allow meeting-proposed setting changes
            </span>
            <span className="text-ink-500">
              When on, meetings can propose tweaks to these thresholds +
              cadence + expected return; you still click Accept to apply.
              When off, proposals are recorded for audit but can&apos;t be
              applied. API keys, identity, and deposits are always
              off-limits regardless.
            </span>
          </div>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="btn-primary text-[12px]"
        >
          {busy ? 'Saving…' : 'Save rails'}
        </button>
        {savedAt && (
          <span className="text-[10px] text-ink-500">Saved at {savedAt}</span>
        )}
        {error && <span className="text-[11px] text-red-300">{error}</span>}
      </div>
    </section>
  );
}
