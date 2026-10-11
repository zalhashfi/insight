/**
 * identity/invites — project invitations over injected seams.
 *
 * Insight is **invite-only** (see `identity/bootstrap.ts`): after the founding
 * owner is claimed, every other human joins by *accepting an invitation*. An
 * invite is a bearer credential that a project admin (or owner) mints for a
 * specific email address, carrying the exact project and role the invitee will
 * receive. Accepting it is what creates the membership.
 *
 * ## The token is a secret, and it is stored exactly like every other one
 *
 * An invite token is an opaque bearer secret — whoever holds the link can
 * accept the invite. So it obeys the same absolute rule as device tokens
 * (`identity/tokens.ts`) and user tokens (`identity/user-tokens.ts`):
 * **plaintext never touches the store**. Only the SHA-256 digest (from
 * `platform/lib/tokens.ts`, reused verbatim — this module never re-hashes by
 * hand) is persisted; the plaintext is returned to the caller exactly once, at
 * creation time, to be put in the invitation email, and is unrecoverable
 * afterwards. Dumping the store can therefore never resurrect a usable link.
 *
 * ## Single-use, and *why* it is a conditional write
 *
 * An invite may be accepted **once**. The guard is not a read-then-check in
 * application code — two concurrent accepts could both read `acceptedAt: null`
 * and both create a membership. The guard is the *conditional* store write
 * {@link InviteRepo.markAccepted}: it stamps `accepted_at` only while the row is
 * still unaccepted, and reports whether *this* caller won. Exactly one of N
 * racing accepts wins; every other caller observes `false` and is refused with
 * `409`. That is the same "the guard lives in the write" discipline
 * `bootstrapOwner` applies to the founding-owner claim.
 *
 * ## Expiry & revocation
 *
 * An invite may carry an `expiresAt` (epoch ms); an expired invite fails
 * acceptance regardless of acceptance/revocation state. Revocation
 * (`revokedAt`) takes effect immediately. Both are checked on the freshly read
 * row, once, before the conditional accept — see {@link acceptInvite}.
 *
 * ## Scope
 *
 * An invite is bound to exactly one `(projectId, role)` pair. Accepting it
 * grants *that* project membership at *that* role and nothing else: the
 * accepted invite can never be replayed against another project, and the role
 * is the one the inviter chose (never chosen by the accepting caller).
 *
 * ## Seams
 *
 * Nothing here talks to D1 or to `MembershipService` directly. Persistence is
 * the {@link InviteRepo} seam (an in-memory fake in tests, a D1 adapter over an
 * `invites` table in production), and the membership write is the narrow
 * {@link MembershipGrant} seam, which `MembershipService.addMember`-style
 * adapters satisfy. That keeps the whole contract — single-use, expiry,
 * revocation, project/role binding — exercisable without a database.
 */

import { generateToken, hashToken } from "../../platform/lib/tokens";
import type { Role } from "../projects/membership";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Stable, machine-readable failure codes for the invite domain.
 *
 *   * `invalid_input`   — a required field was blank / malformed;
 *   * `invalid_invite`  — the token is unknown, expired, revoked or already
 *                         accepted (deliberately a *single* code: the accept
 *                         path must not be an oracle that tells an attacker
 *                         whether a guessed token ever existed);
 *   * `already_invited` — an unaccepted invite already exists for this
 *                         `(project, email)` pair.
 */
export type InviteErrorCode = "invalid_input" | "invalid_invite" | "already_invited";

/**
 * Lookup of an {@link InviteErrorCode} onto an HTTP status.
 *
 * `invalid_invite` is `410 Gone`: the invite *was* a thing and is no longer
 * usable (used up, expired, revoked), which is more precise for the client than
 * a bare `404`. It is still a `4xx`, so a rejected accept is never silently
 * retried as a success. A caller that prefers to unify "unknown" and "dead"
 * links can map `410` back to `404` at the edge; the domain keeps the sharper
 * code and the tests assert the `4xx` class via {@link InviteError.status}.
 */
export const INVITE_STATUS: Record<InviteErrorCode, number> = {
  invalid_input: 400,
  invalid_invite: 410,
  already_invited: 409,
};

/** Error thrown by every failing entry point of this module. */
export class InviteError extends Error {
  /** Stable code suitable for mapping onto an HTTP response. */
  readonly code: InviteErrorCode;

  /** HTTP status corresponding to {@link code}. */
  readonly status: number;

  constructor(code: InviteErrorCode, message: string) {
    super(message);
    this.name = "InviteError";
    this.code = code;
    this.status = INVITE_STATUS[code];
  }
}

/** Convenience guard for `catch` blocks. */
export function isInviteError(err: unknown): err is InviteError {
  return err instanceof InviteError;
}

// ---------------------------------------------------------------------------
// Entities & seam
// ---------------------------------------------------------------------------

/**
 * A stored invitation record. Mirrors the persisted columns — there is
 * deliberately no plaintext field, so a record can never leak the link secret.
 */
export interface Invite {
  /** Application-generated id (TEXT/ULID in the schema). */
  readonly id: string;
  /** The project the invitee will join. */
  readonly projectId: string;
  /** The role the invitee will be granted on acceptance. */
  readonly role: Role;
  /** The address the invite was sent to (logged, and matched on accept). */
  readonly email: string;
  /** SHA-256 hex digest of the token; the only credential material kept. */
  readonly tokenHash: string;
  /** Optional display prefix (e.g. `in_AbC1`) — never the full secret. */
  readonly tokenPrefix?: string;
  /** The user who minted the invite (admin/owner), for audit. */
  readonly invitedBy?: string | null;
  /** Epoch ms after which the invite is unusable, or `null` = never expires. */
  readonly expiresAt: number | null;
  /** Epoch ms at which the invite was consumed, or `null` while unused. */
  readonly acceptedAt: number | null;
  /** Epoch ms at which the invite was revoked, or `null` while usable. */
  readonly revokedAt: number | null;
  readonly createdAt: number;
  /** Epoch ms of the last write (mirrors the schema's NOT NULL `updated_at`). */
  readonly updatedAt: number;
}

/**
 * What the caller may insert: the id/hash/timestamps are minted by this module,
 * never chosen by the caller, so the store cannot be handed a plaintext value.
 */
export interface NewInvite {
  readonly id: string;
  readonly projectId: string;
  readonly role: Role;
  readonly email: string;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  readonly invitedBy: string | null;
  readonly expiresAt: number | null;
  readonly acceptedAt: number | null;
  readonly revokedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Minimal persistence seam for invitations.
 *
 * Implementations MUST NOT receive or store plaintext — the interface only ever
 * traffics in hashes. The single non-trivial method is
 * {@link InviteRepo.markAccepted}, whose *atomicity* is the security contract:
 * see the module header.
 */
export interface InviteRepo {
  /** Insert a new record and return the stored row. */
  insert(invite: NewInvite): Promise<Invite>;
  /** Find the (at most one) record with this hash, consumed/revoked or not. */
  findByHash(tokenHash: string): Promise<Invite | null>;
  /**
   * Atomically consume the invite: set `accepted_at = at` **only if** the row
   * still has `accepted_at === null`.
   *
   * @returns the updated row when *this* call won the accept, or `null` when
   *   the id is unknown or the invite was already accepted (lost race / reuse).
   *   A real adapter models this as
   *   `UPDATE invites SET accepted_at = ?, updated_at = ? WHERE id = ? AND accepted_at IS NULL`
   *   and reports success from `meta.changes > 0`.
   */
  markAccepted(id: string, at: number): Promise<Invite | null>;
  /** Stamp `revoked_at`; returns the updated row, or `null` if unknown id. */
  revoke(id: string, at: number): Promise<Invite | null>;
  /** All (unconsumed or not) invites for a project, in insertion order. */
  listByProject(projectId: string): Promise<readonly Invite[]>;
}

/**
 * The membership write on acceptance — narrowed to the one operation an accept
 * needs, so this module never depends on the whole `MembershipService`.
 *
 * `MembershipService.addMember`-shaped adapters satisfy this directly (an
 * adapter can wrap the service call with the inviting actor, or bypass the
 * actor check because the domain already authorized the mint). Implementations
 * MUST bind the membership to exactly `(projectId, userId, role)`.
 */
export interface MembershipGrant {
  /**
   * Grant `userId` membership of `projectId` at `role`.
   *
   * Implementations should be idempotent-safe (an upsert on
   * `(project_id, user_id)`), but the invite path calls it at most once per
   * token because the accept itself is single-use.
   */
  grant(input: {
    readonly projectId: string;
    readonly userId: string;
    readonly role: Role;
    readonly now: number;
  }): Promise<void>;
}

/** Successful creation: the record plus the one-and-only plaintext release. */
export interface CreatedInvite {
  /** The persisted record (hash only — verify with `record.tokenHash`). */
  readonly record: Invite;
  /**
   * The plaintext token. Returned here and NOWHERE else; the caller must put it
   * in the invitation link/email immediately and then let it go.
   */
  readonly plaintext: string;
}

/** Options accepted by {@link createInvite}. */
export interface CreateInviteInput {
  readonly projectId: string;
  readonly email: string;
  /** The role the invitee receives on acceptance. */
  readonly role: Role;
  /** The admin/owner minting the invite, for audit. */
  readonly invitedBy?: string | null;
  /** Optional epoch-ms expiry (defaults to `null` = never expires). */
  readonly expiresAt?: number | null;
}

/** Options accepted by {@link acceptInvite}. */
export interface AcceptInviteInput {
  /** The plaintext token from the invitation link. */
  readonly token: string;
  /** The user accepting — the one who receives the membership. */
  readonly userId: string;
}

/** The outcome of a successful {@link acceptInvite}. */
export interface AcceptedInvite {
  /** The consumed invite record (`acceptedAt` now set). */
  readonly invite: Invite;
  /** The project the membership was created in. */
  readonly projectId: string;
  /** The role the membership was created with. */
  readonly role: Role;
  /** The user who received the membership. */
  readonly userId: string;
}

/** Clock seam so tests can make timestamps deterministic. */
export type Clock = () => number;

/** Default wall clock: Unix epoch milliseconds. */
const defaultClock: Clock = () => Date.now();

/** Id seam so tests can make ids deterministic; defaults to a random hex id. */
export type IdFactory = () => string;

/**
 * Default id factory — a 128-bit random hex id.
 *
 * Kept uniform with `identity/tokens.ts` and `identity/user-tokens.ts` so ids
 * are opaque TEXT in the schema.
 */
const defaultId: IdFactory = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Roles a *new* member may be invited at, as a lookup table. `owner` is
 * intentionally excluded: an owner is minted by the founding bootstrap or by an
 * existing owner through `MembershipService`, never handed out via a link.
 */
const INVITABLE_ROLE: Record<string, true> = { member: true, admin: true };

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Mint an invitation.
 *
 * Steps:
 *   1. reject blank project/email and a non-invitable role,
 *   2. mint a random opaque plaintext and its SHA-256 hash (`generateToken` —
 *      the SAME helper device and user tokens use; no hashing is duplicated),
 *   3. build the record — hash only, no plaintext field exists to fill,
 *   4. persist it through the repo,
 *   5. hand the plaintext back exactly once.
 *
 * The inviter's authority (admin/owner) is *not* re-checked here — that belongs
 * to the caller that owns the actor, exactly as `MembershipService` owns its
 * role checks. This function owns the invite's shape and its secret hygiene.
 */
export async function createInvite(
  repo: InviteRepo,
  input: CreateInviteInput,
  now: Clock = defaultClock,
  nextId: IdFactory = defaultId,
): Promise<CreatedInvite> {
  const projectId = input.projectId?.trim();
  const email = input.email?.trim();
  if (!projectId) throw new InviteError("invalid_input", "projectId is required");
  if (!email) throw new InviteError("invalid_input", "email is required");
  if (INVITABLE_ROLE[input.role] !== true) {
    throw new InviteError(
      "invalid_input",
      `cannot invite at role "${String(input.role)}"; expected "member" or "admin"`,
    );
  }

  // One live invite per (project, email): a second mint would leave two usable
  // links for the same seat and no way to tell which one the user clicked.
  const existing = await repo.listByProject(projectId);
  const duplicate = existing.some(
    (row) => row.email.toLowerCase() === email.toLowerCase() && row.acceptedAt === null && row.revokedAt === null,
  );
  if (duplicate) {
    throw new InviteError(
      "already_invited",
      `an active invite already exists for ${email} in ${projectId}`,
    );
  }

  const { plaintext, hash } = await generateToken();
  const at = now();

  const record = await repo.insert({
    id: nextId(),
    projectId,
    role: input.role,
    email,
    tokenHash: hash,
    // A short, non-secret display prefix so the UI can disambiguate rows.
    tokenPrefix: plaintext.slice(0, 7),
    invitedBy: input.invitedBy ?? null,
    expiresAt: input.expiresAt ?? null,
    acceptedAt: null,
    revokedAt: null,
    createdAt: at,
    updatedAt: at,
  });

  // The ONLY place the plaintext is released.
  return { record, plaintext };
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

/**
 * The single read step: hash the presented token and fetch the row it indexes.
 *
 * Private module-internal helper — deliberately NOT exported, so no caller can
 * bypass {@link acceptInvite}'s expiry/revocation/consumption checks.
 */
async function readInviteByToken(repo: InviteRepo, token: string): Promise<Invite | null> {
  const hash = await hashToken(token);
  return repo.findByHash(hash);
}

/**
 * Accept an invitation, creating the invitee's membership.
 *
 * Order of operations — every check runs against the freshly read row, and the
 * *consumption* is the atomic conditional write, so no two accepts can both
 * succeed:
 *
 *   1. hash the token and read the row; unknown → `invalid_invite`,
 *   2. revoked → `invalid_invite`,
 *   3. expired (`expiresAt <= now`) → `invalid_invite`,
 *   4. already consumed → `invalid_invite`,
 *   5. **atomically** stamp `acceptedAt` via {@link InviteRepo.markAccepted};
 *      losing this race (someone accepted between our read and our write) →
 *      `invalid_invite`,
 *   6. grant the membership for the invite's own `(projectId, role)`.
 *
 * The membership grant happens only *after* the accept is won, so a refused
 * accept (expired/revoked/reused/lost-race) never writes a membership. The
 * granted role is the invite's, never anything the accepting caller supplies.
 */
export async function acceptInvite(
  repo: InviteRepo,
  grant: MembershipGrant,
  input: AcceptInviteInput,
  now: Clock = defaultClock,
): Promise<AcceptedInvite> {
  const token = input.token?.trim();
  const userId = input.userId?.trim();
  if (!token) throw new InviteError("invalid_input", "token is required");
  if (!userId) throw new InviteError("invalid_input", "userId is required");

  // One dead-end code for every unusable token: the accept path is not an
  // oracle that distinguishes "never existed" from "used/expired/revoked".
  // Declared (not an arrow const) so TypeScript narrows the checked value away
  // after each call.
  function reject(): never {
    throw new InviteError("invalid_invite", "invite is invalid, expired, revoked or already used");
  }

  const invite = await readInviteByToken(repo, token);
  if (invite === null) reject();
  if (invite.revokedAt !== null) reject();
  if (invite.expiresAt !== null && invite.expiresAt !== undefined && invite.expiresAt <= now()) {
    reject();
  }
  if (invite.acceptedAt !== null) reject();

  // The atomic consume — this is the guard, not the `acceptedAt` check above
  // (which is only a fast path). Exactly one racing caller can win.
  const at = now();
  const accepted = await repo.markAccepted(invite.id, at);
  if (accepted === null) reject();

  // Won the accept: create the membership for the invite's own project/role.
  await grant.grant({
    projectId: accepted.projectId,
    userId,
    role: accepted.role,
    now: at,
  });

  return {
    invite: accepted,
    projectId: accepted.projectId,
    role: accepted.role,
    userId,
  };
}

// ---------------------------------------------------------------------------
// Revocation & listing
// ---------------------------------------------------------------------------

/**
 * Revoke an invite by id.
 *
 * Sets `revoked_at` and returns the updated record, or `null` when the id is
 * unknown. Acceptance of the same token fails from the next call onward.
 */
export async function revokeInvite(
  repo: InviteRepo,
  id: string,
  now: Clock = defaultClock,
): Promise<Invite | null> {
  return repo.revoke(id, now());
}

/**
 * List a project's invites.
 *
 * Returns stored records only — by construction they contain hashes, never
 * plaintext, so listing can never recover a usable link.
 */
export async function listInvites(
  repo: InviteRepo,
  projectId: string,
): Promise<readonly Invite[]> {
  return repo.listByProject(projectId);
}

// ---------------------------------------------------------------------------
// In-memory fake — an honest implementation of the seam, suitable for tests
// and local dev. It keeps exactly the same shape the D1 adapter would persist.
// ---------------------------------------------------------------------------

/** An in-memory `InviteRepo` suitable for tests and local development. */
export class InMemoryInviteRepo implements InviteRepo {
  /** id -> record, insertion-ordered by JS Map semantics. */
  readonly #byId = new Map<string, Invite>();

  /** tokenHash -> id, standing in for `uq_invites_token_hash`. */
  readonly #idByHash = new Map<string, string>();

  /**
   * Snapshot of every stored record.
   *
   * Exposed so tests can dump the store and prove no plaintext is present —
   * that assertion is the point of the seam.
   */
  raw(): readonly Invite[] {
    return Array.from(this.#byId.values());
  }

  async insert(invite: NewInvite): Promise<Invite> {
    if (this.#byId.has(invite.id)) {
      throw new Error(`InMemoryInviteRepo: duplicate id ${invite.id}`);
    }
    if (this.#idByHash.has(invite.tokenHash)) {
      // Models the UNIQUE index on token_hash.
      throw new Error("InMemoryInviteRepo: duplicate token_hash");
    }
    const record: Invite = {
      id: invite.id,
      projectId: invite.projectId,
      role: invite.role,
      email: invite.email,
      tokenHash: invite.tokenHash,
      tokenPrefix: invite.tokenPrefix,
      invitedBy: invite.invitedBy,
      expiresAt: invite.expiresAt,
      acceptedAt: invite.acceptedAt,
      revokedAt: invite.revokedAt,
      createdAt: invite.createdAt,
      updatedAt: invite.updatedAt,
    };
    this.#byId.set(record.id, record);
    this.#idByHash.set(record.tokenHash, record.id);
    return record;
  }

  async findByHash(tokenHash: string): Promise<Invite | null> {
    const id = this.#idByHash.get(tokenHash);
    if (id === undefined) return null;
    return this.#byId.get(id) ?? null;
  }

  /**
   * The conditional consume. The read of the current row and the write of
   * `accepted_at` are in one synchronous section — no `await` between them —
   * so the test-and-set is atomic even under interleaved callers, matching the
   * `WHERE accepted_at IS NULL` a real adapter would run.
   */
  async markAccepted(id: string, at: number): Promise<Invite | null> {
    const existing = this.#byId.get(id);
    if (existing === undefined) return null;
    if (existing.acceptedAt !== null) return null; // already consumed
    const updated: Invite = { ...existing, acceptedAt: at, updatedAt: at };
    this.#byId.set(id, updated);
    return updated;
  }

  async revoke(id: string, at: number): Promise<Invite | null> {
    const existing = this.#byId.get(id);
    if (existing === undefined) return null;
    const updated: Invite = { ...existing, revokedAt: at, updatedAt: at };
    this.#byId.set(id, updated);
    return updated;
  }

  async listByProject(projectId: string): Promise<readonly Invite[]> {
    return this.raw().filter((row) => row.projectId === projectId);
  }
}
