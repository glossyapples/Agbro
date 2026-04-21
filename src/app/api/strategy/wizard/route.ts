// Collaborative strategy wizard. Streams? No — keep it simple for mobile:
// each turn is a round-trip POST. History stored in StrategyTurn.

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { BRAIN_WRITEUP_MODEL } from '@/lib/agents/models';
import { STRATEGY_WIZARD_SYSTEM } from '@/lib/agents/prompts';

export const runtime = 'nodejs';
export const maxDuration = 120;

const WizardBody = z.object({
  strategyId: z.string().min(1).max(64),
  message: z.string().min(1).max(8_000),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const parsed = WizardBody.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { strategyId, message } = parsed.data;

    const strategy = await prisma.strategy.findFirst({
      where: { id: strategyId, userId: user.id },
      include: { turns: { orderBy: { createdAt: 'asc' } } },
    });
    if (!strategy) return NextResponse.json({ error: 'strategy not found' }, { status: 404 });

    await prisma.strategyTurn.create({
      data: { strategyId, role: 'user', content: message },
    });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('strategy.wizard: ANTHROPIC_API_KEY missing');
      return NextResponse.json({ error: 'server misconfigured' }, { status: 500 });
    }
    const anthropic = new Anthropic({ apiKey });

    const history = [
      ...strategy.turns.map((t) => ({
        role: (t.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: t.content,
      })),
      { role: 'user' as const, content: message },
    ];

    const context =
      `Current strategy "${strategy.name}" (v${strategy.version}):\n` +
      strategy.summary +
      `\n\nRules:\n${JSON.stringify(strategy.rules, null, 2)}`;

    const resp = await anthropic.messages.create({
      model: BRAIN_WRITEUP_MODEL,
      max_tokens: 2048,
      system: STRATEGY_WIZARD_SYSTEM + '\n\n' + context,
      messages: history,
    });

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const turn = await prisma.strategyTurn.create({
      data: { strategyId, role: 'agent', content: text },
    });

    return NextResponse.json({ reply: text, turnId: turn.id });
  } catch (err) {
    return apiError(err, 500, 'wizard turn failed', 'strategy.wizard');
  }
}
