/**
 * identity/user-tokens — per-user API tokens over a repository seam.
 *
 * A *user token* is a long-lived bearer credential a **human** mints for
 * themselves (a personal access token) so a script or a third-party tool can
 * act on their behalf without holding their password or browser session. It is
 * deliberately *not* a device token: a device token (`identity/tokens.ts`)
 * authenticates an unattended machine to exactly one project and is the only
 * credential that may write telemetry; a user token acts as the *person*.
 *
 * The security invariant is the same one that governs device tokens, and it is
 * absolute: **plaintext never touches the store**. Only the SHA-256 digest
 * (see `platform/lib/tokens.ts`, reused verbatim — this module never re-hashes
 * by hand) is persisted; the plaintext is returned to the caller exactly once,
 * at creation time, and is unrecoverable afterwards.
 *
 * ## Scope & project
 *
 * Every token carries one of two scopes:
 *
 *   * `"read"`  — the token may read: it holds the `read` capability and
 *     **nothing else**. A read token can never perform a write or an admin
 *     action.
 *   * `"admin"` — the token is the user's own automation key: it holds `read`
 *     and `write`, and may perform admin-class actions.
 *
 * A token is *optionally* bound to a project (`projectId`). When bound, it is
 * valid **only** for that project — verifying it against another tenant fails
 * closed, exactly like a device token whose project contradicts the path. When
 * `projectId` is `null` the token is account-wide and applies to every project
 * the user is a member of.
 *
 * ## Expiry & revocation
 *
 * A token may carry an `expiresAt` (epoch ms). An expired token fails
 * verification regardless of revocation state. Revocation (`revokedAt`) takes
 * effect **immediately**: verification is uncached, so the very next call with
 * the same plaintext is rejected.
 *
 * ## Authorization
 *
 * {@link hasScope} semantics from `platform/middleware/resolve-project.ts` are
 * reused rather than re-implemented: {@link userTokenPrincipal} projects a
 * verified token onto the shared `Principal` vocabulary, so the `read`/`write`
 * gate is the *same* code path the middleware and the telemetry route use. A
 * `read`-scoped token is therefore refused `write` — and, a fortiori, the
 * admin-class actions gated through {@link canUserTokenAction}.
 */

import { generateToken, hashToken } from "../../platform/lib/tokens";
import { defaultClock, type Clock } from "../../platform/lib/clock";
import { hasScope, type Principal } from "../../platform/middleware/resolve-project";

// ---------------------------------------------------------------------------
// Scope vocabulary
// ---------------------------------------------------------------------------

/**
 * The two user-token scopes.
 *
 * `read` is the least privilege that still lets the token act; `admin` is the
 * full automation key. There is deliberately no `"write"`-only scope: a token
 * that may mutate state inherently also needs to read it, so the vocabulary
 * stays two-valued and every capability is *derived*, never free-text.
 */
export const USER_TOKEN_SCOPES = ["read", "admin"] as const;

/** A user-token scope: `read` (read-only) or `admin` (read/write/admin). */
export type UserTokenScope = (typeof USER_TOKEN_SCOPES)[number];

/** Type guard: is `value` one of the known user-token scopes? */
export function isUserTokenScope(value: unknown): value is UserTokenScope {
  return typeof value === "string" && (USER_TOKEN_SCOPES as readonly string[]).includes(value);
}

/**
 * The capability string a scope projects onto.
 *
 * This is the bridge to the shared `hasScope` scope semantics: a scope string
 * is a space-separated capability list where `write` must be granted
 * explicitly. `read` therefore grants only `read`; `admin` grants `read write`.
 */
const CAPABILITIES_BY_SCOPE: Record<UserTokenScope, string> = {
  read: "read",
  admin: "read write",
};

/**
 * An action a user-token-authenticated request may attempt.
 *
 * `read`/`write` are the capability classes the shared `hasScope` gate already
 * understands; `admin` is the elevated class only an `admin`-scoped token may
 * perform (token minting, membership changes — anything a mere automation key
 * must not reach).
 */
export type UserTokenAction = "read" | "write" | "admin";

// ---------------------------------------------------------------------------
// Records & seam
// ---------------------------------------------------------------------------

/**
 * A stored user-token record. Mirrors the persisted columns — there is
 * deliberately no plaintext field, so a record can never leak the secret.
 */
export interface UserToken {
  /** Application-generated id (TEXT/ULID in the schema). */
  readonly id: string;
  /** Owning user (the human this token acts as). */
  readonly userId: string;
  /** Human label for the token (e.g. "laptop CLI"). */
  readonly name: string;
  /** The one and only scope this token holds. */
  readonly scope: UserTokenScope;
  /** Owning project when the token is project-bound; `null` for account-wide. */
  readonly projectId: string | null;
  /** SHA-256 hex digest of the plaintext; the only credential material kept. */
  readonly tokenHash: string;
  /** Optional display prefix (e.g. `ut_AbC1`) — never the full secret. */
  readonly tokenPrefix?: string;
  /** Epoch ms of the last successful verification, or `null`. */
  readonly lastUsedAt?: number | null;
  /** Epoch ms after which the token is unusable, or `null` = never expires. */
  readonly expiresAt: number | null;
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
export interface NewUserToken {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly scope: UserTokenScope;
  readonly projectId: string | null;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Minimal persistence seam for user tokens.
 *
 * A D1 adapter is a handful of prepared statements; the in-memory fake used by
 * the tests implements the same four methods. Implementations MUST NOT receive
 * or store plaintext — the interface only ever traffics in hashes.
 */
export interface UserTokenRepo {
  /** Insert a new record and return the stored row. */
  insert(token: NewUserToken): Promise<UserToken>;
  /** Find the (at most one) record with this hash, revoked or not. */
  findByHash(tokenHash: string): Promise<UserToken | null>;
  /** Stamp `revoked_at`; returns the updated row, or `null` if unknown id. */
  revoke(id: string, at: number): Promise<UserToken | null>;
  /** All records owned by a user, in insertion order. */
  listByUser(userId: string): Promise<readonly UserToken[]>;
}

/** Successful creation: the record plus the one-and-only plaintext release. */
export interface CreatedUserToken {
  /** The persisted record (hash only — verify with `record.tokenHash`). */
  readonly record: UserToken;
  /**
   * The plaintext secret. Returned here and NOWHERE else; the caller must show
   * it to the user immediately and then let it go.
   */
  readonly plaintext: string;
}

/** Options accepted by {@link createUserToken}. */
export interface CreateUserTokenInput {
  readonly userId: string;
  readonly name: string;
  /** The token's single scope. Defaults to the least-privilege `"read"`. */
  readonly scope?: UserTokenScope;
  /** Bind the token to one project; omit/`null` for an account-wide token. */
  readonly projectId?: string | null;
  /** Optional epoch-ms expiry (defaults to `null` = never expires). */
  readonly expiresAt?: number | null;
}

/** Id seam so tests can make ids deterministic; defaults to a random hex id. */
export type IdFactory = () => string;

/**
 * Default id factory — a 128-bit random hex id.
 *
 * Kept uniform with `identity/tokens.ts` so ids are opaque TEXT in the schema.
 */
const defaultId: IdFactory = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Create a user token.
 *
 * Steps:
 *   1. mint a random opaque plaintext and its SHA-256 hash (`generateToken` —
 *      the SAME helper device tokens use; no hashing is duplicated here),
 *   2. build the record — hash only, no plaintext field exists to fill,
 *   3. persist it through the repo,
 *   4. hand the plaintext back exactly once.
 *
 * The plaintext is never written to the repo and is not derivable from any
 * stored value.
 */
export async function createUserToken(
  repo: UserTokenRepo,
  input: CreateUserTokenInput,
  now: Clock = defaultClock,
  nextId: IdFactory = defaultId,
): Promise<CreatedUserToken> {
  const { plaintext, hash } = await generateToken();
  const at = now();

  const record = await repo.insert({
    id: nextId(),
    userId: input.userId,
    name: input.name,
    scope: input.scope ?? "read",
    projectId: input.projectId ?? null,
    tokenHash: hash,
    // A short, non-secret display prefix so the UI can disambiguate rows.
    tokenPrefix: plaintext.slice(0, 7),
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    createdAt: at,
    updatedAt: at,
  });

  // The ONLY place the plaintext is released.
  return { record, plaintext };
}

/**
 * The single, uncached read step behind {@link verifyUserToken}: hash the
 * plaintext and fetch the row it indexes, on EVERY call.
 *
 * Private module-internal helper — deliberately NOT exported, so no caller can
 * bypass {@link verifyUserToken}'s revoke/expiry/project checks by reaching the
 * raw lookup directly.
 */
async function readTokenByPlaintext(
  repo: UserTokenRepo,
  plaintext: string,
): Promise<UserToken | null> {
  const hash = await hashToken(plaintext);
  return repo.findByHash(hash);
}

/**
 * Verify a presented plaintext user token.
 *
 * Hashes the input and looks it up. Returns the record iff it exists AND:
 *
 *   * it has not been revoked (`revokedAt === null`),
 *   * it has not expired (`expiresAt === null` or still in the future),
 *   * when a `projectId` is supplied, the token is either account-wide
 *     (`projectId === null`) or bound to exactly that project.
 *
 * The lookup is performed on EVERY call — there is no cache — so a token
 * revoked a moment ago fails immediately rather than riding out a TTL.
 *
 * `undefined` (rather than `null`) marks "no usable token"; the reason is
 * intentionally not distinguished to avoid an oracle.
 */
export async function verifyUserToken(
  repo: UserTokenRepo,
  plaintext: string,
  projectId?: string | null,
  now: Clock = defaultClock,
): Promise<UserToken | undefined> {
  const record = await readTokenByPlaintext(repo, plaintext);
  if (record === null) return undefined;
  if (record.revokedAt !== null) return undefined;
  if (record.expiresAt !== null && record.expiresAt !== undefined) {
    if (record.expiresAt <= now()) return undefined;
  }

  // Project binding: a project-bound token is valid ONLY for its project. An
  // account-wide token (`projectId === null`) is valid anywhere it is used.
  if (projectId !== undefined && projectId !== null) {
    if (record.projectId !== null && record.projectId !== projectId) {
      return undefined;
    }
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
export async function revokeUserToken(
  repo: UserTokenRepo,
  id: string,
  now: Clock = defaultClock,
): Promise<UserToken | null> {
  return repo.revoke(id, now());
}

/**
 * List a user's tokens.
 *
 * Returns stored records only — by construction they contain hashes, never
 * plaintext, so listing can never recover a secret.
 */
export async function listUserTokens(
  repo: UserTokenRepo,
  userId: string,
): Promise<readonly UserToken[]> {
  return repo.listByUser(userId);
}

// ---------------------------------------------------------------------------
// Authorization — reuse the shared `hasScope` semantics
// ---------------------------------------------------------------------------

/**
 * Project a verified user token onto the shared {@link Principal} vocabulary.
 *
 * The result is a `device`-kind principal whose `scopes` come from the scope's
 * capability list. That is exactly the shape {@link hasScope} understands for
 * free-text capability lists (a `read` scope grants read only; `write` must be
 * granted explicitly), so the read/write gate is the *same* code path the
 * middleware and telemetry route already use — no second authorization model
 * to drift out of sync.
 */
export function userTokenPrincipal(token: UserToken): Principal {
  return {
    kind: "device",
    projectId: token.projectId ?? "",
    tokenId: token.id,
    // The `write` capability must be granted explicitly, so it is derived from
    // the scope, never free text (see CAPABILITIES_BY_SCOPE).
    scopes: CAPABILITIES_BY_SCOPE[token.scope],
  };
}

/**
 * May a token holding `scope` perform `action`?
 *
 * Fail-closed on every axis:
 *   * `read`/`write` are delegated to the shared {@link hasScope} — so a
 *     `read`-scoped token is refused `write` (and any other capability), and an
 *     `admin`-scoped token is allowed it;
 *   * `admin` additionally requires the token to actually carry the `admin`
 *     scope; `read` can never reach it.
 */
export function canUserTokenAction(scope: UserTokenScope, action: UserTokenAction): boolean {
  if (action === "admin") return scope === "admin";
  // `read`/`write` go through the shared gate, over the scope-only projection.
  return hasScope({ kind: "device", projectId: "", scopes: CAPABILITIES_BY_SCOPE[scope] }, action);
}

/**
 * Same gate over a verified token, mirroring `resolve-project`'s
 * `requireScope` semantics for a caller that is not a Hono handler: it returns
 * `null` when the action is permitted, or a `403`-shaped denial otherwise.
 */
export interface UserTokenDenial {
  readonly status: 403;
  readonly error: "insufficient_scope";
  readonly message: string;
}

export function requireUserTokenAction(
  token: UserToken,
  action: UserTokenAction,
): UserTokenDenial | null {
  if (canUserTokenAction(token.scope, action)) return null;
  return {
    status: 403,
    error: "insufficient_scope",
    message: `this token's "${token.scope}" scope lacks the "${action}" capability required here`,
  };
}

// ---------------------------------------------------------------------------
// In-memory fake — an honest implementation of the seam, suitable for tests
// and local dev. It keeps exactly the same shape the D1 adapter would persist.
// ---------------------------------------------------------------------------

/** An in-memory `UserTokenRepo` suitable for tests and local development. */
export class InMemoryUserTokenRepo implements UserTokenRepo {
  /** id -> record, insertion-ordered by JS Map semantics. */
  readonly #byId = new Map<string, UserToken>();

  /** tokenHash -> id, standing in for `uq_user_tokens_token_hash`. */
  readonly #idByHash = new Map<string, string>();

  /**
   * Snapshot of every stored record.
   *
   * Exposed so tests can dump the store and prove no plaintext is present —
   * that assertion is the point of the seam.
   */
  raw(): readonly UserToken[] {
    return Array.from(this.#byId.values());
  }

  async insert(token: NewUserToken): Promise<UserToken> {
    if (this.#byId.has(token.id)) {
      throw new Error(`InMemoryUserTokenRepo: duplicate id ${token.id}`);
    }
    if (this.#idByHash.has(token.tokenHash)) {
      // Models the UNIQUE index on token_hash.
      throw new Error("InMemoryUserTokenRepo: duplicate token_hash");
    }
    const record: UserToken = {
      id: token.id,
      userId: token.userId,
      name: token.name,
      scope: token.scope,
      projectId: token.projectId,
      tokenHash: token.tokenHash,
      tokenPrefix: token.tokenPrefix,
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

  async findByHash(tokenHash: string): Promise<UserToken | null> {
    const id = this.#idByHash.get(tokenHash);
    if (id === undefined) return null;
    return this.#byId.get(id) ?? null;
  }

  async revoke(id: string, at: number): Promise<UserToken | null> {
    const existing = this.#byId.get(id);
    if (existing === undefined) return null;
    const updated: UserToken = { ...existing, revokedAt: at };
    this.#byId.set(id, updated);
    return updated;
  }

  async listByUser(userId: string): Promise<readonly UserToken[]> {
    return this.raw().filter((row) => row.userId === userId);
  }
}
