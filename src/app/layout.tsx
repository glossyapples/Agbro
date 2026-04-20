import type { Metadata, Viewport } from 'next';
import './globals.css';
import { BottomNav } from '@/components/BottomNav';
import { DisclaimerBar } from '@/components/DisclaimerBar';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink-900 text-ink-100 antialiased">
        <div className="mx-auto flex min-h-dvh max-w-screen-sm flex-col">
          <DisclaimerBar />
          <main className="flex-1 pb-24">{children}</main>
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
