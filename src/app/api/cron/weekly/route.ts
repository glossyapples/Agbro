// Weekly brain update — agent writes a recap & post-mortems into the brain.
// Per-user fan-out: iterate active users; skip users with no activity.

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { BRAIN_WRITEUP_MODEL } from '@/lib/agents/models';
import { BRAIN_WRITER_SYSTEM } from '@/lib/agents/prompts';
import { apiError, assertCronSecret } from '@/lib/api';
import { log } from '@/lib/logger';
import { estimateCostUsd } from '@/lib/pricing';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Outcome =
  | { userId: string; skipped: true; reason: string }
  | { userId: string; ok: true; brainEntryId: string }
  | { userId: string; failed: true; reason: string };

export async function POST(req: Request) {
  const unauthorized = assertCronSecret(req);
  if (unauthorized) return unauthorized;

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      log.error('cron.weekly.missing_api_key', new Error('ANTHROPIC_API_KEY missing'));
      return NextResponse.json({ error: 'server misconfigured' }, { status: 500 });
    }
    const anthropic = new Anthropic({ apiKey });

    const users = await prisma.user.findMany({
      where: { account: { isStopped: false } },
      select: { id: true },
    });

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const outcomes: Outcome[] = [];

    for (const user of users) {
      const [trades, runs, closed, prevEntries] = await Promise.all([
        prisma.trade.findMany({
          where: { userId: user.id, submittedAt: { gte: since } },
          orderBy: { submittedAt: 'desc' },
          take: 500,
        }),
        prisma.agentRun.findMany({
          where: { userId: user.id, startedAt: { gte: since } },
          orderBy: { startedAt: 'desc' },
          take: 50,
        }),
        prisma.trade.findMany({
          where: { userId: user.id, closedAt: { gte: since } },
          orderBy: { closedAt: 'desc' },
          take: 200,
        }),
        prisma.brainEntry.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      ]);

      if (trades.length === 0 && closed.length === 0 && runs.length === 0) {
        outcomes.push({ userId: user.id, skipped: true, reason: 'no_activity' });
        continue;
      }

      const prompt = `Write the AgBro Weekly Update.

Trades this week (JSON):
${JSON.stringify(
  trades.map((t) => ({
    sym: t.symbol,
    side: t.side,
    qty: t.qty,
    status: t.status,
    conf: t.confidence,
    mos: t.marginOfSafetyPct,
    thesis: t.thesis.slice(0, 300),
  })),
  null,
  2
)}

Closed positions this week:
${JSON.stringify(
  closed.map((t) => ({
    sym: t.symbol,
    pnlCents: t.realizedPnlCents?.toString(),
    thesis: t.thesis.slice(0, 200),
  })),
  null,
  2
)}

Runs this week: ${runs.length}

Previous brain entries (most recent first, truncated):
${prevEntries.map((e) => `- [${e.kind}] ${e.title}: ${e.body.slice(0, 200)}`).join('\n')}

Write ONE weekly update (200-400 words) with sections:
  SCOREBOARD · WHAT WE LEARNED · OPEN QUESTIONS · NEXT WEEK

Then, if any positions were closed, write a brief POST-MORTEM paragraph per closed trade.
Return plain markdown. No preamble.`;

      try {
        const resp = await anthropic.messages.create({
          model: BRAIN_WRITEUP_MODEL,
          max_tokens: 2048,
          system: BRAIN_WRITER_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
        });

        const u = resp.usage as unknown as Record<string, number | undefined> | undefined;
        const costUsd = u
          ? estimateCostUsd(BRAIN_WRITEUP_MODEL, {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            })
          : 0;
        log.info('cron.weekly.user_ok', { userId: user.id, costUsd, model: BRAIN_WRITEUP_MODEL });

        const text = resp.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n');

        const entry = await prisma.brainEntry.create({
          data: {
            userId: user.id,
            kind: 'weekly_update',
            title: `Weekly update — ${new Date().toISOString().slice(0, 10)}`,
            body: text,
            tags: ['weekly'],
          },
        });

        await prisma.notification.create({
          data: {
            userId: user.id,
            kind: 'weekly_update',
            title: 'Weekly brain update ready',
            body: text.split('\n').slice(0, 3).join(' ').slice(0, 280),
          },
        });

        outcomes.push({ userId: user.id, ok: true, brainEntryId: entry.id });
      } catch (err) {
        log.error('cron.weekly.user_failed', err, { userId: user.id });
        outcomes.push({
          userId: user.id,
          failed: true,
          reason: (err as Error).message.slice(0, 200),
        });
      }
    }

    const failed = outcomes.filter((o) => 'failed' in o).length;
    const ok = outcomes.filter((o) => 'ok' in o).length;
    const skipped = outcomes.filter((o) => 'skipped' in o).length;

    return NextResponse.json(
      { total: outcomes.length, ok, skipped, failed, outcomes },
      { status: failed > 0 ? 207 : 200 }
    );
  } catch (err) {
    return apiError(err, 500, 'weekly cron failed', 'cron.weekly');
  }
}

export async function GET(req: Request) {
  return POST(req);
}
