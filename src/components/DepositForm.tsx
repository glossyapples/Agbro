'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function DepositForm() {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter a positive amount.');
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
        <input
          type="number"
          inputMode="decimal"
          placeholder="Amount (USD)"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setError(null);
          }}
        />
        <input
          type="text"
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button onClick={submit} disabled={busy || !amount} className="btn-primary disabled:opacity-50">
          Deposit
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
