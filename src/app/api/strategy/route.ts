import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET() {
  const user = await getCurrentUser();
  const all = await prisma.strategy.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json(all);
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    name: string;
    summary: string;
    rules: unknown;
    activate?: boolean;
  };
  const user = await getCurrentUser();
  const existingActive = await prisma.strategy.findFirst({
    where: { userId: user.id, isActive: true },
  });

  const created = await prisma.strategy.create({
    data: {
      userId: user.id,
      name: body.name,
      summary: body.summary,
      rules: body.rules as object,
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
}
