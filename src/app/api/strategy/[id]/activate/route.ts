import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const target = await prisma.strategy.findFirst({
      where: { id: params.id, userId: user.id },
    });
    if (!target) return NextResponse.json({ error: 'not found' }, { status: 404 });

    await prisma.$transaction([
      prisma.strategy.updateMany({
        where: { userId: user.id, isActive: true },
        data: { isActive: false },
      }),
      prisma.strategy.update({ where: { id: target.id }, data: { isActive: true } }),
    ]);

    return NextResponse.redirect(new URL('/strategy', _req.url));
  } catch (err) {
    return apiError(err, 500, 'failed to activate strategy', 'strategy.activate');
  }
}
