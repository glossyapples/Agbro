import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { BRAIN_KIND_TAXONOMY, BRAIN_KIND_VALUES } from '@/lib/brain/taxonomy';

export const runtime = 'nodejs';

// Single source of truth — BRAIN_KIND_VALUES is derived from the
// taxonomy map's keys, so adding a new kind there automatically keeps
// this route + read_brain tool + UI labels in sync.
const BRAIN_KINDS = BRAIN_KIND_VALUES;

const CreateBrainEntry = z.object({
  kind: z.enum(BRAIN_KINDS as [string, ...string[]]),
  title: z.string().min(1).max(240),
  body: z.string().min(1).max(20_000),
  tags: z.array(z.string().max(64)).max(20).optional(),
  relatedSymbols: z.array(z.string().max(16)).max(50).optional(),
  category: z
    .enum(['principle', 'playbook', 'reference', 'memory', 'hypothesis', 'note'])
    .optional(),
  confidence: z.enum(['canonical', 'high', 'medium', 'low']).optional(),
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
    // If the user supplied category/confidence explicitly, trust them.
    // Otherwise derive from the kind's canonical mapping so the row
    // lands in the correct bucket without forcing the client to know
    // the taxonomy.
    const fallback = BRAIN_KIND_TAXONOMY[kind] ?? {
      category: 'note' as const,
      confidence: 'medium' as const,
    };
    const category = parsed.data.category ?? fallback.category;
    const confidence = parsed.data.confidence ?? fallback.confidence;
    const entry = await prisma.brainEntry.create({
      data: {
        userId: user.id,
        kind,
        category,
        confidence,
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
