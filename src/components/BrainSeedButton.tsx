'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

// Starter-brain sync button. First time: one-click seed. Subsequent
// clicks: re-sync — upserts are idempotent and titles/bodies/tags
// updated in place, so clicking on an already-seeded brain pulls in
// whatever library changes have been published since the last sync.
// Post-sync the button shows a summary of what actually changed so
// users know whether there was anything new.

type Summary = {
  principles: number;
  checklists: number;
  pitfalls: number;
  sector_primers: number;
  case_studies: number;
  crisis_playbooks?: number;
  total: number;
  alternative_strategies: number;
  version: string;
};

type SyncResult = {
  brainEntries: { inserted: number; updated: number; unchanged: number; total: number };
  strategies: { inserted: number; updated: number; unchanged: number; total: number };
  backfilled?: number;
};

export function BrainSeedButton({
  summary,
  variant,
  lastSyncedAt,
}: {
  summary: Summary;
  variant: 'empty' | 'compact';
  lastSyncedAt?: string | null;
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);

  async function load() {
    setError(null);
    setLastSync(null);
    startBusy(async () => {
      const res = await fetch('/api/brain/load-defaults', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Could not load — try again.');
        return;
      }
      const data = (await res.json()) as SyncResult;
      setLastSync(data);
      router.refresh();
    });
  }

  const resultLine = lastSync
    ? summarize(lastSync)
    : null;

  if (variant === 'compact') {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={load}
          disabled={busy}
          className="btn-ghost whitespace-nowrap text-xs disabled:opacity-50"
          title={`Sync starter brain · Library v${summary.version} · ${summary.total} entries`}
        >
          {busy ? 'Syncing…' : '↻ Sync'}
        </button>
        {resultLine && <span className="text-[11px] text-ink-300">{resultLine}</span>}
        {error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
    );
  }

  return (
    <section className="card flex flex-col gap-3 border border-brand-500/30 bg-brand-500/5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold">Start with a pre-loaded brain</h2>
        <span className="text-[11px] text-ink-400">Library v{summary.version}</span>
      </div>
      <p className="text-sm text-ink-200">
        Install AgBro&apos;s starter knowledge base — <strong>{summary.total} entries</strong> covering
        Buffett/Graham/Munger principles, trading checklists, common biases, sector primers, historical
        case studies, and crisis playbooks. Plus <strong>{summary.alternative_strategies} archived
        strategies</strong> for the wizard&apos;s comparison view.
      </p>
      <ul className="text-xs text-ink-300 space-y-0.5">
        <li>• {summary.principles} principles (Rule #1, Margin of Safety, Moat First, Invert…)</li>
        <li>• {summary.checklists} operational checklists (pre-trade, sell, research, earnings-day)</li>
        <li>• {summary.pitfalls} biases to resist (value traps, anchoring, averaging down broken theses)</li>
        <li>• {summary.sector_primers} sector primers (Financials, Tech, Energy, Defensive, Healthcare, Industrials)</li>
        <li>• {summary.case_studies} case studies (KO 1988, AXP salad oil, IBM mistake, KHC writedown, airlines)</li>
        {summary.crisis_playbooks != null && (
          <li>• {summary.crisis_playbooks} crisis playbooks (1987, 2000, 2008, 2020, 2022 — what each school did)</li>
        )}
      </ul>
      <p className="text-[11px] text-ink-400">
        Your active strategy is not changed. The starter alternatives (Deep Value, Quality Compounders, Dividend
        Growth, Boglehead Index) are installed archived — switch to them anytime in Strategy → Activate. Re-syncs
        pull in library updates without touching your own notes or trade history.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={load} disabled={busy} className="btn-primary self-start disabled:opacity-50">
          {busy ? 'Loading…' : `Load starter brain (${summary.total} entries)`}
        </button>
        {resultLine && <span className="text-xs text-ink-300">{resultLine}</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
        {lastSyncedAt && !resultLine && (
          <span className="text-[11px] text-ink-400">
            Last synced: {new Date(lastSyncedAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </section>
  );
}

function summarize(r: SyncResult): string {
  const brainChanges = r.brainEntries.inserted + r.brainEntries.updated;
  const stratChanges = r.strategies.inserted + r.strategies.updated;
  const backfilled = r.backfilled ?? 0;
  if (brainChanges === 0 && stratChanges === 0 && backfilled === 0) {
    return '✓ Already up to date.';
  }
  const parts: string[] = [];
  if (r.brainEntries.inserted > 0) parts.push(`+${r.brainEntries.inserted} new`);
  if (r.brainEntries.updated > 0) parts.push(`${r.brainEntries.updated} updated`);
  if (stratChanges > 0) {
    parts.push(`${stratChanges} ${stratChanges === 1 ? 'strategy' : 'strategies'}`);
  }
  if (backfilled > 0) parts.push(`${backfilled} re-labelled`);
  return `✓ ${parts.join(' · ')}`;
}
