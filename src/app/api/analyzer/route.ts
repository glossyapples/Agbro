import { NextResponse } from 'next/server';
import { z } from 'zod';
import { analyze } from '@/lib/analyzer';
import { apiError, requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';

export const runtime = 'nodejs';

const AnalyzerBody = z.object({
  symbol: z.string().min(1).max(12),
  price: z.number().finite(),
  eps: z.number().finite(),
  epsGrowthPct: z.number().finite(),
  bookValuePerShare: z.number().finite(),
  dividendPerShare: z.number().finite(),
  fcfPerShare: z.number().finite(),
  sharesOutstanding: z.number().finite().positive(),
  totalDebt: z.number().finite(),
  totalEquity: z.number().finite(),
  returnOnEquityPct: z.number().finite(),
  grossMarginPct: z.number().finite(),
  sector: z.string().max(64).optional(),
  aaaBondYieldPct: z.number().finite().optional(),
  discountRatePct: z.number().finite().optional(),
  terminalGrowthPct: z.number().finite().optional(),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const gate = await checkLimit(user.id, 'analyzer');
  if (!gate.success) return rateLimited(gate);

  try {
    const parsed = AnalyzerBody.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    return NextResponse.json(analyze(parsed.data));
  } catch (err) {
    return apiError(err, 500, 'analyzer failed', 'analyzer.post');
  }
}
