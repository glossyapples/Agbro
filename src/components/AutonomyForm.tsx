'use client';

// Edit autonomy level from /settings. Mirrors the OnboardingWizard
// radio-card UI but scoped to this single setting so the user can
// change autonomy without re-running onboarding. Persists via
// /api/account/settings — the same endpoint SettingsForm uses;
// autonomyLevel was added to its Patch schema.
//
// Why dedicated component instead of inlining into SettingsForm:
// autonomy is the highest-blast-radius setting (controls whether the
// agent can spend your money without permission), so it deserves a
// visible card with explicit copy on what each level means. Burying
// it in a row of dropdowns in SettingsForm would understate that.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AUTONOMY_LEVELS,
  AUTONOMY_LABEL,
  AUTONOMY_DESCRIPTION,
  type AutonomyLevel,
} from '@/lib/safety/autonomy';

export function AutonomyForm({ initial }: { initial: AutonomyLevel }) {
  const router = useRouter();
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(initial);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = autonomy !== initial;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autonomyLevel: autonomy }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
        return;
      }
      setSavedAt(Date.now());
      // Refresh server-rendered surfaces (home Plan card, /settings)
      // so they pick up the new value on next render.
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Autonomy</h2>
        <p className="text-[11px] text-ink-400">How much rope does the agent get?</p>
      </div>
      <div className="mt-3 space-y-2">
        {AUTONOMY_LEVELS.map((lvl) => (
          <label
            key={lvl}
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition ${
              autonomy === lvl
                ? 'border-brand-500 bg-brand-500/10'
                : 'border-ink-700 hover:border-ink-600'
            }`}
          >
            <input
              type="radio"
              name="autonomy"
              checked={autonomy === lvl}
              onChange={() => setAutonomy(lvl)}
              disabled={busy}
              className="mt-1"
            />
            <div>
              <p className="text-sm font-semibold">{AUTONOMY_LABEL[lvl]}</p>
              <p className="mt-0.5 text-xs text-ink-400">
                {AUTONOMY_DESCRIPTION[lvl]}
              </p>
            </div>
          </label>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="text-[11px] text-ink-400">
          {error ? (
            <span className="text-rose-300">{error}</span>
          ) : savedAt ? (
            <span className="text-emerald-300">Saved.</span>
          ) : dirty ? (
            <span>Unsaved change.</span>
          ) : (
            <span>Current setting: {AUTONOMY_LABEL[initial]}.</span>
          )}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-ink-900 transition hover:bg-brand-400 disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save autonomy'}
        </button>
      </div>
    </section>
  );
}
