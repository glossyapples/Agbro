'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Active ↔ Wallet transfer form. Keeps both balances in the same view so
// the user can see the before/after effect of the transfer without
// switching tabs.

type Direction = 'to_wallet' | 'from_wallet';

export function WalletTransferForm({
  alpacaCashUsd,
  walletBalanceUsd,
}: {
  alpacaCashUsd: number;
  walletBalanceUsd: number;
}) {
  const router = useRouter();
  const activeUsd = Math.max(0, alpacaCashUsd - walletBalanceUsd);
  const [direction, setDirection] = useState<Direction>('to_wallet');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0;
  const maxForDirection = direction === 'to_wallet' ? activeUsd : walletBalanceUsd;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch('/api/wallet/transfer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direction, amountUsd: parsed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(typeof data.error === 'string' ? data.error : 'transfer failed');
        return;
      }
      setMsg(
        direction === 'to_wallet'
          ? `Parked $${parsed.toFixed(0)} in wallet — agent can no longer touch it.`
          : `Released $${parsed.toFixed(0)} from wallet — agent can deploy it on next wake-up.`
      );
      setAmount('');
      router.refresh();
    } catch {
      setErr('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Transfer</h2>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setDirection('to_wallet')}
          className={`flex-1 rounded-md border p-2 text-xs font-semibold transition ${
            direction === 'to_wallet'
              ? 'border-brand-500 bg-brand-500/10 text-brand-300'
              : 'border-ink-700/60 text-ink-400'
          }`}
        >
          Active → Wallet
          <p className="mt-0.5 text-[10px] font-normal text-ink-500">
            Park cash. Agent loses access.
          </p>
        </button>
        <button
          type="button"
          onClick={() => setDirection('from_wallet')}
          className={`flex-1 rounded-md border p-2 text-xs font-semibold transition ${
            direction === 'from_wallet'
              ? 'border-brand-500 bg-brand-500/10 text-brand-300'
              : 'border-ink-700/60 text-ink-400'
          }`}
        >
          Wallet → Active
          <p className="mt-0.5 text-[10px] font-normal text-ink-500">
            Release cash. Agent can spend it.
          </p>
        </button>
      </div>

      <div>
        <label>Amount (USD)</label>
        <input
          type="number"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          min={0}
          max={maxForDirection}
        />
        <div className="mt-1 flex items-center justify-between text-[11px]">
          <span className="text-ink-400">
            Max ${maxForDirection.toFixed(0)} for this direction.
          </span>
          <button
            type="button"
            onClick={() => setAmount(String(Math.floor(maxForDirection)))}
            className="text-brand-400"
            disabled={maxForDirection <= 0}
          >
            Transfer all →
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        {msg && <span className="text-xs text-brand-400">{msg}</span>}
        {err && <span className="text-xs text-red-400">{err}</span>}
        {!msg && !err && <span className="text-[11px] text-ink-500">No real Alpaca move — AgBro-side accounting only.</span>}
        <button
          onClick={submit}
          disabled={!valid || busy || parsed > maxForDirection}
          className="btn-primary disabled:opacity-50"
        >
          {busy ? 'Transferring…' : 'Transfer'}
        </button>
      </div>
    </section>
  );
}
