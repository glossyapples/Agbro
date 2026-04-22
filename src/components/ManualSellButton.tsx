'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Small per-position Sell button. Prompts for confirmation (optional
// partial-qty) then calls the manual-sell endpoint. Keeps UI friction
// low but not zero — you still have to confirm, because a manual sell
// skips the exit framework's guardrails (earnings blackout suppression,
// etc.) and we want that to be an explicit decision.

export function ManualSellButton({
  symbol,
  heldQty,
}: {
  symbol: string;
  heldQty: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(String(heldQty));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const parsed = Number(qty);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > heldQty) {
      setErr(`Enter a qty between 0 and ${heldQty}.`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/trades/manual-sell', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, qty: parsed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(typeof data.error === 'string' ? data.error : 'sell failed');
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setErr('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-red-300 hover:text-red-200"
      >
        Sell
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 text-xs">
      <input
        type="number"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        min={0}
        max={heldQty}
        step={0.0001}
        className="w-20 rounded border border-ink-700 bg-ink-800 px-1 py-0.5 text-right"
        disabled={busy}
      />
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="rounded bg-red-500/20 px-2 py-0.5 text-red-200 hover:bg-red-500/30 disabled:opacity-50"
      >
        {busy ? '…' : 'Confirm'}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setErr(null);
        }}
        className="text-ink-400"
      >
        Cancel
      </button>
      {err && <span className="text-[11px] text-red-300">{err}</span>}
    </div>
  );
}
