// Meeting comic generator — two-step pipeline:
//   (1) Claude condenses the meeting transcript into a tight comic
//       screenplay (panel breakdown with dialogue + art direction)
//   (2) OpenAI's gpt-image-1 renders that screenplay as a single-page
//       comic strip.
//
// Step 1 uses the app's Anthropic key. Step 2 REQUIRES the user's
// OpenAI key (from UserApiCredential). If the user hasn't saved an
// OpenAI key, this function is never called — it's the opt-in signal.
//
// Cost: ~$0.04-0.05 per comic (Claude script + one gpt-image-1 @1024×1024).
// Billed to the user's OpenAI account, not the app's.

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import type { MeetingOutput } from './schema';

const SCRIPT_MODEL = 'claude-opus-4-7';

export async function generateMeetingComic(params: {
  meetingId: string;
  userId: string;
  openaiKey: string;
}): Promise<{ ok: boolean; imageUrl?: string; costUsd?: number }> {
  const { meetingId, userId, openaiKey } = params;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    log.warn('comic.skipped_no_anthropic_key', { meetingId });
    return { ok: false };
  }

  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
  if (!meeting || !meeting.transcriptJson) {
    log.warn('comic.skipped_no_transcript', { meetingId });
    return { ok: false };
  }
  const output = meeting.transcriptJson as unknown as MeetingOutput;

  // Step 1: Claude writes a comic script.
  let script: Awaited<ReturnType<typeof writeComicScript>>;
  try {
    script = await writeComicScript({ anthropicKey, meeting: output });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    log.error('comic.script_failed', err, { meetingId, userId });
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { comicError: `script step: ${msg.slice(0, 450)}` },
    });
    return { ok: false };
  }

  // Step 2: OpenAI renders the comic page.
  let imageUrl: string | null = null;
  let imageCostUsd = 0;
  try {
    const result = await renderComicImage({ openaiKey, script: script.prompt });
    imageUrl = result.imageUrl;
    imageCostUsd = result.costUsd;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    log.error('comic.image_failed', err, { meetingId, userId });
    // Persist the error + script so the UI can show WHY it failed
    // instead of a generic fallback. User sees 'OpenAI returned 401:
    // Invalid API key' or whatever the real cause is.
    await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        comicScriptJson: script as unknown as object,
        comicError: msg.slice(0, 500),
      },
    });
    return { ok: false };
  }

  const totalCostUsd = script.costUsd + imageCostUsd;
  await prisma.meeting.update({
    where: { id: meetingId },
    data: {
      comicUrl: imageUrl,
      comicScriptJson: script as unknown as object,
      comicCostUsd: totalCostUsd,
      comicError: null, // clear any prior error on successful retry
    },
  });

  log.info('comic.completed', {
    meetingId,
    userId,
    imageCostUsd,
    scriptCostUsd: script.costUsd,
    totalCostUsd,
  });
  return { ok: true, imageUrl: imageUrl ?? undefined, costUsd: totalCostUsd };
}

// ─── Step 1: screenplay ─────────────────────────────────────────────────

const SCRIPT_SYSTEM_PROMPT = `You are a comics writer turning agentic investment-firm meetings into single-page comic strips. Each meeting has a transcript of four characters arguing productively:
• Warren Buffbot — CEO, value investor, quiet and decisive
• the Analyst — research lead, fundamentals-focused
• the Risk Officer — conservative, worried about downside
• the Operations lead — data-driven, pragmatic

Write a crisp IMAGE GENERATION PROMPT describing a single-page comic with 4-6 panels summarising the meeting. The image generator is gpt-image-1; your prompt should be dense, visual, and specific. Include:
  - Overall art style (choose one per meeting that fits the mood): "vintage New Yorker cartoon", "1980s corporate comic strip", "modern minimalist line art", "noir graphic novel"
  - Panel breakdown: 4-6 panels on one page, each with staging + what the characters say (speech bubbles)
  - Visual mood matching the meeting sentiment (bullish=open/bright, cautious=restrained, defensive=darker, opportunistic=energetic)
  - Any specific numbers, symbols, or charts worth showing in a panel

Respond with a single JSON object:
{
  "title": "<5-8 word title for the comic>",
  "style": "<short art style description>",
  "mood": "<one-word mood>",
  "prompt": "<the full prompt for gpt-image-1, ~300-600 words, panel-by-panel>"
}

No prose outside the JSON. No markdown fences.`;

async function writeComicScript(params: {
  anthropicKey: string;
  meeting: MeetingOutput;
}): Promise<{ title: string; style: string; mood: string; prompt: string; costUsd: number }> {
  const client = new Anthropic({ apiKey: params.anthropicKey });
  const userMessage = JSON.stringify(
    {
      summary: params.meeting.summary,
      transcript: params.meeting.transcript,
      decisions: params.meeting.decisions,
      sentiment: params.meeting.sentiment,
    },
    null,
    2
  );
  const resp = await client.messages.create({
    model: SCRIPT_MODEL,
    max_tokens: 4_000,
    system: SCRIPT_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Meeting to turn into a comic:\n\n${userMessage}`,
      },
    ],
  });
  const rawText = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  let trimmed = rawText.trim();
  const fence = /```(?:json)?\s*([\s\S]+?)\s*```/i.exec(trimmed);
  if (fence) trimmed = fence[1].trim();
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace > 0) trimmed = trimmed.slice(firstBrace);
  const lastBrace = trimmed.lastIndexOf('}');
  if (lastBrace >= 0) trimmed = trimmed.slice(0, lastBrace + 1);
  const parsed = JSON.parse(trimmed) as {
    title: string;
    style: string;
    mood: string;
    prompt: string;
  };
  const costUsd =
    ((resp.usage?.input_tokens ?? 0) / 1_000_000) * 15 +
    ((resp.usage?.output_tokens ?? 0) / 1_000_000) * 75;
  return { ...parsed, costUsd };
}

// ─── Step 2: image render ───────────────────────────────────────────────
// Calls OpenAI's Images API with the user's key. Using gpt-image-1
// which handles text-in-image well — essential for speech bubbles.

const OPENAI_IMAGE_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const IMAGE_MODEL = 'gpt-image-1';
const IMAGE_SIZE: '1024x1024' | '1024x1536' | '1536x1024' = '1024x1536';

async function renderComicImage(params: {
  openaiKey: string;
  script: string;
}): Promise<{ imageUrl: string; costUsd: number }> {
  const res = await fetch(OPENAI_IMAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: params.script,
      n: 1,
      size: IMAGE_SIZE,
      // gpt-image-1 returns base64 by default unless response_format is
      // explicitly set. Ask for b64 so we don't depend on short-lived
      // URL hosting — we save the image ourselves.
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`openai image ${res.status}: ${body.slice(0, 400)}`);
  }
  const payload = (await res.json()) as {
    data: Array<{ b64_json?: string; url?: string }>;
    usage?: { total_tokens?: number };
  };
  const first = payload.data?.[0];
  if (!first) throw new Error('openai image returned no data');
  let imageUrl: string;
  if (first.b64_json) {
    // Inline the image as a data URL. Works for display; a future pass
    // should upload to S3/R2 so the Meeting row doesn't grow unbounded.
    imageUrl = `data:image/png;base64,${first.b64_json}`;
  } else if (first.url) {
    imageUrl = first.url;
  } else {
    throw new Error('openai image returned neither b64_json nor url');
  }
  // gpt-image-1 pricing varies by resolution — ~$0.04 for 1024×1536 at
  // standard quality (Apr 2026). Treat as a ballpark; replace with
  // usage-driven math when OpenAI surfaces it.
  const costUsd = 0.04;
  return { imageUrl, costUsd };
}
