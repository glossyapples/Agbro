// GET  /api/credentials          → list the signed-in user's stored providers (masked)
// POST /api/credentials          → save { provider, key } for the user
// DEL  /api/credentials?provider → remove the key for that provider
//
// The raw key is NEVER returned on GET — only last-four chars. Writes
// are encrypted at rest (see src/lib/credentials.ts). User's session
// is the only authorisation; no admin endpoints intentionally.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, requireUser } from '@/lib/api';
import {
  saveUserCredential,
  deleteUserCredential,
  listUserCredentials,
  type Provider,
} from '@/lib/credentials';

export const runtime = 'nodejs';

const SaveBody = z.object({
  provider: z.enum(['openai', 'anthropic', 'perplexity']),
  key: z.string().min(8).max(512),
});

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const creds = await listUserCredentials(user.id);
    return NextResponse.json({ credentials: creds });
  } catch (err) {
    return apiError(err, 500, 'failed to list credentials', 'credentials.list');
  }
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const parsed = SaveBody.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }
    await saveUserCredential(user.id, parsed.data.provider, parsed.data.key);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Surface specific config errors directly so the user knows to fix
    // their env vars. Fall back to a generic message for anything else.
    const msg = (err as Error).message ?? '';
    if (msg.startsWith('AGBRO_CREDENTIAL_ENCRYPTION_KEY_MISSING')) {
      return NextResponse.json(
        {
          error:
            'Server env var AGBRO_CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` and add it in Railway → Variables.',
        },
        { status: 500 }
      );
    }
    if (msg.startsWith('AGBRO_CREDENTIAL_ENCRYPTION_KEY_INVALID')) {
      return NextResponse.json(
        { error: msg.replace(/^AGBRO_CREDENTIAL_ENCRYPTION_KEY_INVALID:\s*/, '') },
        { status: 500 }
      );
    }
    if (msg === 'credential.too_short') {
      return NextResponse.json(
        { error: 'Key is too short — double-check you pasted the full value.' },
        { status: 400 }
      );
    }
    return apiError(err, 500, 'failed to save credential', 'credentials.save');
  }
}

export async function DELETE(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider') as Provider | null;
  if (!provider || !['openai', 'anthropic', 'perplexity'].includes(provider)) {
    return NextResponse.json({ error: 'provider query param required' }, { status: 400 });
  }
  try {
    const ok = await deleteUserCredential(user.id, provider);
    return NextResponse.json({ ok });
  } catch (err) {
    return apiError(err, 500, 'failed to delete credential', 'credentials.delete');
  }
}
