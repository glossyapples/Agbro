'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Soft-confirm threshold. The disclaimer page frames AgBro deposits as a
// casino-budget ("money you'd be fine losing entirely") — anything above
// this gets a two-step confirm so a stray zero doesn't land a year's
// grocery money in paper-trading. Kept local because the right answer
// differs per user; this is a nudge, not a cap.
const LARGE_DEPOSIT_THRESHOLD_USD = 1_000;

export function DepositForm() {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const n = Number(amount);
  const isLarge = Number.isFinite(n) && n >= LARGE_DEPOSIT_THRESHOLD_USD;

  async function submit() {
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter a positive amount.');
      return;
    }
    if (isLarge && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    // Idempotency key per submit. If the network retries, the double-click
    // guard misses, or the server replays the request, the backend dedupes
    // on this key so we never double-credit the account.
    const idempotencyKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `dep-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const res = await fetch('/api/account/deposit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ amount: n, note }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Deposit failed.');
        return;
      }
      setAmount('');
      setNote('');
      setConfirming(false);
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <label htmlFor="deposit-amount" className="sr-only">
          Deposit amount in USD
        </label>
        <input
          id="deposit-amount"
          type="number"
          inputMode="decimal"
          placeholder="Amount (USD)"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setError(null);
            setConfirming(false);
          }}
        />
        <label htmlFor="deposit-note" className="sr-only">
          Deposit note (optional)
        </label>
        <input
          id="deposit-note"
          type="text"
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          onClick={submit}
          disabled={busy || !amount}
          className="btn-primary disabled:opacity-50"
        >
          {confirming ? `Confirm $${n.toLocaleString()}` : 'Deposit'}
        </button>
      </div>
      {confirming && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
          Confirming a ${n.toLocaleString()} deposit. AgBro is paper-trading —
          but this number still sets the principal the agent compounds against,
          so treat it like a casino budget (money you&apos;d be fine losing).
          Tap &ldquo;Confirm&rdquo; again to proceed, or change the amount to
          cancel.
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
