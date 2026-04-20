'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function DepositForm() {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const n = Number(amount);
    if (!(n > 0)) return;
    setBusy(true);
    try {
      await fetch('/api/account/deposit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: n, note }),
      });
      setAmount('');
      setNote('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2">
      <input
        type="number"
        placeholder="Amount (USD)"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
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
  );
}
