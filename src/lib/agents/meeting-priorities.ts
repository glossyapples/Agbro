// Meeting → orchestrator handoff. Every agent wake reads the current
// open meeting action items and gets them as explicit priorities in
// its wake-up prompt. This is the "executor hookup" from the
// graduated-trust model:
//
//   kind='research'         — auto-queued. Agent folds into research priority.
//   kind='review_position'  — auto-queued. Evaluator flags on this wake.
//   kind='adjust_strategy'  — NEVER auto-applied. Surfaces in UI as a
//                             PolicyChange the user accepts or rejects.
//   kind='wait_for_data'    — passive, not surfaced.
//   kind='note'             — passive, not surfaced.
//
// Anti-feedback-loop rule: only the *most recent meeting's* items
// count. We don't stack research priorities from 10 weeks of meetings;
// the firm's focus should be what it was at the last partner gathering,
// not a cumulative pile.

import { prisma } from '@/lib/db';

export type MeetingPriority = {
  id: string;
  kind: 'research' | 'review_position';
  description: string;
  openedAt: string;
  meetingId: string;
};

export async function loadMeetingPriorities(
  userId: string
): Promise<MeetingPriority[]> {
  // Find the most recent completed meeting for this user. Older
  // meetings' items, if still open, don't influence this wake —
  // prevents old priorities from dominating forever.
  const latestMeeting = await prisma.meeting.findFirst({
    where: { userId, status: 'completed' },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  });
  if (!latestMeeting) return [];

  const items = await prisma.meetingActionItem.findMany({
    where: {
      userId,
      meetingId: latestMeeting.id,
      kind: { in: ['research', 'review_position'] },
      status: { in: ['started'] }, // on_hold / blocked / completed don't inject
    },
    orderBy: { createdAt: 'asc' },
  });

  return items.map((i) => ({
    id: i.id,
    kind: i.kind as 'research' | 'review_position',
    description: i.description,
    openedAt: i.createdAt.toISOString(),
    meetingId: i.meetingId,
  }));
}

// Renders the priorities as a wake-prompt fragment. Empty string when
// there are no open items — the orchestrator just runs with the
// default wake message.
export function renderPrioritiesForWakePrompt(priorities: MeetingPriority[]): string {
  if (priorities.length === 0) return '';
  const researchItems = priorities.filter((p) => p.kind === 'research');
  const reviewItems = priorities.filter((p) => p.kind === 'review_position');
  const lines: string[] = [
    '',
    'PRIORITIES FROM LAST EXECUTIVE MEETING (still open):',
  ];
  if (researchItems.length > 0) {
    lines.push('  Research topics:');
    for (const r of researchItems) lines.push(`    • ${r.description}`);
  }
  if (reviewItems.length > 0) {
    lines.push('  Positions to re-evaluate:');
    for (const r of reviewItems) lines.push(`    • ${r.description}`);
  }
  lines.push(
    '',
    'Fold these into your normal cycle. If you genuinely address one (research_note written, position reviewed + decision recorded), the next meeting will mark it completed.'
  );
  return lines.join('\n');
}

// Stamp executedBy on every priority item the orchestrator saw.
// Creates an audit trail ("which agent run addressed this item?")
// without requiring the agent to explicitly mark anything.
export async function markPrioritiesSeen(
  priorities: MeetingPriority[],
  agentRunId: string
): Promise<void> {
  if (priorities.length === 0) return;
  await prisma.meetingActionItem.updateMany({
    where: { id: { in: priorities.map((p) => p.id) } },
    data: { executedBy: agentRunId },
  });
}
