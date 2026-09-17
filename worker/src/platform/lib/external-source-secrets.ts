// At-rest sealing for external-source `headers` (API keys, bearer tokens).
// Same AES-GCM scheme as the integration config store, with its own HKDF info
// so the two can't be cross-decrypted.

import type { Env } from '../../env';
import { encryptSecret, decryptSecret } from './crypto';
import { getOrCreateSigningSecret } from './auth-secret';

const ENC_INFO = 'external-source-config';

export async function sealSourceHeaders(env: Env, headers: unknown): Promise<string> {
  const secret = await getOrCreateSigningSecret(env);
  return encryptSecret(secret, JSON.stringify(headers ?? {}), ENC_INFO);
}

// Returns the plaintext JSON string. '' (no headers) returns '{}'.
export async function openSourceHeaders(env: Env, stored: string): Promise<string> {
  if (!stored) return '{}';
  if (!stored.startsWith('v1:')) return stored;
  const secret = await getOrCreateSigningSecret(env);
  return decryptSecret(secret, stored, ENC_INFO);
}
