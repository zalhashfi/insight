/**
 * identity/bootstrap — atomic first-owner claim.
 *
 * Insight is **invite-only**: the very first account to be created is the
 * founding owner, and it may only be created once. After that first user
 * exists every further bootstrap is refused with `409 Conflict` — new humans
 * join through invitations (built on top of this same user store), never by
 * racing the bootstrap endpoint.
 *
 * Design goals
 * ------------
 *   1. Pure & testable: this module has **no** dependency on Cloudflare D1 (or
 *      any driver). It talks to a tiny `UserRepo` seam (below) so the
 *      concurrency contract can be exercised against an in-memory fake.
 *   2. Atomic claim: the "am I first?" check and the owner insert are a single
 *      atomic step. Of N concurrent callers exactly one wins; every other
 *      caller observes the committed row and loses with a `409`. Two owners
 *      are therefore impossible — no matter how callers interleave.
 *   3. Idempotent refusal: once an owner exists, `bootstrapOwner` returns
 *      `{ ok:false, status:409 }` and writes nothing.
 *
 * Why the pre-check does not make the race safe by itself
 * -------------------------------------------------------
 * A naive implementation reads the user count, then inserts when it saw zero:
 *
 * ```ts
 * if ((await repo.countUsers()) === 0) await repo.insertOwner(owner); // RACY
 * ```
 *
 * Two callers can both read `0` (the fake — and any real DB under an isolating
 * async runtime — yields between the read and the write), both then insert, and
 * the instance is left with two owners. The guard has to live in the *write*,
 * which is what `UserRepo.insertOwner` guarantees below: it is the atomic
 * test-and-set the whole contract rests on.
 */

/**
 * Minimal seam onto the user store (Cloudflare D1 or a test fake).
 *
 * Deliberately smaller than `D1Database`: bootstrap only needs to count users
 * and to attempt an atomic first-owner insert. A real D1 binding satisfies
 * this by wrapping `db.prepare(sql).bind(...params).run()`, e.g.:
 *
 * ```ts
 * const repo: UserRepo = {
 *   async countUsers() {
 *     const r = await db.prepare("SELECT COUNT(*) AS n FROM users").first();
 *     return Number(r?.n ?? 0);
 *   },
 *   async insertOwner(owner) {
 *     const r = await db
 *       .prepare(
 *         "INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) " +
 *           "VALUES (?, ?, ?, ?, ?)",
 *       )
 *       .bind(owner.id, owner.email, owner.name ?? null, owner.now, owner.now)
 *       .run();
 *     return (r.meta?.changes ?? 0) > 0;
 *   },
 * };
 * ```
 */
export interface UserRepo {
  /**
   * Number of users currently in the store. `0` means the instance is empty
   * and still bootstrappable.
   */
  countUsers(): Promise<number>;

  /**
   * Atomically insert `owner` **only if the store has no users yet**.
   *
   * This is the single-writer claim: under concurrency exactly one caller can
   * observe `true`; every other caller (racing or not) observes `false` and
   * must not consider itself the owner. The implementation must be atomic —
   * an `INSERT ... SELECT ... WHERE NOT EXISTS`, a unique `singleton`/`id = 1`
   * guard row, or an `INSERT OR IGNORE` gated on emptiness all qualify.
   *
   * @returns `true` when this call created the owner, `false` when a user
   *          already existed (whether it was committed earlier or by a
   *          concurrent winner).
   */
  insertOwner(owner: NewOwner): Promise<boolean>;
}

/** The founding owner's details, as handed to {@link UserRepo.insertOwner}. */
export interface NewOwner {
  /** Application-generated identifier (ULID/UUID). */
  readonly id: string;
  /** Login email. Unique across `users`. */
  readonly email: string;
  /** Display name, if known. */
  readonly name?: string;
  /** Creation timestamp (Unix epoch milliseconds, UTC). */
  readonly createdAt: number;
}

/** Input accepted by {@link bootstrapOwner}. */
export interface BootstrapInput {
  /** Login email for the founding owner. */
  readonly email: string;
  /** Display name, if known. */
  readonly name?: string;
  /** Stable id generator seam (defaults to a ULID-ish random id). */
  readonly generateId?: () => string;
  /** Clock seam for `createdAt` (defaults to `Date.now`). */
  readonly now?: () => number;
}

/** `bootstrapOwner` succeeded: this caller created the founding owner. */
export interface BootstrapCreated {
  readonly ok: true;
  /** The persisted owner (echoes back the id/email/timestamp that were written). */
  readonly owner: {
    readonly id: string;
    readonly email: string;
    readonly name?: string;
    readonly createdAt: number;
  };
}

/**
 * The instance already has a user (or a concurrent caller just won). Nothing
 * was written. `409 Conflict`, because bootstrap is a one-shot, invite-only
 * resource that is gone forever once claimed — the same semantics the HTTP
 * layer should project.
 */
export interface BootstrapConflict {
  readonly ok: false;
  readonly status: 409;
  readonly error: "already_initialized";
  readonly message: string;
}

/** Discriminated result of {@link bootstrapOwner}. */
export type BootstrapResult = BootstrapCreated | BootstrapConflict;

/** The single conflict body, so every refusal reads identically. */
const CONFLICT: BootstrapConflict = Object.freeze({
  ok: false,
  status: 409,
  error: "already_initialized",
  message: "instance already has a user; bootstrap is closed (invite-only)",
});

/**
 * Claim the founding owner of an empty instance.
 *
 * Contract
 * --------
 *   * **Empty instance** — exactly one caller creates the owner and returns
 *     `{ ok:true, owner }`. Under `Promise.all` concurrency the other callers
 *     get `{ ok:false, status:409 }`; the store ends up with **one** user.
 *   * **Non-empty instance** — returns `{ ok:false, status:409 }` and writes
 *     nothing, without ever calling `insertOwner`.
 *
 * The pre-check below is only a fast path for the common "already claimed"
 * case; it is deliberately *not* the guard. The guard is `insertOwner`'s
 * atomic empties-only insert, so the read and the write need no mutual
 * exclusion and a loser that slipped past the pre-check still cannot create a
 * second owner.
 *
 * @param repo  the user-store seam (real D1-backed repo or a fake)
 * @param input founding-owner details plus optional id/clock seams
 */
export async function bootstrapOwner(
  repo: UserRepo,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  // Fast path: a committed user means bootstrap is closed. Cheap and safe —
  // if we wrongly see 0 here the atomic insert below still decides the race.
  if ((await repo.countUsers()) > 0) {
    return CONFLICT;
  }

  const now = input.now ?? (() => Date.now());
  // `crypto.randomUUID` exists on Workers and on Node/Bun 18+; ids are opaque
  // to bootstrap, so any unique string is fine.
  const generateId = input.generateId ?? (() => crypto.randomUUID());

  const owner: NewOwner = {
    id: generateId(),
    email: input.email,
    ...(input.name === undefined ? {} : { name: input.name }),
    createdAt: now(),
  };

  // The atomic claim. `true` => we are the one and only first owner.
  const won = await repo.insertOwner(owner);

  if (!won) {
    // A user exists after all: either it was committed before our read, or a
    // concurrent caller beat us between our read and our insert. Either way we
    // created nothing and the instance is invite-only from here on.
    return CONFLICT;
  }

  return {
    ok: true,
    owner: {
      id: owner.id,
      email: owner.email,
      ...(owner.name === undefined ? {} : { name: owner.name }),
      createdAt: owner.createdAt,
    },
  };
}
