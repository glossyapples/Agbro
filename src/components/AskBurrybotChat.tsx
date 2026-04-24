'use client';

// Inline "Ask Burrybot →" panel on strategy cards. Click to expand;
// click again (or "Close") to collapse. Messages live in client state
// — server is stateless, so a refresh clears the conversation. Each
// turn is a single Opus call with the full history.

import { useState, useRef, useEffect } from 'react';

type Msg = { role: 'user' | 'assistant'; content: string };

export function AskBurrybotChat({
  strategyId,
  strategyName,
}: {
  strategyId: string;
  strategyName: string;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalCost, setTotalCost] = useState(0);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // block:'nearest' stays inside the scroll container (see the
    // overflow-y-auto wrapper below) instead of bubbling to the page.
    // Without this + the wrapper, every message sent or received
    // yanked the page's scroll position.
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, open]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/strategy/${strategyId}/ask-burrybot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        text?: string;
        costUsd?: number;
        error?: string;
      };
      if (!res.ok || !body.text) {
        setError(
          typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
        );
        return;
      }
      setMessages((prev) => [...prev, { role: 'assistant', content: body.text! }]);
      if (typeof body.costUsd === 'number') setTotalCost((c) => c + body.costUsd!);
    } catch (e) {
      setError(`Network error: ${(e as Error).message.slice(0, 120)}`);
    } finally {
      setBusy(false);
    }
  }

  function clearChat() {
    setMessages([]);
    setError(null);
    setTotalCost(0);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-ghost mt-2 self-start text-[11px]"
      >
        → Ask Burrybot
      </button>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-ink-700/60 bg-ink-900/40 p-3 text-[12px]">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-brand-200">
          Ask Burrybot about {strategyName}
        </p>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearChat}
              className="text-[10px] text-ink-400 hover:text-red-300"
            >
              clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-[10px] text-ink-400 hover:text-ink-200"
          >
            close
          </button>
        </div>
      </div>

      {messages.length === 0 ? (
        <p className="rounded border border-ink-700/50 bg-ink-900/60 p-2 text-[11px] text-ink-400">
          Ask him specific things grounded in filings or macro — e.g. &ldquo;what
          do you think about water infrastructure stocks?&rdquo; or &ldquo;any
          hidden assets on KMI&apos;s balance sheet worth the read?&rdquo;.
          He&apos;s context-loaded on this firm&apos;s rules, positions, and his
          own doctrine.
        </p>
      ) : (
        // Fixed-height scroll container — without this, the
        // scrollIntoView below reaches up to the document and pulls
        // the entire page down every time a message lands, losing the
        // user's scroll position. The inner `<ul>` owns the scrollbar,
        // so scrollIntoView only moves this container's scrollTop.
        <div
          className="max-h-[60vh] overflow-y-auto rounded-md border border-ink-700/40 bg-ink-950/40 p-1"
          // Prevent the parent page from scrolling when the inner list
          // bottoms out or tops out — iOS Safari scroll-chains by
          // default; overscroll-contain keeps the momentum local.
          style={{ overscrollBehavior: 'contain' }}
        >
          <ul className="flex flex-col gap-2">
            {messages.map((m, i) => (
              <li
                key={i}
                className={`rounded-md p-2 text-[11px] leading-relaxed ${
                  m.role === 'user'
                    ? 'border border-brand-500/30 bg-brand-500/10 text-ink-100'
                    : 'border border-ink-700/50 bg-ink-900/60 text-ink-200'
                }`}
              >
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-ink-500">
                  {m.role === 'user' ? 'You' : 'Burrybot'}
                </p>
                <pre className="whitespace-pre-wrap break-words font-sans">{m.content}</pre>
              </li>
            ))}
            <div ref={endRef} />
          </ul>
        </div>
      )}

      {error && (
        <p className="rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask him something…"
          disabled={busy}
          className="flex-1 text-[12px]"
        />
        <button
          type="button"
          onClick={send}
          disabled={busy || input.trim().length === 0}
          className="btn-primary text-[10px]"
        >
          {busy ? 'Reading…' : 'Send'}
        </button>
      </div>

      {totalCost > 0 && (
        <p className="text-[10px] text-ink-500">
          This conversation: ${totalCost.toFixed(3)} on your Anthropic key.
        </p>
      )}
    </div>
  );
}
