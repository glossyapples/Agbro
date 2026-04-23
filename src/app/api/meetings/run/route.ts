// POST /api/meetings/run — run an executive meeting for the caller.
//
// Body: { kind?: 'weekly' | 'impromptu', agendaOverride?: string }
//
// Synchronous. Meetings typically take 15-40 seconds (one Claude call
// playing all four executive roles + optional comic generation). If
// the caller has an OpenAI key saved, comic generation fires in the
// background after the meeting row is marked completed — the API
// response doesn't wait for it.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';
import { runMeeting } from '@/lib/meetings/runner';

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z.object({
  kind: z.enum(['weekly', 'impromptu']).optional(),
  agendaOverride: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const gate = await checkLimit(user.id, 'default');
  if (!gate.success) return rateLimited(gate);

  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const result = await runMeeting({
      userId: user.id,
      kind: parsed.data.kind ?? 'impromptu',
      agendaOverride: parsed.data.agendaOverride,
    });
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err, 500, 'meeting failed', 'meetings.run');
  }
}
