/**
 * Project device tokens — create / verify / revoke over a repository seam.
 *
 * A project token authenticates a machine client to one project. The security
 * invariant is simple and absolute: **plaintext never touches the store**.
 * Only the SHA-256 digest (see `platform/lib/tokens.ts`) is persisted; the
 * plaintext is returned to the caller exactly once, at creation time, and is
 * unrecoverable afterwards.
 *
 * The domain layer talks to the tiny `TokenRepo` seam rather than a concrete D1
 * binding, so production supplies a D1-backed adapter over `project_tokens`
 * (schema 0001: `token_hash` UNIQUE, `revoked_at` nullable) while tests drive an
 * in-memory fake. Nothing here caches: every verification re-reads the row, so
 * a revocation is observed by the very next call.
 */

import { generateToken, hashToken } from "../../platform/lib/tokens";

/**
 * A stored token record. Mirrors the persisted columns — there is deliberately
 * no plaintext field, so a record can never leak the secret.
 */
export interface ProjectToken {
  /** Application-generated id (TEXT/ULID in the schema). */
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** SHA-256 hex digest of the plaintext; the only credential material kept. */
  readonly tokenHash: string;
  /** Optional display prefix (e.g. `pt_AbC1`) — never the full secret. */
  readonly tokenPrefix?: string;
  readonly scopes?: string;
  /** Epoch ms of the last successful verification, or `null`. */
  readonly lastUsedAt?: number | null;
  readonly expiresAt?: number | null;
  /** Epoch ms at which the token was revoked, or `null` while usable. */
  readonly revokedAt: number | null;
  readonly createdAt: number;
  /** Epoch ms of the last write (mirrors the schema's NOT NULL `updated_at`). */
  readonly updatedAt: number;
}

/**
 * What the caller may insert: the id/hash/timestamps are minted by this module,
 * never chosen by the caller, so the store cannot be handed a plaintext value.
 */
export interface NewProjectToken {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  readonly scopes: string | null;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Minimal persistence seam for project tokens.
 *
 * A D1 adapter is a handful of prepared statements; the in-memory fake used by
 * the tests implements the same four methods. Implementations MUST NOT receive
 * or store plaintext — the interface only ever traffics in hashes.
 */
export interface TokenRepo {
  /** Insert a new record and return the stored row. */
  insert(token: NewProjectToken): Promise<ProjectToken>;
  /** Find the (at most one) record with this hash, revoked or not. */
  findByHash(tokenHash: string): Promise<ProjectToken | null>;
  /** Stamp `revoked_at`; returns the updated row, or `null` if unknown id. */
  revoke(id: string, at: number): Promise<ProjectToken | null>;
  /** All records for a project, in insertion order. */
  listByProject(projectId: string): Promise<readonly ProjectToken[]>;
}

/** Successful creation: the record plus the one-and-only plaintext release. */
export interface CreatedProjectToken {
  /** The persisted record (hash only — verify with `record.tokenHash`). */
  readonly record: ProjectToken;
  /**
   * The plaintext secret. Returned here and NOWHERE else; the caller must show
   * it to the user immediately and then let it go.
   */
  readonly plaintext: string;
}

/** Options accepted by {@link createProjectToken}. */
export interface CreateProjectTokenInput {
  readonly projectId: string;
  readonly name: string;
  /** Optional scopes string persisted verbatim (defaults to `null`). */
  readonly scopes?: string | null;
  /** Optional epoch-ms expiry (defaults to `null` = never expires). */
  readonly expiresAt?: number | null;
}

/** Clock seam so tests can make timestamps deterministic. */
export type Clock = () => number;

/** Default wall clock: Unix epoch milliseconds. */
const defaultClock: Clock = () => Date.now();

/** Id seam so tests can make ids deterministic; defaults to a ULID-ish random id. */
export type IdFactory = () => string;

/**
 * Default id factory — a 128-bit random hex id.
 *
 * `crypto.randomUUID()` would do, but a plain random string keeps ids uniform
 * with the rest of the schema's TEXT ids and avoids a UUID-shaped assumption.
 */
const defaultId: IdFactory = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Create a project token.
 *
 * Steps:
 *   1. mint a random opaque plaintext and its SHA-256 hash (`generateToken`),
 *   2. build the record — hash only, no plaintext field exists to fill,
 *   3. persist it through the repo,
 *   4. hand the plaintext back exactly once.
 *
 * The plaintext is never written to the repo and is not derivable from any
 * stored value.
 */
export async function createProjectToken(
  repo: TokenRepo,
  input: CreateProjectTokenInput,
  now: Clock = defaultClock,
  nextId: IdFactory = defaultId,
): Promise<CreatedProjectToken> {
  const { plaintext, hash } = await generateToken();
  const at = now();

  const record = await repo.insert({
    id: nextId(),
    projectId: input.projectId,
    name: input.name,
    tokenHash: hash,
    // A short, non-secret display prefix so the UI can disambiguate rows.
    tokenPrefix: plaintext.slice(0, 7),
    scopes: input.scopes ?? null,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    createdAt: at,
    updatedAt: at,
  });

  // The ONLY place the plaintext is released.
  return { record, plaintext };
}

/**
 * INV-A3, made explicit: device-token verification is **uncached**.
 *
 * Device tokens are the one credential where immediacy is security-relevant —
 * an operator revoking a leaked machine token expects the very next request to
 * fail, not "within a minute". There is therefore no memo, module-level map or
 * TTL cache anywhere between {@link verifyProjectToken} and the store: every
 * verification does a fresh `findByHash`. This constant is the machine-readable
 * statement of that contract; the tests assert it rather than trusting prose.
 *
 * (Contrast: a *user-session* cache with a small TTL — ≤60s — is acceptable
 * because a session token lives in a browser tab and revocation latency is
 * bound by an interactive human. A device token has no such cover: it is an
 * unattended credential, so a stale positive is a live vulnerability.)
 */
export const DEVICE_TOKEN_VERIFY_IS_UNCACHED = true as const;

/**
 * The single, uncached read step behind {@link verifyProjectToken}: hash the
 * plaintext and fetch the row it indexes, on EVERY call.
 *
 * Exported so a caller (or test) can invoke the raw lookup directly and prove
 * that `findByHash` is hit per call — there is no layer here to short-circuit a
 * second, third or Nth presentation of the same plaintext.
 */
async function readTokenByPlaintext(
  repo: TokenRepo,
  plaintext: string,
): Promise<ProjectToken | null> {
  const hash = await hashToken(plaintext);
  return repo.findByHash(hash);
}

/**
 * Verify a presented plaintext token.
 *
 * Hashes the input and looks it up. Returns the record iff it exists AND has
 * not been revoked (and, when it carries an expiry, has not expired). The lookup
 * is performed on EVERY call — there is no negative or positive cache (see
 * {@link DEVICE_TOKEN_VERIFY_IS_UNCACHED}) — so a token revoked a moment ago
 * fails immediately rather than riding out a TTL.
 *
 * `undefined` (rather than `null`) marks "no usable token"; the reason is
 * intentionally not distinguished to avoid an oracle.
 */
export async function verifyProjectToken(
  repo: TokenRepo,
  plaintext: string,
  now: Clock = defaultClock,
): Promise<ProjectToken | undefined> {
  // Fresh, uncached read on every call — the whole point of INV-A3.
  const record = await readTokenByPlaintext(repo, plaintext);
  if (record === null) return undefined;
  if (record.revokedAt !== null) return undefined;
  if (record.expiresAt !== null && record.expiresAt !== undefined) {
    if (record.expiresAt <= now()) return undefined;
  }
  return record;
}

/**
 * Revoke a token by id.
 *
 * Sets `revoked_at` to the current time and returns the updated record. Returns
 * `null` when the id is unknown. Verification of the same plaintext fails from
 * the next call onward.
 */
export async function revokeProjectToken(
  repo: TokenRepo,
  id: string,
  now: Clock = defaultClock,
): Promise<ProjectToken | null> {
  return repo.revoke(id, now());
}

/**
 * List a project's tokens.
 *
 * Returns stored records only — by construction they contain hashes, never
 * plaintext, so listing can never recover a secret.
 */
export async function listProjectTokens(
  repo: TokenRepo,
  projectId: string,
): Promise<readonly ProjectToken[]> {
  return repo.listByProject(projectId);
}

// ---------------------------------------------------------------------------
// In-memory fake — an honest implementation of the seam, suitable for tests
// and local dev. It keeps exactly the same shape the D1 adapter would persist.
// ---------------------------------------------------------------------------

/** An in-memory `TokenRepo` suitable for tests and local development. */
export class InMemoryTokenRepo implements TokenRepo {
  /** id -> record, insertion-ordered by JS Map semantics. */
  readonly #byId = new Map<string, ProjectToken>();

  /** tokenHash -> id, standing in for `uq_project_tokens_token_hash`. */
  readonly #idByHash = new Map<string, string>();

  /**
   * Snapshot of every stored record.
   *
   * Exposed so tests can dump the store and prove no plaintext is present —
   * that assertion is the point of the seam.
   */
  raw(): readonly ProjectToken[] {
    return Array.from(this.#byId.values());
  }

  async insert(token: NewProjectToken): Promise<ProjectToken> {
    if (this.#byId.has(token.id)) {
      throw new Error(`InMemoryTokenRepo: duplicate id ${token.id}`);
    }
    if (this.#idByHash.has(token.tokenHash)) {
      // Models the UNIQUE index on token_hash.
      throw new Error("InMemoryTokenRepo: duplicate token_hash");
    }
    const record: ProjectToken = {
      id: token.id,
      projectId: token.projectId,
      name: token.name,
      tokenHash: token.tokenHash,
      tokenPrefix: token.tokenPrefix,
      scopes: token.scopes ?? undefined,
      lastUsedAt: null,
      expiresAt: token.expiresAt,
      revokedAt: token.revokedAt,
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
    };
    this.#byId.set(record.id, record);
    this.#idByHash.set(record.tokenHash, record.id);
    return record;
  }

  async findByHash(tokenHash: string): Promise<ProjectToken | null> {
    const id = this.#idByHash.get(tokenHash);
    if (id === undefined) return null;
    return this.#byId.get(id) ?? null;
  }

  async revoke(id: string, at: number): Promise<ProjectToken | null> {
    const existing = this.#byId.get(id);
    if (existing === undefined) return null;
    const updated: ProjectToken = { ...existing, revokedAt: at };
    this.#byId.set(id, updated);
    return updated;
  }

  async listByProject(projectId: string): Promise<readonly ProjectToken[]> {
    return this.raw().filter((row) => row.projectId === projectId);
  }
}
