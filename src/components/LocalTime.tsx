'use client';

// Server-side timestamp rendering uses the Node process's locale/timezone
// (on Railway: UTC). That produces times 7-8 hours off for a Pacific user,
// which is confusing and also hides real scheduling issues — you can't
// easily tell "did the agent wake on time?" when the displayed time isn't
// your clock.
//
// This tiny client component takes an ISO string (or epoch ms) and formats
// it in the user's browser timezone. Server renders a placeholder, the
// browser hydrates with the correct local string. SSR-safe: if JS is
// disabled for any reason the placeholder still reads reasonably (ISO in
// UTC).

import { useEffect, useState } from 'react';

type Format = 'datetime' | 'date' | 'time' | 'relative';

export function LocalTime({
  value,
  format = 'datetime',
  className,
}: {
  value: string | number | Date | null | undefined;
  format?: Format;
  className?: string;
}) {
  // The only honest way to render a local time is after hydration — the
  // server has no business guessing what timezone the user is in. Store
  // the formatted string in state; it'll be undefined on first render.
  const [rendered, setRendered] = useState<string | null>(null);

  useEffect(() => {
    if (value == null) {
      setRendered(null);
      return;
    }
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) {
      setRendered('—');
      return;
    }
    switch (format) {
      case 'date':
        setRendered(d.toLocaleDateString());
        break;
      case 'time':
        setRendered(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        break;
      case 'relative':
        setRendered(formatRelative(d));
        break;
      case 'datetime':
      default:
        setRendered(
          d.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        );
    }
  }, [value, format]);

  if (value == null) return <span className={className}>—</span>;
  // Pre-hydration placeholder: ISO without the milliseconds. Better than
  // either a flash or a fake locale-formatted string that the client then
  // replaces (causing hydration mismatch warnings).
  const iso = value instanceof Date ? value.toISOString() : String(value);
  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {rendered ?? iso.slice(0, 16).replace('T', ' ')}
    </time>
  );
}

function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const abs = Math.abs(diffMs);
  const past = diffMs >= 0;
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return past ? `${mins}m ago` : `in ${mins}m`;
  if (hours < 24) return past ? `${hours}h ago` : `in ${hours}h`;
  if (days < 30) return past ? `${days}d ago` : `in ${days}d`;
  return d.toLocaleDateString();
}
