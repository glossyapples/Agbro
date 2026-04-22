// GET /api/crypto/performance?range=1W|1M|3M|YTD|1Y|ALL
//
// Crypto-book equity series from our own CryptoBookSnapshot rows, plus a
// BTC benchmark overlay (% return from range start, same y-axis as the
// book series so the two are comparable at a glance).
//
// Note: unlike the stocks /api/performance route, we don't use Alpaca's
// portfolio_history because that's total-account (stocks + options + crypto
// combined). The snapshot table is our own series and fills in over time.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getCryptoBars } from '@/lib/alpaca-crypto';
import { apiError, requireUser } from '@/lib/api';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;

const Query = z.object({
  range: z.enum(['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL']).default('1M'),
});

function rangeStart(range: string, now: Date): Date {
  const d = new Date(now);
  switch (range) {
    case '1D':
      d.setDate(d.getDate() - 1);
      break;
    case '1W':
      d.setDate(d.getDate() - 7);
      break;
    case '1M':
      d.setMonth(d.getMonth() - 1);
      break;
    case '3M':
      d.setMonth(d.getMonth() - 3);
      break;
    case 'YTD':
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    case '1Y':
      d.setFullYear(d.getFullYear() - 1);
      break;
    case 'ALL':
    default:
      return new Date(0);
  }
  return d;
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const parsed = Query.safeParse({ range: url.searchParams.get('range') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const range = parsed.data.range;

  try {
    const start = rangeStart(range, new Date());
    const snapshots = await prisma.cryptoBookSnapshot.findMany({
      where: { userId: user.id, takenAt: { gte: start } },
      orderBy: { takenAt: 'asc' },
      select: { takenAt: true, bookValueCents: true },
    });

    const basisValue = snapshots[0] ? Number(snapshots[0].bookValueCents) / 100 : null;
    const bookSeries = snapshots.map((s) => {
      const v = Number(s.bookValueCents) / 100;
      return {
        t: s.takenAt.getTime(),
        v,
        pct: basisValue && basisValue > 0 ? ((v - basisValue) / basisValue) * 100 : 0,
      };
    });

    // BTC benchmark. Pull daily closes across the range; UI anchors to the
    // first bar (0%) and draws the line from there. Shares the y-axis with
    // the book series so they're directly comparable.
    let btcSeries: Array<{ t: number; pct: number }> = [];
    if (bookSeries.length >= 2) {
      const startMs = bookSeries[0].t;
      const endMs = bookSeries[bookSeries.length - 1].t;
      // Hourly bars on 1D / 1W for smoother intraday curves; daily beyond.
      const tf = range === '1D' || range === '1W' ? '1Hour' : '1Day';
      const bars = await getCryptoBars('BTC/USD', tf, startMs, endMs).catch((err) => {
        log.warn('crypto.performance_btc_bars_failed', { range }, err);
        return [];
      });
      const btcBasis = bars[0]?.close ?? null;
      btcSeries = bars.map((b) => ({
        t: b.timestampMs,
        pct: btcBasis && btcBasis > 0 ? ((b.close - btcBasis) / btcBasis) * 100 : 0,
      }));
    }

    const last = bookSeries[bookSeries.length - 1];
    const summary = last && basisValue != null
      ? {
          currentBookValue: last.v,
          rangePnl: last.v - basisValue,
          rangePnlPct: basisValue > 0 ? ((last.v - basisValue) / basisValue) * 100 : 0,
        }
      : null;

    return NextResponse.json({ range, summary, book: bookSeries, btc: btcSeries });
  } catch (err) {
    log.error('crypto.performance_failed', err);
    return apiError(err, 500, 'crypto performance fetch failed', 'crypto.performance');
  }
}
