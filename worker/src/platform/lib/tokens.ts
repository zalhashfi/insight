/**
 * tokens — pure, async-safe helpers for project device tokens.
 *
 * A project device token is an *opaque* bearer credential: nothing about it is
 * self-describing and it carries no claims. The whole secret is the string, so
 * the only durable representation the worker may keep is its SHA-256 digest
 * (see `hashToken`). The plaintext exists for exactly one moment — the return
 * value of `generateToken` — and must never be persisted or logged.
 *
 * This module has no I/O and no module state, which makes every helper safe to
 * call concurrently from any isolate. `hashToken` is async because the digest
 * comes from the (async) WebCrypto Subtle API; callers must `await` it.
 */

/** Fixed prefix identifying an Insight project token ("project token"). */
export const TOKEN_PREFIX = "pt_";

/**
 * Number of random bytes behind a token.
 *
 * 32 bytes = 256 bits of entropy, emitted as 43 base64url characters. That is
 * far past guessability and still comfortably small enough to round-trip
 * through SQL / HTTP headers.
 */
export const TOKEN_BYTES = 32;

/**
 * Base64url alphabet (RFC 4648 §5): URL- and header-safe, no `+`, `/` or `=`.
 * Building the string ourselves keeps the helper free of `Buffer`/`btoa`
 * (`Buffer` is absent under `@cloudflare/workers-types`).
 */
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * A freshly generated secret, carried back to the caller once.
 *
 * `plaintext` is the secret to hand to the user; only `hash` may be stored.
 */
export interface GeneratedToken {
  /** Opaque bearer secret, e.g. `pt_<43 base64url chars>`. */
  readonly plaintext: string;
  /** Lowercase hex SHA-256 of `plaintext` — the only storable form. */
  readonly hash: string;
}

/**
 * Encode bytes as unpadded base64url.
 *
 * Pure and synchronous; exposed because the tests pin the format.
 */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  // Consume 3-byte groups -> 4 characters.
  for (; i + 2 < bytes.length; i += 3) {
    const triple = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += BASE64URL_ALPHABET[(triple >> 18) & 0x3f];
    out += BASE64URL_ALPHABET[(triple >> 12) & 0x3f];
    out += BASE64URL_ALPHABET[(triple >> 6) & 0x3f];
    out += BASE64URL_ALPHABET[triple & 0x3f];
  }
  // Trailing 1 or 2 bytes -> 2 or 3 characters (no padding).
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b = bytes[i];
    out += BASE64URL_ALPHABET[(b >> 2) & 0x3f];
    out += BASE64URL_ALPHABET[(b << 4) & 0x3f];
  } else if (remaining === 2) {
    const triple = (bytes[i] << 8) | bytes[i + 1];
    out += BASE64URL_ALPHABET[(triple >> 10) & 0x3f];
    out += BASE64URL_ALPHABET[(triple >> 4) & 0x3f];
    out += BASE64URL_ALPHABET[(triple << 2) & 0x3f];
  }
  return out;
}

/** Decode lowercase/uppercase hex into bytes. Throws on malformed input. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("hexToBytes: input must be an even-length hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode bytes as lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Generate a fresh opaque token and its digest.
 *
 * Entropy comes from `crypto.getRandomValues` (the CSPRNG underlying
 * WebCrypto), never from `Math.random`. The returned `plaintext` MUST be
 * surfaced to the caller exactly once and then dropped; `hash` is what the
 * repository stores.
 */
export async function generateToken(): Promise<GeneratedToken> {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  const plaintext = TOKEN_PREFIX + base64url(bytes);
  return { plaintext, hash: await hashToken(plaintext) };
}

/**
 * SHA-256 `plaintext` and return the digest as lowercase hex.
 *
 * Deterministic by construction: identical input always yields the identical
 * digest, so lookups can index the fixed-width 64-character hex string
 * directly (matching `project_tokens.token_hash`).
 */
export async function hashToken(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}
