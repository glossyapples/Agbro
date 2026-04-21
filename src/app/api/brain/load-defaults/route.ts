// One-click loader: installs the starter brain + archived alt strategies
// for the signed-in user. Idempotent — re-running refreshes content but
// never duplicates rows or flips isActive on strategies.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { apiError, requireUser } from '@/lib/api';
import { seedBrainForUser } from '@/lib/brain/seed-brain';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  try {
    const result = await seedBrainForUser(user.id);
    revalidatePath('/brain');
    revalidatePath('/strategy');
    return NextResponse.json({
      ok: true,
      brainEntries: result.brainEntries,
      strategies: result.strategies,
      summary: result.summary,
    });
  } catch (err) {
    return apiError(err, 500, 'failed to load starter brain', 'brain.load_defaults');
  }
}
