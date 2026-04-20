import { NextResponse } from 'next/server';
import { analyze, type AnalyzerInput } from '@/lib/analyzer';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const input = (await req.json()) as AnalyzerInput;
  return NextResponse.json(analyze(input));
}
