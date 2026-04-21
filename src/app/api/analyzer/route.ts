import { NextResponse } from 'next/server';
import { analyze, type AnalyzerInput } from '@/lib/analyzer';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const input = (await req.json()) as AnalyzerInput;
    return NextResponse.json(analyze(input));
  } catch (err) {
    return apiError(err, 500, 'analyzer failed', 'analyzer.post');
  }
}
