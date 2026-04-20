'use client';

import { useEffect, useState } from 'react';

export function DisclaimerBar() {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(localStorage.getItem('agbro.disclaimer.v1') === '1');
  }, []);
  if (dismissed) return null;
  return (
    <div className="sticky top-0 z-30 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] leading-tight text-amber-200">
      <div className="flex items-start gap-2">
        <span>⚠</span>
        <p className="flex-1">
          <strong>AgBro is experimental.</strong> Not financial advice. Don't put money here you
          aren't willing to lose — think casino-night budget, not rent. Past performance doesn't
          predict future results. Read the full disclaimer in Settings → Disclaimer.
        </p>
        <button
          onClick={() => {
            localStorage.setItem('agbro.disclaimer.v1', '1');
            setDismissed(true);
          }}
          className="shrink-0 rounded-md bg-amber-500/30 px-2 py-0.5 text-amber-100"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
