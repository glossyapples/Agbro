import type { Metadata, Viewport } from 'next';
import './globals.css';
import { BottomNav } from '@/components/BottomNav';
import { DisclaimerBar } from '@/components/DisclaimerBar';
import { AssetClassToggle } from '@/components/AssetClassToggle';
import { maybeCurrentUser } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'AgBro — Warren Buffbot',
  description: 'Agentic brokerage. Preserve principal. Grow patiently.',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#10131c',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Hide chrome (disclaimer bar + bottom nav) when not signed in so /login
  // doesn't show nav links that just bounce back to /login.
  const signedIn = (await maybeCurrentUser()) != null;
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink-900 text-ink-100 antialiased">
        <div className="mx-auto flex min-h-dvh max-w-screen-sm flex-col">
          {signedIn && <DisclaimerBar />}
          {signedIn && <AssetClassToggle />}
          <main className={`flex-1 ${signedIn ? 'pb-24' : ''}`}>{children}</main>
          {signedIn && <BottomNav />}
        </div>
      </body>
    </html>
  );
}
