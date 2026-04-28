// POST /api/research/deep — runs the deep-research agent for a single
// symbol on demand and STREAMS progress + results back to the client
// as Server-Sent Events. Triggered by the "Research" button on each
// holding / watchlist row.
//
// Why SSE instead of a one-shot JSON response: Opus 4.7 with
// thinking='adaptive' + effort='high' can take 60-120s on a deep
// research note. Mobile Safari aborts ordinary fetches at ~60s. With
// SSE the server keeps writing bytes the whole time (phase updates,
// progress counters, then the final result), so the connection stays
// alive and the modal sees real progress instead of staring at a
// spinner.
//
// Wire format (one SSE frame per event):
//   event: phase            data: {"phase":"fetching"}
//   event: phase            data: {"phase":"thinking"}
//   event: thinking_progress data: {"chars":1234}
//   event: phase            data: {"phase":"writing"}
//   event: writing_progress data: {"chars":567}
//   event: phase            data: {"phase":"persisting"}
//   event: done             data: {"symbol":"…","output":{…},"costUsd":0.93,…}
//   event: error            data: {"error":"…","kind":"timeout"}
//
// Cost per call is bounded by the agent's max-tokens cap (~$0.50-1.50
// with Opus 4.7). Rate-limited via the default bucket so a user
// can't accidentally burn $50 by spam-clicking the button.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';
import { runDeepResearchSafe, type DeepResearchEvent } from '@/lib/agents/deep-research';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
// SSE keeps the request open for the duration of the Opus call. 180s
// covers a high-effort run with a slow filings fetch. Anthropic's own
// timeouts will fire well before this.
export const maxDuration = 180;
// Mark the route as fully dynamic. Streaming responses can't be
// cached or prerendered.
export const dynamic = 'force-dynamic';

const Body = z.object({
  symbol: z.string().min(1).max(12),
});

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const gate = await checkLimit(user.id, 'default');
  if (!gate.success) return rateLimited(gate);

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', detail: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const symbol = parsed.data.symbol;
  log.info('research.deep.stream_start', { userId: user.id, symbol });

  // ReadableStream<Uint8Array> body. We push SSE frames into the
  // controller as the agent emits events, then close on done/error.
  // The agent's onEvent callback is the bridge — it gets called from
  // inside the agent's async work and translates each event into a
  // wire frame here.
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  // If the client disconnects mid-stream, `req.signal` aborts and we
  // tear the agent's work down. Saves Opus tokens on cancelled
  // clicks.
  req.signal?.addEventListener('abort', () => {
    log.info('research.deep.client_abort', { userId: user.id, symbol });
    abortController.abort();
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Controller already closed (race with abort). Swallow.
        }
      };

      // Initial comment frame — flushes early so proxies don't buffer
      // the start of the response and clients get a quick "we're
      // alive" signal even before the first data event.
      safeEnqueue(': stream open\n\n');

      const onEvent = (e: DeepResearchEvent) => {
        if (closed) return;
        switch (e.type) {
          case 'phase':
            safeEnqueue(sseEvent('phase', { phase: e.phase }));
            break;
          case 'thinking_progress':
            safeEnqueue(sseEvent('thinking_progress', { chars: e.chars }));
            break;
          case 'writing_progress':
            safeEnqueue(sseEvent('writing_progress', { chars: e.chars }));
            break;
          case 'done':
            safeEnqueue(
              sseEvent('done', {
                symbol: e.result.symbol,
                output: e.result.output,
                costUsd: e.result.costUsd,
                noteId: e.result.noteId,
                createdAtISO: e.result.createdAtISO,
              })
            );
            break;
          case 'error':
            safeEnqueue(sseEvent('error', { error: e.message, kind: e.kind }));
            break;
        }
      };

      // runDeepResearchSafe never throws — errors come back through
      // onEvent as 'error' frames. We close the controller after it
      // resolves regardless of outcome.
      await runDeepResearchSafe({
        userId: user.id,
        symbol,
        onEvent,
        signal: abortController.signal,
      });
      closed = true;
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
    cancel() {
      // Browser/client closed the stream early. Aborting our agent
      // work stops further Opus tokens.
      abortController.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable Nginx-style proxy buffering so each frame flushes
      // immediately. Belt-and-suspenders alongside no-transform.
      'X-Accel-Buffering': 'no',
    },
  });
}
