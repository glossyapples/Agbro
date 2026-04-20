'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS: Array<{ href: string; label: string; icon: string }> = [
  { href: '/', label: 'Home', icon: '●' },
  { href: '/trades', label: 'Trades', icon: '⇄' },
  { href: '/strategy', label: 'Strategy', icon: '◈' },
  { href: '/brain', label: 'Brain', icon: '✦' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-screen-sm border-t border-ink-700/80 bg-ink-900/90 backdrop-blur">
      <ul className="grid grid-cols-5">
        {TABS.map((t) => {
          const active = t.href === '/' ? pathname === '/' : pathname.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                className={`flex flex-col items-center gap-0.5 py-3 text-[11px] font-medium ${
                  active ? 'text-brand-400' : 'text-ink-400'
                }`}
              >
                <span className="text-base leading-none">{t.icon}</span>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
