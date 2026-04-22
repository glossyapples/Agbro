// Crypto config CRUD. POST creates or updates the user's single CryptoConfig
// row. The UI pushes the whole config every Save — not partial patches — to
// keep the client/server contract boring.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

const CRYPTO_SYMBOL_RE = /^[A-Z]{2,6}\/USD$/;

const Body = z.object({
  allowlist: z
    .array(z.string().regex(CRYPTO_SYMBOL_RE, 'use Alpaca format like BTC/USD'))
    .max(12),
  targetAllocations: z
    .record(z.string().regex(CRYPTO_SYMBOL_RE), z.number().min(0).max(100))
    .refine(
      (v) => Object.values(v).reduce((s, n) => s + n, 0) <= 100.0001,
      { message: 'target allocations must sum to ≤ 100%' }
    ),
  dcaAmountUsd: z.number().min(0).max(10_000),
  dcaCadenceDays: z.number().int().min(1).max(90),
  rebalanceBandPct: z.number().min(1).max(50).optional(),
  rebalanceCadenceDays: z.number().int().min(7).max(365).optional(),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const p = parsed.data;

    // Ensure every target key is in the allowlist — otherwise the engine
    // would silently drop them and the user would be confused why their
    // allocation isn't being honoured.
    const allowSet = new Set(p.allowlist);
    for (const key of Object.keys(p.targetAllocations)) {
      if (!allowSet.has(key)) {
        return NextResponse.json(
          { error: `target key "${key}" is not in the allowlist` },
          { status: 400 }
        );
      }
    }

    await prisma.cryptoConfig.upsert({
      where: { userId: user.id },
      update: {
        allowlist: p.allowlist,
        targetAllocations: p.targetAllocations,
        dcaAmountCents: BigInt(Math.round(p.dcaAmountUsd * 100)),
        dcaCadenceDays: p.dcaCadenceDays,
        ...(p.rebalanceBandPct != null ? { rebalanceBandPct: p.rebalanceBandPct } : {}),
        ...(p.rebalanceCadenceDays != null
          ? { rebalanceCadenceDays: p.rebalanceCadenceDays }
          : {}),
      },
      create: {
        userId: user.id,
        allowlist: p.allowlist,
        targetAllocations: p.targetAllocations,
        dcaAmountCents: BigInt(Math.round(p.dcaAmountUsd * 100)),
        dcaCadenceDays: p.dcaCadenceDays,
        rebalanceBandPct: p.rebalanceBandPct ?? 10,
        rebalanceCadenceDays: p.rebalanceCadenceDays ?? 90,
      },
    });
    revalidatePath('/crypto');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err, 500, 'crypto config update failed', 'crypto.config');
  }
}
