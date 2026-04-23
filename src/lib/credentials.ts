// Per-user API key storage. Keys are encrypted at rest with AES-256-GCM
// using a server-wide secret from env (AGBRO_CREDENTIAL_ENCRYPTION_KEY)
// plus a random IV per record. Only the last 4 chars of the plaintext
// are stored separately for UI display ("••••1234"); the full key is
// never returned to the frontend after save.
//
// Provider vocabulary (extend as needed):
//   'openai'      — for the meeting comic image generation
//   'anthropic'   — optional override of the app's default Claude key
//   'perplexity'  — optional research override
//
// Security notes:
//   - AGBRO_CREDENTIAL_ENCRYPTION_KEY MUST be set in prod. 64 hex chars
//     (32 bytes). Generate with: openssl rand -hex 32. Rotating the
//     key invalidates all stored credentials — users have to re-enter.
//   - We never log the plaintext key. Use maskKey() in any log lines.
//   - Keys are per-user; NEVER cross-user share.
//   - All callers fetch the key on demand (no process-level caching
//     that could leak across users).

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { prisma } from '@/lib/db';

export type Provider = 'openai' | 'anthropic' | 'perplexity';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard

function getMasterKey(): Buffer {
  const hex = process.env.AGBRO_CREDENTIAL_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'AGBRO_CREDENTIAL_ENCRYPTION_KEY is not set. Generate with `openssl rand -hex 32` and set in Railway env.'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'AGBRO_CREDENTIAL_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Got length ' + hex.length
    );
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getMasterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv:authtag:ciphertext, all hex
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

function decrypt(encoded: string): string {
  const [ivHex, tagHex, ctHex] = encoded.split(':');
  if (!ivHex || !tagHex || !ctHex) {
    throw new Error('credential.invalid_format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = createDecipheriv(ALGO, getMasterKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString('utf8');
}

export function maskKey(plaintext: string): string {
  if (plaintext.length <= 4) return '••••';
  return `••••${plaintext.slice(-4)}`;
}

export async function saveUserCredential(
  userId: string,
  provider: Provider,
  plaintextKey: string
): Promise<void> {
  const trimmed = plaintextKey.trim();
  if (trimmed.length < 8) {
    throw new Error('credential.too_short');
  }
  const encryptedKey = encrypt(trimmed);
  const lastFour = trimmed.slice(-4);
  await prisma.userApiCredential.upsert({
    where: { userId_provider: { userId, provider } },
    create: { userId, provider, encryptedKey, lastFour },
    update: { encryptedKey, lastFour },
  });
}

export async function getUserCredential(
  userId: string,
  provider: Provider
): Promise<string | null> {
  const row = await prisma.userApiCredential.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  if (!row) return null;
  try {
    return decrypt(row.encryptedKey);
  } catch {
    // Fail closed if decryption fails (wrong master key, tampered
    // ciphertext). Never return garbage plaintext.
    return null;
  }
}

export async function deleteUserCredential(
  userId: string,
  provider: Provider
): Promise<boolean> {
  try {
    await prisma.userApiCredential.delete({
      where: { userId_provider: { userId, provider } },
    });
    return true;
  } catch {
    return false;
  }
}

export type CredentialSummary = {
  provider: Provider;
  maskedKey: string;
  createdAt: string;
  updatedAt: string;
};

export async function listUserCredentials(userId: string): Promise<CredentialSummary[]> {
  const rows = await prisma.userApiCredential.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    provider: r.provider as Provider,
    maskedKey: `••••${r.lastFour}`,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}
