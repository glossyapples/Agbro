// POST /api/safety/clear-kill-switch — manually reset a kill-switch
// pause. Expected flow: the safety rails triggered a halt (daily
// loss exceeded or drawdown threshold hit), the user reviewed the
// situation, decided it's fine to resume, and clicks "Clear kill
// switch" on the home banner or /settings.
//
// Does NOT auto-reset — a halt is deliberately a deliberate "come
// back and look at this" signal, not a flaky alarm.

import { NextResponse } from 'next/server';
import { apiError, requireUser } from '@/lib/api';
import { clearKillSwitch } from '@/lib/safety/rails';

export const runtime = 'nodejs';

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    await clearKillSwitch(user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err, 500, 'failed to clear kill switch', 'safety.clear');
  }
}
