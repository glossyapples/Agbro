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
import { CAST, castSheet } from './cast';

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
    const result = await renderComicImage({
      openaiKey,
      script: script.prompt,
      userId,
    });
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
//
// The comic dramatises ONE turning-point scene from the meeting —
// usually a disagreement that resolved or a decision that flipped —
// with real dialogue pulled from the transcript. Every character is
// drawn to a fixed cast sheet so they look like the same characters
// across weeks. Speech bubbles use each character's name so the user
// can follow who's speaking even if the render is rough.

const SCRIPT_SYSTEM_PROMPT = `You are a comics writer turning executive meetings at AgBro (an agentic investment firm) into single-page dialogue-driven comic strips.

${castSheet()}

The comic must focus on the ONE turning-point scene the meeting has already identified (in \`comicFocus\`) — a beat with real emotional stakes where a decision flipped or a disagreement was settled. NOT a generic summary of the whole meeting.

Write a crisp IMAGE GENERATION PROMPT for gpt-image-1. Rules:

1. USE EACH CHARACTER'S FIXED VISUAL DESCRIPTION VERBATIM from the cast above — same chassis color, same props, same silhouette every meeting. This is how users recognise them.

2. EXPLICITLY NAME each character in every panel they appear in (e.g. "Panel 2: Warren Buffbot pauses…" — not "a robot thinks"). The image model needs the name so speech bubbles can be labelled.

3. Build a 4-6 panel narrative arc:
   - Panel 1: setup — who's in the room, what's on the table (show the specific symbol / number / decision)
   - Middle panels: the disagreement plays out as dialogue. Pull short quotes from the actual meeting transcript; don't invent new lines that contradict the transcript.
   - Final panel: the resolution + the real-world consequence (referencing the actual action item or decision the meeting made)

4. DIALOGUE goes in speech bubbles, prefixed with the character's name (e.g. \`Warren Buffbot: "Shouldn't we consider buying this? They've got a moat."\`). Keep each bubble under ~15 words — the image model cramps when bubbles get long.

5. Art style is consistent within the comic: pick ONE from "vintage New Yorker cartoon", "1980s corporate comic strip", "modern minimalist line art with flat colour", "noir graphic novel", or "warm Sunday funnies" — matching the meeting's sentiment.

6. Overall mood visuals:
   - bullish       → open framing, brighter palette
   - cautious      → restrained, warm but muted
   - defensive     → tighter framing, darker palette, cool tones
   - opportunistic → energetic angles, pops of colour

7. Show specific numbers / tickers / ratios that were discussed — they should appear on whiteboards, HUDs, or captions in the background. Real stakes make the comic feel like the real firm.

Respond with a single JSON object:
{
  "title": "<5-8 word title for the comic>",
  "style": "<short art style description>",
  "mood": "<one-word mood>",
  "prompt": "<the full image-gen prompt, ~400-700 words, panel-by-panel, naming every character in every panel they appear in>"
}

No prose outside the JSON. No markdown fences.`;

async function writeComicScript(params: {
  anthropicKey: string;
  meeting: MeetingOutput;
}): Promise<{ title: string; style: string; mood: string; prompt: string; costUsd: number }> {
  const client = new Anthropic({ apiKey: params.anthropicKey });
  // Feed only the parts the comic writer needs. comicFocus is the star —
  // everything else is supporting context for pulling quotes.
  const userMessage = JSON.stringify(
    {
      sentiment: params.meeting.sentiment,
      comicFocus: params.meeting.comicFocus,
      summary: params.meeting.summary,
      transcript: params.meeting.transcript,
      decisions: params.meeting.decisions,
      // Only include names — the model doesn't need full item text,
      // just enough to reference "the ORCL research item" in a caption.
      actionItemsDigest: [
        ...(params.meeting.actionItems ?? []).map(
          (a) => `NEW ${a.kind}: ${a.description}`
        ),
        ...(params.meeting.actionItemUpdates ?? []).map(
          (u) => `UPDATE ${u.status}${u.note ? ' — ' + u.note : ''}`
        ),
      ],
      cast: Object.values(CAST).map((c) => ({
        role: c.role,
        name: c.name,
        personality: c.personality,
      })),
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
        content: `Meeting to turn into a comic. Dramatise the comicFocus scene with real dialogue from the transcript.\n\n${userMessage}`,
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
  userId?: string;
}): Promise<{ imageUrl: string; costUsd: number }> {
  // gpt-image-1 request spec (verified against OpenAI docs, Apr 2026):
  //   model, prompt (required), n, size, quality, output_format,
  //   output_compression (jpeg/webp only), background, moderation, user.
  //   response_format is NOT accepted — the model always returns b64_json.
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
      // 'medium' is the right balance for a comic page — 'high' is
      // slower + more expensive without a huge readability win on
      // a 1024×1536 page; 'low' is too muddy for speech bubble text.
      quality: 'medium' as const,
      output_format: 'png' as const,
      // Opaque background looks better for a comic page frame than
      // transparent; 'auto' can surprise with a see-through result.
      background: 'opaque' as const,
      // Passed through for OpenAI's abuse detection — scoped per user
      // so one user's issue doesn't rate-limit everyone.
      ...(params.userId ? { user: params.userId } : {}),
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
  // gpt-image-1 token-based pricing (Apr 2026). At quality=medium,
  // size=1024×1536, a single page lands around $0.06. Treat as a
  // ballpark — real billing is per-token on input + output via
  // OpenAI's usage endpoint. Replace with usage.output_tokens math
  // once the response includes it reliably.
  const costUsd = 0.06;
  return { imageUrl, costUsd };
}
