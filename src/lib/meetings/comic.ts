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
import { castForStrategyKey, castSheet, type CastBundle } from './cast';

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
  // Resolve the cast from the meeting's snapshot if present (new
  // meetings), else infer from the strategy key. Legacy meetings
  // without either fall back to the default cast.
  const cast = output.cast
    ? ({
        strategyKey: output.cast.strategyKey,
        styleNote: '',
        // Reconstruct from the snapshot — styleNote is regenerated
        // from the live cast definition below if we can infer the key.
        characters: Object.fromEntries(
          Object.entries(output.cast.characters).map(([role, c]) => [
            role,
            { role, ...c },
          ])
        ),
      } as unknown as CastBundle)
    : castForStrategyKey(null);
  // If the snapshot only had the bare minimum, backfill the styleNote
  // from the live definition by strategy key.
  const live = castForStrategyKey(
    (output.cast?.strategyKey as Parameters<typeof castForStrategyKey>[0]) ?? null
  );
  if (!cast.styleNote) cast.styleNote = live.styleNote;

  // Step 1: Claude writes a comic script.
  let script: Awaited<ReturnType<typeof writeComicScript>>;
  try {
    script = await writeComicScript({ anthropicKey, meeting: output, cast });
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

// System prompt for the comic-script writer. Dynamic — per-meeting
// cast is injected via buildScriptSystemPrompt() below so each
// strategy gets its own principals.

function buildScriptSystemPrompt(cast: CastBundle): string {
  return `You are a comics writer turning executive meetings at an agentic investment firm into single-page, dialogue-driven editorial comic strips.

STYLE — non-negotiable:
• Mad Magazine / CRACKED editorial-caricature tradition. Exaggerated features, bold ink linework, fine crosshatch shading.
• Graphic novel consistency: clean panel grid, clear gutters, readable speech bubbles with the speaker's name prefixed.
• Limited, cohesive palette per comic — 3-5 colours max, chosen for mood.
• NEVER photoreal. NEVER cartoony/Saturday-morning-kids style either. The register is "smart satirical weekly" — think a 2024 New Yorker long-form graphic feature, or a CRACKED editorial 2-page spread.
• Every character is clearly a satirical \`-bot\` variant — their names are botified for this reason. Do not mistake them for real people; visuals are exaggerated editorial caricature, dialogue is fictional extrapolation of publicly known investment philosophy.

${castSheet(cast)}

The comic must focus on the ONE turning-point scene the meeting has already identified (in \`comicFocus\`) — a beat with real emotional stakes where a decision flipped or a disagreement was settled. NOT a generic summary of the whole meeting. Real consequences should show up in the last panel (the action item, the decision, the policy change).

Write the IMAGE GENERATION PROMPT for gpt-image-2. Rules:

1. USE THE FIXED CAST VISUAL DESCRIPTIONS VERBATIM — the exact features, clothes, props, name badges listed above. Characters must be recognisable across meetings.

2. Name each character explicitly in every panel they appear in so the model draws them correctly and labels speech bubbles with the right name.

3. 4-6 panels on one page, story arc:
   - Panel 1: SETUP — who's in the room, what's on the table (show the specific symbol / number / decision in the background)
   - Middle panels: the DISAGREEMENT plays out as dialogue. Pull short quotes from the actual meeting transcript; don't invent contradicting lines.
   - Final panel: RESOLUTION — the outcome, with the specific action item or decision visible (e.g. on a whiteboard, sticky note, or caption).

4. DIALOGUE goes in speech bubbles, each prefixed with the character's exact name (e.g. \`Buff-bot: "Shouldn't we consider buying this? They've got a moat."\`). Each bubble under ~15 words; longer bubbles cramp the render.

5. MOOD visuals (pick cues matching the meeting's sentiment):
   - bullish       → open framing, warmer light, palette leans gold/amber
   - cautious      → restrained composition, muted warm tones
   - defensive     → tighter framing, darker palette, cool shadows
   - opportunistic → energetic diagonals, a single pop of saturated colour

6. Show SPECIFIC numbers / tickers / ratios from the meeting — on whiteboards, charts, sticky notes. The stakes should feel like the actual firm's actual week.

GOAL — the comic must (in priority order):
  #1 ACCURATE to the meeting's decisions and transcript
  #2 highlight at least one specific action item or decision on-page
  #3 ENTERTAINING — a real emotional beat, not a bland summary
  #4 EDUCATIONAL — a noob scanning the comic should learn why the firm decided what it decided

Respond with a single JSON object:
{
  "title": "<5-8 word title for the comic>",
  "style": "<short art style description, e.g. 'Mad Magazine editorial ink, muted gold palette'>",
  "mood": "<one-word mood>",
  "prompt": "<the full image-gen prompt, 450-750 words, panel-by-panel, naming every character in every panel they appear in, specifying the style note once at the top, using character VISUAL DESCRIPTIONS verbatim from the cast above>"
}

No prose outside the JSON. No markdown fences.`;
}

async function writeComicScript(params: {
  anthropicKey: string;
  meeting: MeetingOutput;
  cast: CastBundle;
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
    },
    null,
    2
  );
  const resp = await client.messages.create({
    model: SCRIPT_MODEL,
    max_tokens: 4_000,
    system: buildScriptSystemPrompt(params.cast),
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
// Calls OpenAI's Images API with the user's key. Using gpt-image-2 —
// released 2026-04-21 as "ChatGPT Images 2.0" — which renders legible
// speech-bubble text noticeably better than gpt-image-1 (essential for
// a dialogue-driven comic). Parameter spec remains backward-compatible
// with gpt-image-1; response still in data[0].b64_json. If OpenAI
// tweaks the spec, the runner persists the exact 400 error to
// meeting.comicError so we can see it on the card and fix.

const OPENAI_IMAGE_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const IMAGE_MODEL = 'gpt-image-2';
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
