// POST /api/strategy/[id]/ask-burrybot — single turn of the Ask
// Burrybot chat. Client holds the message history and resends it each
// turn; server is stateless.
//
// Gate: Burrybot must be enabled on the strategy (guest mode or Burry
// firm). Rate-limited to prevent accidental 100-turn loops.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';
import { askBurrybot, type ChatMessage } from '@/lib/brain/burry-chat';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(10_000),
      })
    )
    .min(1)
    .max(40),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  // LLM-specific bucket — 30 turns/hour caps a held-down Send key at
  // meaningful spend while leaving room for real multi-turn chat.
  const gate = await checkLimit(user.id, 'burry.chat');
  if (!gate.success) return rateLimited(gate);

  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const strategy = await prisma.strategy.findFirst({
      where: { id: params.id, userId: user.id },
      select: { id: true, name: true, allowBurryGuest: true },
    });
    if (!strategy) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const isBurryFirm = strategy.name.toLowerCase().includes('burry');
    if (!isBurryFirm && !strategy.allowBurryGuest) {
      return NextResponse.json(
        {
          error:
            'Burrybot is not enabled on this strategy. Toggle him on first.',
        },
        { status: 400 }
      );
    }
    const reply = await askBurrybot({
      userId: user.id,
      strategyId: strategy.id,
      history: parsed.data.messages as ChatMessage[],
    });
    return NextResponse.json(reply);
  } catch (err) {
    return apiError(err, 500, 'chat failed', 'strategy.ask_burrybot');
  }
}
