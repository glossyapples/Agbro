import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind');
  const entries = await prisma.brainEntry.findMany({
    where: kind ? { kind } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return NextResponse.json(entries);
}

export async function POST(req: Request) {
  const { kind, title, body, tags, relatedSymbols } = (await req.json()) as {
    kind: string;
    title: string;
    body: string;
    tags?: string[];
    relatedSymbols?: string[];
  };
  const entry = await prisma.brainEntry.create({
    data: { kind, title, body, tags: tags ?? [], relatedSymbols: relatedSymbols ?? [] },
  });
  return NextResponse.json(entry);
}
