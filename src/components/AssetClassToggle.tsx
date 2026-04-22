'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Top-of-app pill showing which asset class the user is viewing. Crypto
// lives under /crypto/* and inherits the same shell (auth, account, nav)
// but runs on a completely different engine (rule-based, not LLM).
//
// Hidden on login/root marketing pages via layout's signedIn check.
export function AssetClassToggle() {
  const pathname = usePathname();
  const onCrypto = pathname.startsWith('/crypto');
  return (
    <div className="sticky top-0 z-10 border-b border-ink-700/60 bg-ink-900/80 backdrop-blur">
      <div className="mx-auto flex max-w-screen-sm items-center justify-center gap-1 p-2">
        <Link
          href="/"
          className={`flex-1 rounded-md px-3 py-1.5 text-center text-xs font-semibold transition ${
            !onCrypto ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'
          }`}
        >
          Stocks
        </Link>
        <Link
          href="/crypto"
          className={`flex-1 rounded-md px-3 py-1.5 text-center text-xs font-semibold transition ${
            onCrypto ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'
          }`}
        >
          Crypto
        </Link>
      </div>
    </div>
  );
}
