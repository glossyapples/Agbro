// POST /api/meetings/[id]/generate-comic — retroactively render a
// comic for a meeting that already completed. Useful when the user
// added their OpenAI key after the meeting ran, or if the original
// generation failed.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';
import { checkLimit, rateLimited } from '@/lib/ratelimit';
import { generateMeetingComic } from '@/lib/meetings/comic';
import { getUserCredential } from '@/lib/credentials';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  // Cap comic regeneration at 10/hour per user — each call opens a
  // 30-60s OpenAI image window (billed to the user's own key) plus an
  // Opus script call on ours. A stuck retry button could otherwise
  // loop expensively.
  const gate = await checkLimit(user.id, 'meetings.comic');
  if (!gate.success) return rateLimited(gate);

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
    });
    if (!meeting || meeting.userId !== user.id) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (meeting.status !== 'completed') {
      return NextResponse.json(
        { error: `meeting is ${meeting.status}, not completed` },
        { status: 400 }
      );
    }
    const openaiKey = await getUserCredential(user.id, 'openai');
    if (!openaiKey) {
      return NextResponse.json(
        {
          error:
            'No OpenAI key saved. Add one in /settings under API keys, then retry.',
        },
        { status: 400 }
      );
    }
    // Synchronous here (unlike the in-meeting path) so the caller's
    // button-loading state lines up with completion. 15-30s typical.
    const result = await generateMeetingComic({
      meetingId: meeting.id,
      userId: user.id,
      openaiKey,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: 'comic generation failed — see server logs' },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      imageUrl: result.imageUrl,
      costUsd: result.costUsd,
    });
  } catch (err) {
    return apiError(err, 500, 'generate-comic failed', 'meetings.generate_comic');
  }
}
