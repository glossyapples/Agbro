'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

type Summary = {
  principles: number;
  checklists: number;
  pitfalls: number;
  sector_primers: number;
  case_studies: number;
  total: number;
  alternative_strategies: number;
};

export function BrainSeedButton({ summary, variant }: { summary: Summary; variant: 'empty' | 'compact' }) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    setError(null);
    startBusy(async () => {
      const res = await fetch('/api/brain/load-defaults', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Could not load — try again.');
        return;
      }
      setLoaded(true);
      router.refresh();
    });
  }

  if (variant === 'compact') {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={load}
          disabled={busy || loaded}
          className="btn-ghost text-xs disabled:opacity-50"
        >
          {loaded ? '✓ Loaded' : busy ? 'Loading…' : `+ Load starter brain (${summary.total} entries)`}
        </button>
        {error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
    );
  }

  return (
    <section className="card flex flex-col gap-3 border border-brand-500/30 bg-brand-500/5">
      <h2 className="text-sm font-semibold">Start with a pre-loaded brain</h2>
      <p className="text-sm text-ink-200">
        Install AgBro&apos;s starter knowledge base — <strong>{summary.total} entries</strong> covering
        Buffett/Graham/Munger principles, trading checklists, common biases, sector primers, and historical
        case studies. Plus <strong>{summary.alternative_strategies} archived strategies</strong> for the
        wizard&apos;s comparison view.
      </p>
      <ul className="text-xs text-ink-300 space-y-0.5">
        <li>• {summary.principles} principles (Rule #1, Margin of Safety, Moat First, Invert…)</li>
        <li>• {summary.checklists} operational checklists (pre-trade, sell, research, earnings-day)</li>
        <li>• {summary.pitfalls} biases to resist (value traps, anchoring, averaging down broken theses)</li>
        <li>• {summary.sector_primers} sector primers (Financials, Tech, Energy, Defensive, Healthcare, Industrials)</li>
        <li>• {summary.case_studies} case studies (KO 1988, AXP salad oil, IBM mistake, KHC writedown, airlines)</li>
      </ul>
      <p className="text-[11px] text-ink-400">
        Your active strategy is not changed. The starter alternatives (Deep Value, Quality Compounders, Dividend
        Growth, Boglehead Index) are installed archived — switch to them anytime in Strategy → Activate.
      </p>
      <div className="flex items-center gap-3">
        <button onClick={load} disabled={busy || loaded} className="btn-primary self-start disabled:opacity-50">
          {loaded ? '✓ Loaded — refresh to see' : busy ? 'Loading…' : `Load starter brain (${summary.total} entries)`}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </section>
  );
}
