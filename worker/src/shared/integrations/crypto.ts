/**
 * shared/integrations/crypto — encrypt integration secrets **at rest** and
 * decrypt them again only at the execution boundary (A29 / FR-INT-03 /
 * NFR-SEC-05).
 *
 * An integration config is where a tenant parks the credentials that let
 * Insight reach the outside world: an SMTP password, a Telegram bot token, a
 * Slack webhook secret. Those values are the most sensitive bytes the worker
 * ever holds, and the storage rule is blunt: **a stored secret is ciphertext**,
 * never plaintext. This module is the pair of functions that makes that rule
 * true —
 *
 * ```
 *   ciphertext = await encryptSecret(plaintext, key, aad)   // write path, store this
 *   plaintext  = await decryptSecret(ciphertext, key, aad)  // execution boundary only
 * ```
 *
 * ## Encrypt at rest, decrypt at the boundary
 *
 * The two calls live on opposite sides of the process. {@link encryptSecret}
 * runs when config is saved and its output is what the repository persists;
 * {@link decryptSecret} runs *just before* the integration is invoked — the
 * egress boundary in `shared/integrations/runtime.ts` — and nowhere else. The
 * plaintext never has a durable representation, so a leaked database row, a
 * backup or a `SELECT *` in a support session yields an opaque blob rather than
 * a live credential. The two directions are symmetric: whatever `encryptSecret`
 * returns, `decryptSecret` must accept, and no other input.
 *
 * ## The cipher — WebCrypto AES-GCM, spelled out
 *
 * The cipher is the platform's own `crypto.subtle` **AES-GCM** (a
 * 256-bit key, a fresh random 96-bit nonce per encryption, a 128-bit
 * authentication tag). This is the documented, standards-backed equivalent
 * called for by the task: AES-GCM is AEAD, so the ciphertext carries its own
 * integrity proof — a tampered byte, a truncated blob or the **wrong key** all
 * make `crypto.subtle.decrypt` *throw*, with no partial plaintext ever
 * returned. There is deliberately no fallback cipher and no "best effort"
 * decode: an authenticated open either yields the exact bytes that were sealed
 * or fails loudly. Because decryption is not a lookup, a wrong key is
 * indistinguishable from corruption — both are "cannot open", which is exactly
 * the fail-closed answer we want.
 *
 * ## The wire envelope
 *
 * A sealed secret is a self-describing ASCII envelope, never bare bytes:
 *
 * ```
 *   insight-secret:v1:<base64url(nonce)>.<base64url(ciphertext||tag)>
 * ```
 *
 * The `v1` segment is a *format* version, not a key version (the key is an
 * injected seam, below), so a future change to nonce length, cipher or
 * encoding can be introduced behind a `v2` prefix without ambiguity, and this
 * module can refuse an envelope it does not understand instead of guessing.
 * The envelope is stored as a `TEXT` column: no `Buffer`, no binary column, no
 * runtime-specific byte handling. Base64url (rather than JSON or hex) keeps the
 * blob compact and free of characters that would need escaping in SQL, a URL or
 * a log line.
 *
 * ## The key is an injected seam, and the only way in
 *
 * The AES key arrives as a `CryptoKey` argument — this module holds **no**
 * module-level key, no default key and no `import.meta.env` read. The caller
 * (see `platform/config/secrets.ts`) owns the source — a Cloudflare Workers
 * `crypto.subtle` key derived from a `SECRET_ENCRYPTION_KEY` binding, minted
 * once at deploy. That seam is the whole reason the module can be tested at all:
 * a test injects a fresh key, asserts a round-trip, and asserts that a *second*
 * key cannot open the first key's ciphertext. There is no hidden third option —
 * if the key is wrong, decrypt fails.
 *
 * ## What "ciphertext must not contain plaintext" means here
 *
 * The acceptance criterion is literal: the stored string must not contain the
 * plaintext substring. It holds for two independent reasons. First, AES-GCM's
 * output is a keystream-XOR of the plaintext with a value derived from
 * `(key, nonce)`; without the key it is pseudorandom, so a short ASCII secret
 * does not survive as a visible substring. Second, the envelope is base64url —
 * which shares no character with the surrounding JSON storing it — so even the
 * envelope's delimiters cannot smuggle a fragment of the config, and the
 * plaintext bytes are not themselves part of the encoded stream. A test pins
 * this against the real WebCrypto implementation, not a mock.
 *
 * ## The AAD binds a blob to its place (and is optional)
 *
 * AES-GCM accepts *additional authenticated data*: bytes that are authenticated
 * but not encrypted. Passing the integration's identity (say
 * `"<projectId>/<integrationId>"`) as {@link aad} means a ciphertext lifted from
 * one integration and pasted onto another fails to open — the tag no longer
 * matches — even though the key is right. The binding is opt-in (the third
 * argument is optional, defaulting to `null`), so callers that store one secret
 * per row need not invent an identity, while the multi-secret case can harden
 * itself. The rule the tests pin: whatever AAD was supplied at seal time must be
 * supplied again at open time, or decryption fails.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * First segment of every envelope. A human looking at a stored value can tell
 * at a glance that it is an Insight sealed secret and not, say, a base64 photo
 * — which is the difference between "expected" and "a config row leaked".
 */
export const SECRET_ENVELOPE_PREFIX = "insight-secret";

/**
 * Envelope format version. Bumped only when the *format* changes (cipher,
 * nonce size, encoding), never when a key rotates. A `v2` envelope is refused
 * by this module rather than misparsed.
 */
export const SECRET_ENVELOPE_VERSION = "v1";

/** AES-GCM nonce length in bytes. 96 bits is the size GCM is specified for. */
export const SECRET_NONCE_BYTES = 12;

/** AES-GCM authentication-tag length in bits. The maximum, and the default. */
export const SECRET_TAG_BITS = 128;

/** AES key length in bits. */
export const SECRET_KEY_BITS = 256;

const VERSION_SEGMENT = `${SECRET_ENVELOPE_PREFIX}:${SECRET_ENVELOPE_VERSION}`;

/**
 * Base64url alphabet (RFC 4648 §5), same one `platform/lib/tokens.ts` uses:
 * URL- and SQL-safe, and `Buffer`-free (`Buffer` is absent under
 * `@cloudflare/workers-types`).
 */
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Character → 6-bit value, as a static literal table: a plain object lookup is
 * the honest shape here (string keys, fixed size, no insertion/iteration), and
 * it lets {@link base64urlToBytes} reject every out-of-alphabet character —
 * padding, `+`, `/`, whitespace — in one `undefined` check.
 */
const BASE64URL_LOOKUP: Record<string, number> = Object.fromEntries(
  [...BASE64URL_ALPHABET].map((char, index) => [char, index]),
);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Stable machine codes for every way {@link decryptSecret} can refuse an
 * envelope. A caller may branch on these (a `format` error is a corrupt config;
 * `key_or_data` is a wrong key or an edited blob, and both are fail-closed).
 */
export type SecretCryptoErrorCode =
  | "malformed_envelope"
  | "unsupported_version"
  | "malformed_nonce"
  | "malformed_ciphertext"
  | "key_or_data";

/**
 * The one error this module throws. `code` is the stable, branchable part;
 * `message` is for humans and is never depended on by callers.
 *
 * `key_or_data` is deliberately coarse: AES-GCM cannot tell a wrong key from a
 * tampered ciphertext, and pretending otherwise would be a lie the module's
 * users might build on.
 */
export class SecretCryptoError extends Error {
  readonly code: SecretCryptoErrorCode;

  constructor(code: SecretCryptoErrorCode, message: string) {
    super(message);
    this.name = "SecretCryptoError";
    this.code = code;
  }
}

/** Type guard for {@link SecretCryptoError}, safe across realms/bundlers. */
export function isSecretCryptoError(value: unknown): value is SecretCryptoError {
  return value instanceof SecretCryptoError;
}

// ---------------------------------------------------------------------------
// Base64url (local, so the module is dependency-free and Buffer-free)
// ---------------------------------------------------------------------------

/**
 * Narrow a `Uint8Array` to a plain-`ArrayBuffer` `BufferSource`.
 *
 * WebCrypto's `BufferSource` is typed against `ArrayBuffer`, not the wider
 * `ArrayBufferLike` a `Uint8Array`'s `.buffer` reports (it may be a
 * `SharedArrayBuffer`), so the platform types reject a raw view. Copying the
 * *exact* octet range into a fresh `ArrayBuffer` both satisfies the type and
 * avoids the classic bug of hashing/sealing a byte range the caller did not
 * name — the same idiom `firmware/upload.ts` uses for its digest.
 */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

/** Encode bytes as unpadded base64url. */
export function bytesToBase64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const triple = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += BASE64URL_ALPHABET[(triple >> 18) & 0x3f];
    out += BASE64URL_ALPHABET[(triple >> 12) & 0x3f];
    out += BASE64URL_ALPHABET[(triple >> 6) & 0x3f];
    out += BASE64URL_ALPHABET[triple & 0x3f];
  }
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

/**
 * Decode unpadded base64url into bytes. Returns `null` on any character outside
 * the alphabet (and on the illegal single-trailing-character case) so callers
 * can raise their own `code`-bearing error instead of a `SyntaxError`.
 */
export function base64urlToBytes(input: string): Uint8Array | null {
  // A base64 string of 1 leftover character cannot arise from encoding; refuse
  // it rather than silently dropping bits.
  if (input.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((input.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of input) {
    // `hasOwn` guards against inherited keys (`toString`, `constructor`) reading
    // as a value on a plain object table.
    if (!Object.hasOwn(BASE64URL_LOOKUP, char)) return null;
    const value = BASE64URL_LOOKUP[char];
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out.subarray(0, outIndex);
}

// ---------------------------------------------------------------------------
// Key import (the injected seam's companion)
// ---------------------------------------------------------------------------

/**
 * Turn a secret string (a base64url-encoded 32-byte key, e.g. from a Workers
 * binding) into the AES-GCM {@link CryptoKey} this module takes.
 *
 * The base64url form keeps the secret copy-pasteable into a Workers secret
 * without platform-specific bytes; the decoded length is checked so a
 * mistyped/short key fails **at import**, loudly, rather than producing a
 * ciphertext nobody can open. Import is non-extractable: the key can encrypt
 * and decrypt but cannot be read back out.
 */
export async function importSecretKey(encodedKey: string): Promise<CryptoKey> {
  const bytes = base64urlToBytes(encodedKey);
  if (bytes === null || bytes.length * 8 !== SECRET_KEY_BITS) {
    throw new SecretCryptoError(
      "key_or_data",
      `importSecretKey: expected a base64url-encoded ${SECRET_KEY_BITS}-bit key`,
    );
  }
  return crypto.subtle.importKey("raw", toBufferSource(bytes), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Mint a fresh AES-GCM key for a *new* deployment. Returns the key and its
 * base64url encoding, because the encoding is what gets stored in the
 * deployment secret and the key is what the runtime injects.
 *
 * This is the one place this module touches key *material*; it never reads an
 * environment variable. Key provisioning is a deploy-time act, not a request-
 * time one.
 */
export async function generateSecretKey(): Promise<{
  readonly key: CryptoKey;
  readonly encoded: string;
}> {
  const raw = new Uint8Array(SECRET_KEY_BITS / 8);
  crypto.getRandomValues(raw);
  const key = await crypto.subtle.importKey("raw", toBufferSource(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { key, encoded: bytesToBase64url(raw) };
}

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

/** A nonce source; `null` (the default) draws one from the platform CSPRNG. */
export type NonceSource = () => Uint8Array | null;

/** Options for {@link encryptSecret}. */
export interface EncryptSecretOptions {
  /**
   * Additional authenticated data: authenticated, not encrypted. Supply the
   * integration's identity to bind the blob to its row; supply the same value
   * at {@link decryptSecret} time or the open fails.
   */
  readonly aad?: string | null;
  /**
   * Nonce seam. Defaults to a fresh CSPRNG nonce per call — the correct choice
   * for AES-GCM, where **reusing a nonce under one key is catastrophic**. The
   * seam exists only so a test can pin a nonce; production never sets it.
   */
  readonly nonce?: NonceSource;
}

/**
 * Seal `plaintext` into the storable envelope
 * `insight-secret:v1:<nonce>.<ciphertext+tag>`.
 *
 * A fresh random 96-bit nonce is drawn per call, so encrypting the same secret
 * twice yields two different envelopes — which is the point: a repeated blob
 * would tell an observer that two configs share a secret. The plaintext is
 * UTF-8 encoded and AES-GCM-sealed under `key`; the tag is appended to the
 * ciphertext inside the second segment, as the WebCrypto API does.
 *
 * Whatever this returns is safe to persist verbatim and unsafe to log: it is
 * the only form of the secret storage may hold.
 */
export async function encryptSecret(
  plaintext: string,
  key: CryptoKey,
  options: EncryptSecretOptions = {},
): Promise<string> {
  // A fresh CSPRNG nonce per call; reusing one under AES-GCM is catastrophic.
  // The seam's contract is that a `null`/`undefined` return means "I have no
  // nonce" and falls through to the CSPRNG — not that it supplies a zero nonce,
  // which would repeat under a fixed key and destroy GCM's security.
  const nonce = options.nonce?.() ?? new Uint8Array(SECRET_NONCE_BYTES);
  if (options.nonce === undefined || nonce.every((byte) => byte === 0)) {
    crypto.getRandomValues(nonce);
  }
  if (nonce.length !== SECRET_NONCE_BYTES) {
    throw new SecretCryptoError(
      "malformed_nonce",
      `encryptSecret: nonce must be ${SECRET_NONCE_BYTES} bytes, got ${nonce.length}`,
    );
  }
  // `additionalData` wants a `BufferSource`; `null`/absent means "no AAD", not
  // the four ASCII bytes of the word "null".
  const aad =
    options.aad == null ? undefined : toBufferSource(new TextEncoder().encode(options.aad));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(nonce), additionalData: aad, tagLength: SECRET_TAG_BITS },
    key,
    toBufferSource(new TextEncoder().encode(plaintext)),
  );
  const body = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed);
  return `${VERSION_SEGMENT}:${bytesToBase64url(nonce)}.${bytesToBase64url(body)}`;
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/** Options for {@link decryptSecret}. */
export interface DecryptSecretOptions {
  /** Must equal the `aad` supplied at seal time, or the open fails. */
  readonly aad?: string | null;
}

/**
 * Open an envelope produced by {@link encryptSecret} and return the exact
 * plaintext that was sealed.
 *
 * This is the **execution boundary**: call it immediately before an integration
 * is invoked, hold the result in a local, and let it fall out of scope. On any
 * problem — a foreign version, a garbled nonce or body, a wrong key, a tampered
 * blob, a mismatched AAD — it throws {@link SecretCryptoError} and returns
 * nothing. It never yields a partial or guessed plaintext, so "decrypt
 * succeeded" is a proof the blob is the one that was stored for this key.
 */
export async function decryptSecret(
  envelope: string,
  key: CryptoKey,
  options: DecryptSecretOptions = {},
): Promise<string> {
  const { nonce, body } = parseEnvelope(envelope);
  const aad =
    options.aad == null ? undefined : toBufferSource(new TextEncoder().encode(options.aad));
  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toBufferSource(nonce), additionalData: aad, tagLength: SECRET_TAG_BITS },
      key,
      toBufferSource(body),
    );
  } catch {
    // The library refuses to say whether it was the key or the data; neither
    // can be distinguished, and both mean "do not proceed".
    throw new SecretCryptoError("key_or_data", "decryptSecret: authentication failed");
  }
  return new TextDecoder().decode(opened);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Split `insight-secret:v1:<nonce>.<body>` and decode both segments. */
function parseEnvelope(envelope: string): { nonce: Uint8Array; body: Uint8Array } {
  if (typeof envelope !== "string") {
    throw new SecretCryptoError("malformed_envelope", "decryptSecret: envelope must be a string");
  }
  const segments = envelope.split(":");
  if (segments.length !== 3 || segments[0] !== SECRET_ENVELOPE_PREFIX) {
    throw new SecretCryptoError("malformed_envelope", "decryptSecret: not an insight secret envelope");
  }
  if (segments[1] !== SECRET_ENVELOPE_VERSION) {
    throw new SecretCryptoError(
      "unsupported_version",
      `decryptSecret: unsupported envelope version "${segments[1]}"`,
    );
  }
  const parts = segments[2].split(".");
  if (parts.length !== 2) {
    throw new SecretCryptoError("malformed_envelope", "decryptSecret: envelope body is not <nonce>.<ciphertext>");
  }
  const nonce = base64urlToBytes(parts[0]);
  if (nonce === null || nonce.length !== SECRET_NONCE_BYTES) {
    throw new SecretCryptoError(
      "malformed_nonce",
      `decryptSecret: nonce must decode to ${SECRET_NONCE_BYTES} bytes`,
    );
  }
  const body = base64urlToBytes(parts[1]);
  // The body is `ciphertext||tag`; an empty plaintext legitimately yields a
  // body of exactly the tag length, so `>=` (not `>`) is correct, and a body
  // shorter than a tag can never be a sealed value.
  if (body === null || body.length < SECRET_TAG_BITS / 8) {
    throw new SecretCryptoError("malformed_ciphertext", "decryptSecret: ciphertext is missing or too short");
  }
  return { nonce, body };
}
