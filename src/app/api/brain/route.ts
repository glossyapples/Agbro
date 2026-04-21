import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

const BRAIN_KINDS = [
  'principle',
  'checklist',
  'pitfall',
  'sector_primer',
  'case_study',
  'lesson',
  'market_memo',
  'post_mortem',
  'weekly_update',
  'agent_run_summary',
] as const;

const CreateBrainEntry = z.object({
  kind: z.enum(BRAIN_KINDS),
  title: z.string().min(1).max(240),
  body: z.string().min(1).max(20_000),
  tags: z.array(z.string().max(64)).max(20).optional(),
  relatedSymbols: z.array(z.string().max(16)).max(50).optional(),
});

export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const url = new URL(req.url);
    const kindParam = url.searchParams.get('kind');
    const kind = kindParam && (BRAIN_KINDS as readonly string[]).includes(kindParam)
      ? kindParam
      : undefined;
    const entries = await prisma.brainEntry.findMany({
      where: { userId: user.id, ...(kind ? { kind } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return NextResponse.json(entries);
  } catch (err) {
    return apiError(err, 500, 'failed to list brain entries', 'brain.get');
  }
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const parsed = CreateBrainEntry.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { kind, title, body, tags, relatedSymbols } = parsed.data;
    const entry = await prisma.brainEntry.create({
      data: {
        userId: user.id,
        kind,
        title,
        body,
        tags: tags ?? [],
        relatedSymbols: relatedSymbols ?? [],
      },
    });
    return NextResponse.json(entry);
  } catch (err) {
    return apiError(err, 500, 'failed to create brain entry', 'brain.post');
  }
}
