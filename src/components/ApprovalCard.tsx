'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Single pending-approval card. Shows the agent's proposal + its
// rationale + two primary actions (Approve / Reject) plus an
// optional note field on rejection.

export type ApprovalView = {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  orderType: string;
  limitPriceCents: string | null;
  bullCase: string;
  bearCase: string;
  thesis: string;
  confidence: number;
  marginOfSafetyPct: number | null;
  intrinsicValuePerShareCents: string | null;
  expiresAt: string;
  createdAt: string;
};

function usd(cents: string | null): string | null {
  if (!cents) return null;
  const n = Number(cents) / 100;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'expired';
  const hours = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (hours >= 1) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}

export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const router = useRouter();
  const [showRejectNote, setShowRejectNote] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [err, setErr] = useState<string | null>(null);
  const [resolved, setResolved] = useState<null | 'approved' | 'rejected'>(null);

  const limitPrice = usd(approval.limitPriceCents);
  const iv = usd(approval.intrinsicValuePerShareCents);

  async function approve() {
    setBusy('approve');
    setErr(null);
    try {
      const res = await fetch(`/api/approvals/${approval.id}/approve`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data?.message || data?.error || `approval failed (${res.status})`);
        setBusy(null);
        return;
      }
      setResolved('approved');
      setBusy(null);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  async function reject() {
    setBusy('reject');
    setErr(null);
    try {
      const res = await fetch(`/api/approvals/${approval.id}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userNote: note || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data?.error || `reject failed (${res.status})`);
        setBusy(null);
        return;
      }
      setResolved('rejected');
      setBusy(null);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  if (resolved) {
    return (
      <div className="rounded-md border border-ink-800 bg-ink-900 p-3 text-sm text-ink-400">
        {resolved === 'approved'
          ? `${approval.symbol} ${approval.side.toUpperCase()} executing…`
          : `${approval.symbol} rejected.`}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-ink-800 bg-ink-900 p-4">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className={`text-lg font-semibold ${approval.side === 'buy' ? 'text-emerald-400' : 'text-amber-400'}`}>
            {approval.side.toUpperCase()}
          </span>
          <span className="text-lg font-semibold">{approval.symbol}</span>
          <span className="text-xs text-ink-400">× {approval.qty}</span>
        </div>
        <span className="text-xs text-ink-400">{timeUntil(approval.expiresAt)}</span>
      </div>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-400">
        <span>{approval.orderType}</span>
        {limitPrice ? <span>limit {limitPrice}</span> : null}
        {iv ? <span>IV {iv}</span> : null}
        {approval.marginOfSafetyPct != null ? (
          <span>MOS {approval.marginOfSafetyPct.toFixed(1)}%</span>
        ) : null}
        <span>conf {(approval.confidence * 100).toFixed(0)}%</span>
      </div>

      <div className="mt-3 space-y-2 text-sm">
        <p className="text-ink-200">{approval.thesis}</p>
        <details className="text-xs text-ink-400">
          <summary className="cursor-pointer select-none">Bull / bear detail</summary>
          <div className="mt-2 space-y-2">
            <p><span className="text-emerald-400">Bull:</span> {approval.bullCase}</p>
            <p><span className="text-rose-400">Bear:</span> {approval.bearCase}</p>
          </div>
        </details>
      </div>

      {err ? (
        <p className="mt-3 rounded-sm bg-rose-950 p-2 text-xs text-rose-300">{err}</p>
      ) : null}

      {showRejectNote ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2_000}
            rows={3}
            className="w-full rounded-sm border border-ink-800 bg-ink-950 p-2 text-xs"
            placeholder="Optional: tell the agent why (e.g. 'already overweight tech')."
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={reject}
              disabled={busy !== null}
              className="flex-1 rounded-sm bg-rose-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy === 'reject' ? 'Rejecting…' : 'Confirm reject'}
            </button>
            <button
              type="button"
              onClick={() => setShowRejectNote(false)}
              disabled={busy !== null}
              className="rounded-sm border border-ink-700 px-3 py-2 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={approve}
            disabled={busy !== null}
            className="flex-1 rounded-sm bg-emerald-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            onClick={() => setShowRejectNote(true)}
            disabled={busy !== null}
            className="flex-1 rounded-sm border border-ink-700 px-3 py-2 text-sm text-ink-300"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
