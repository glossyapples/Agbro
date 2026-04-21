import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

const CreateStrategy = z.object({
  name: z.string().min(1).max(120),
  summary: z.string().min(1).max(20_000),
  rules: z.record(z.unknown()),
  activate: z.boolean().optional(),
});

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const all = await prisma.strategy.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(all);
  } catch (err) {
    return apiError(err, 500, 'failed to list strategies', 'strategy.get');
  }
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const parsed = CreateStrategy.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;

    const existingActive = await prisma.strategy.findFirst({
      where: { userId: user.id, isActive: true },
    });

    const created = await prisma.strategy.create({
      data: {
        userId: user.id,
        name: body.name,
        summary: body.summary,
        rules: body.rules as Prisma.InputJsonValue,
        version: (existingActive?.version ?? 0) + 1,
        isActive: !!body.activate,
      },
    });

    if (body.activate && existingActive && existingActive.id !== created.id) {
      await prisma.strategy.update({
        where: { id: existingActive.id },
        data: { isActive: false },
      });
    }
    return NextResponse.json(created);
  } catch (err) {
    return apiError(err, 500, 'failed to create strategy', 'strategy.post');
  }
}
