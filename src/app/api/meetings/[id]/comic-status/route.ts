// GET /api/meetings/[id]/comic-status — cheap poll endpoint used by
// MeetingControls after an impromptu run to watch for comic
// completion without triggering a full server-component refresh on
// every tick. Returns the minimum shape the poller needs.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError, requireUser } from '@/lib/api';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: params.id },
      select: { userId: true, comicUrl: true, comicError: true, status: true },
    });
    if (!meeting || meeting.userId !== user.id) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json(
      {
        status: meeting.status,
        comicUrl: meeting.comicUrl,
        comicError: meeting.comicError,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return apiError(err, 500, 'failed to read comic status', 'meetings.comic_status');
  }
}
