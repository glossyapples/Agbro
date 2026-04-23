'use client';

// BYOK (Bring Your Own Key) manager on /settings. Lets the user save
// per-provider API keys that override the app's defaults. Keys are
// encrypted server-side (see src/lib/credentials.ts) and only
// masked representations are ever sent back to the client.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Provider = 'openai' | 'anthropic' | 'perplexity';

type Credential = {
  provider: Provider;
  maskedKey: string;
  createdAt: string;
  updatedAt: string;
};

const PROVIDER_META: Record<Provider, { label: string; note: string; required?: string }> = {
  openai: {
    label: 'OpenAI',
    note: 'Used for meeting comic generation. Without this, meetings still run — just as text.',
    required: 'Starts with sk-...',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    note: 'Optional — overrides the app default Claude key for your agent runs. Billing goes to your Anthropic account.',
    required: 'Starts with sk-ant-...',
  },
  perplexity: {
    label: 'Perplexity',
    note: 'Optional research override. Without this the research tool falls back to the app default or no-ops.',
    required: 'Starts with pplx-...',
  },
};

export function CredentialManager() {
  const router = useRouter();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/credentials')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setCredentials(data.credentials ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(provider: Provider) {
    if (!editValue.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, key: editValue.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = body.error;
        const msg =
          typeof err === 'string'
            ? err
            : err && typeof err === 'object'
              ? // Zod's flatten() shape: { formErrors, fieldErrors }
                JSON.stringify(err)
              : `save failed (HTTP ${res.status})`;
        setError(msg);
        return;
      }
      // Refresh the list so we see the new masked entry.
      const list = await fetch('/api/credentials').then((r) => r.json());
      setCredentials(list.credentials ?? []);
      setEditing(null);
      setEditValue('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(provider: Provider) {
    setBusy(true);
    setError(null);
    try {
      await fetch(`/api/credentials?provider=${provider}`, { method: 'DELETE' });
      setCredentials((c) => c.filter((x) => x.provider !== provider));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const providers: Provider[] = ['openai', 'anthropic', 'perplexity'];

  return (
    <section className="card flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">API keys</h2>
        <p className="mt-0.5 text-[11px] text-ink-400">
          Bring your own keys. Stored encrypted with AES-256-GCM; only the last
          four characters are ever shown back. The app never logs your key.
        </p>
      </div>
      {loading ? (
        <p className="text-xs text-ink-400">Loading…</p>
      ) : (
        <ul className="flex flex-col divide-y divide-ink-700/60">
          {providers.map((p) => {
            const existing = credentials.find((c) => c.provider === p);
            const meta = PROVIDER_META[p];
            const isEditing = editing === p;
            return (
              <li key={p} className="flex flex-col gap-1 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink-100">{meta.label}</p>
                    {existing ? (
                      <p className="text-ink-400">
                        Saved <span className="font-mono">{existing.maskedKey}</span>
                      </p>
                    ) : (
                      <p className="text-ink-400">No key saved.</p>
                    )}
                  </div>
                  {!isEditing && (
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(p);
                          setEditValue('');
                          setError(null);
                        }}
                        className="btn-ghost text-[11px]"
                      >
                        {existing ? 'Replace' : 'Add'}
                      </button>
                      {existing && (
                        <button
                          type="button"
                          onClick={() => remove(p)}
                          disabled={busy}
                          className="btn-ghost text-[11px] text-red-300"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {isEditing && (
                  <div className="flex flex-col gap-1.5 rounded-md border border-ink-700/60 bg-ink-900/60 p-2">
                    <p className="text-[10px] text-ink-400">{meta.note}</p>
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder={meta.required ?? 'Paste key…'}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="w-full font-mono text-[11px]"
                    />
                    {error && <p className="text-[11px] text-red-300">{error}</p>}
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => save(p)}
                        disabled={busy || !editValue.trim()}
                        className="btn-primary text-[11px]"
                      >
                        {busy ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(null);
                          setEditValue('');
                          setError(null);
                        }}
                        className="btn-ghost text-[11px]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {!isEditing && (
                  <p className="text-[10px] text-ink-500">{meta.note}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
