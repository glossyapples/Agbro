// Weekly brain update — agent writes a recap & post-mortems into the brain.

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { BRAIN_WRITEUP_MODEL } from '@/lib/agents/models';
import { BRAIN_WRITER_SYSTEM } from '@/lib/agents/prompts';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  const secret = req.headers.get('x-agbro-cron-secret') ?? '';
  if (!process.env.AGBRO_CRON_SECRET || secret !== process.env.AGBRO_CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [trades, runs, closed, prevEntries] = await Promise.all([
    prisma.trade.findMany({ where: { submittedAt: { gte: since } }, orderBy: { submittedAt: 'desc' } }),
    prisma.agentRun.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: 'desc' }, take: 50 }),
    prisma.trade.findMany({ where: { closedAt: { gte: since } } }),
    prisma.brainEntry.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'no key' }, { status: 500 });
  const anthropic = new Anthropic({ apiKey });

  const prompt = `Write the AgBro Weekly Update.

Trades this week (JSON):
${JSON.stringify(trades.map(t => ({ sym: t.symbol, side: t.side, qty: t.qty, status: t.status, conf: t.confidence, mos: t.marginOfSafetyPct, thesis: t.thesis.slice(0,300) })), null, 2)}

Closed positions this week:
${JSON.stringify(closed.map(t => ({ sym: t.symbol, pnlCents: t.realizedPnlCents?.toString(), thesis: t.thesis.slice(0,200) })), null, 2)}

Runs this week: ${runs.length}

Previous brain entries (most recent first, truncated):
${prevEntries.map(e => `- [${e.kind}] ${e.title}: ${e.body.slice(0,200)}`).join('\n')}

Write ONE weekly update (200-400 words) with sections:
  SCOREBOARD · WHAT WE LEARNED · OPEN QUESTIONS · NEXT WEEK

Then, if any positions were closed, write a brief POST-MORTEM paragraph per closed trade.
Return plain markdown. No preamble.`;

  const resp = await anthropic.messages.create({
    model: BRAIN_WRITEUP_MODEL,
    max_tokens: 2048,
    system: BRAIN_WRITER_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const entry = await prisma.brainEntry.create({
    data: {
      kind: 'weekly_update',
      title: `Weekly update — ${new Date().toISOString().slice(0, 10)}`,
      body: text,
      tags: ['weekly'],
    },
  });

  // Notify user.
  const user = await prisma.user.findFirst();
  if (user) {
    await prisma.notification.create({
      data: {
        userId: user.id,
        kind: 'weekly_update',
        title: 'Weekly brain update ready',
        body: text.split('\n').slice(0, 3).join(' ').slice(0, 280),
      },
    });
  }

  return NextResponse.json({ ok: true, brainEntryId: entry.id });
}

export async function GET(req: Request) {
  return POST(req);
}
