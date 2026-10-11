/**
 * dashboards/lock — optimistic concurrency control for dashboard edits.
 *
 * A dashboard is shared mutable state: two operators (or an operator and a
 * background job) can read the same board and then race to write it. A
 * last-writer-wins update silently discards the loser's work; a lock held for
 * the whole read-modify-write cycle would serialise every editor and stall on
 * a client that walked away. The middle path — and the one this module
 * implements — is **optimistic locking**: every update carries the revision it
 * was built from, and the store refuses the write only when that revision is
 * no longer the stored one.
 *
 * ── The precondition: `if_updated_at` ──────────────────────────────────────
 * The revision of a dashboard is its `updated_at` stamp: a monotonically
 * increasing number (epoch milliseconds in production; an injected counter in
 * tests) that {@link DashboardLock.save} **bumps** on every applied write.
 * Because a bump is what makes the next writer's precondition stale, the stamp
 * doubles as the version — no separate `version` column is needed, and a
 * client that only knows "the value I read" has everything it needs:
 *
 *   * `if_updated_at` is required and must be a **finite, non-negative
 *     number** — the exact `updated_at` the writer read. A missing/garbage
 *     precondition is a caller bug and fails {@link DashboardError} code
 *     `missing_precondition` (→ **428 Precondition Required**), *before* any
 *     store access, so a forgotten guard can never degrade into an
 *     unguarded, last-writer-wins write.
 *   * If the board's current `updated_at` **equals** `if_updated_at`, the
 *     patch applies, `updated_at` is bumped to the injected clock's next
 *     value (strictly greater than before; see {@link DashboardLock} on
 *     clock clamping), and the updated board is returned.
 *   * If it **differs** — someone else wrote in between — the write is refused
 *     `409` and nothing is mutated.
 *
 * ── Conflict response shape (documented + tested) ──────────────────────────
 * The refusal is a thrown {@link DashboardError} carrying code
 * `edit_conflict` and `status` `409`, plus two structured fields a client needs
 * to *recover* rather than merely retry blind:
 *
 *   * `expected` — the `if_updated_at` the caller presented (the revision it
 *     read; what it *thought* was current).
 *   * `current`  — the board's live `updated_at`. Note the conflict carries the
 *     *current* revision, so a client can either fetch the board and merge, or
 *     retry immediately with `if_updated_at = current`.
 *
 * Both are exposed three ways, so the shape is unambiguous at every layer:
 *
 *   1. as **fields** on the thrown error (`err.expected` / `err.current`);
 *   2. in the error **message**, as `if_updated_at <expected> != <current>`, so
 *      a log line is self-describing; and
 *   3. as a serialisable **body** via {@link DashboardError.toBody}, the exact
 *      `{ error, message, expected, current }` object a route writes under
 *      `409` — mirroring the `{ error, message }` convention of the other
 *      domains, extended with the two revisions the conflict is about.
 *
 * Unknown ids are {@link DashboardError} code `dashboard_not_found` → `404`
 * (**not** a `409`): "no such board" is a different recovery path from
 * "someone edited it", and conflating the two would hide a missing board behind
 * an endless retry loop.
 *
 * ── Determinism: the clock is a seam, and it never moves backwards ─────────
 * `updated_at` comes from an injected clock (`Date.now` by default). For the
 * precondition to stay meaningful the stamp must **strictly increase** on every
 * applied write; a clock that returns a value `<=` the stored revision (a
 * coarse interval timer, or a test that does not advance) would leave
 * `updated_at` unchanged and let a second stale writer through. Every save
 * therefore stamps `next = max(now, stored + 1)`, so the revision is monotonic
 * by construction regardless of the clock's resolution. Tests pin an
 * increasing counter and assert the bump against its literal values.
 *
 * ── Not here ───────────────────────────────────────────────────────────────
 * This module owns the *rule*, over a storage seam ({@link DashboardRepo}); it
 * is not wired into a Hono route or a Durable Object by this change. Production
 * adapts its dashboard store onto the seam; the in-memory fake below is an
 * honest implementation of it for tests and local dev.
 */

// ---------------------------------------------------------------------------
// Revisions & boards
// ---------------------------------------------------------------------------

/**
 * A dashboard revision: the `updated_at` stamp, and therefore the value an
 * `if_updated_at` precondition is compared against.
 *
 * A non-negative number. It must be a finite, non-negative number to be a valid
 * precondition — see {@link DashboardLock.save}.
 */
export type Revision = number;

/**
 * A stored dashboard board, reduced to the fields concurrency control needs.
 *
 * `updatedAt` is the {@link Revision}: it is bumped on creation and on every
 * applied save, and is the value a writer passes back as `if_updated_at`. The
 * remaining fields are an opaque, caller-owned document (`data`) — this module
 * never inspects it, it only carries it through a successful write.
 */
export interface Dashboard {
  readonly id: string;
  readonly projectId: string;
  /** Opaque, caller-owned board document (layout, widgets, settings, …). */
  readonly data: unknown;
  /** The board's revision; bumped on every applied write. */
  readonly updatedAt: Revision;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable, machine-readable failure codes for the dashboard-lock domain. */
export type DashboardErrorCode =
  | "invalid_input"
  | "missing_precondition"
  | "dashboard_not_found"
  | "edit_conflict";

/**
 * Lookup of a {@link DashboardErrorCode} onto an HTTP status.
 *
 * `edit_conflict` → **409** is the optimistic-lock failure; `missing_precondition`
 * → **428** is the "you forgot the guard" case; `dashboard_not_found` → **404**
 * is deliberately distinct from a conflict.
 */
export const DASHBOARD_STATUS_CODE: Record<DashboardErrorCode, number> = {
  invalid_input: 400,
  missing_precondition: 428,
  dashboard_not_found: 404,
  edit_conflict: 409,
};

/**
 * Error thrown by every failing entry point of this module.
 *
 * `code` is stable and machine-readable; `status` is the HTTP status it maps
 * onto. For an optimistic-lock failure (`edit_conflict`) the two revisions the
 * conflict is about ride along as {@link DashboardError.expected} (the
 * `if_updated_at` the caller presented) and {@link DashboardError.current} (the
 * board's live revision), and {@link DashboardError.toBody} renders the exact
 * `409` body.
 */
export class DashboardError extends Error {
  /** Stable code suitable for mapping onto an HTTP response. */
  readonly code: DashboardErrorCode;

  /** HTTP status corresponding to {@link code}. */
  readonly status: number;

  /** On `edit_conflict`: the caller's `if_updated_at`; else `null`. */
  readonly expected: Revision | null;

  /** On `edit_conflict`: the board's live `updated_at`; else `null`. */
  readonly current: Revision | null;

  constructor(
    code: DashboardErrorCode,
    message: string,
    revisions: { expected?: Revision; current?: Revision } = {},
  ) {
    super(message);
    this.name = "DashboardError";
    this.code = code;
    this.status = DASHBOARD_STATUS_CODE[code];
    this.expected = revisions.expected ?? null;
    this.current = revisions.current ?? null;
  }

  /**
   * The response body for this error: the domain-wide `{ error, message }` pair
   * plus the two revisions (`expected`/`current`), so a client can retry with
   * `if_updated_at = current` or refetch and merge. On a conflict (`409`) it is
   * exactly {@link DashboardConflictBody}; on any other code the revisions are
   * `null`. Asserted verbatim in `test/dashboards/lock.test.ts`, so the shape is
   * a frozen contract.
   */
  toBody(): DashboardErrorBody {
    return {
      error: this.code,
      message: this.message,
      expected: this.expected,
      current: this.current,
    };
  }

  /** True when this error is an optimistic-lock conflict. */
  get isConflict(): boolean {
    return this.code === "edit_conflict";
  }

  /**
   * The conflict body, narrowed — for a caller that has already established
   * `isConflict` (e.g. a route's `if (err.isConflict)` branch) and now needs the
   * two revisions as numbers rather than `number | null`. Throws when called on
   * a non-conflict error, so a mistaken branch fails loudly.
   */
  toConflictBody(): DashboardConflictBody {
    if (!this.isConflict || this.expected === null || this.current === null) {
      throw new Error(`DashboardError.toConflictBody: not a conflict (code ${this.code})`);
    }
    return {
      error: "edit_conflict",
      message: this.message,
      expected: this.expected,
      current: this.current,
    };
  }
}

/**
 * The documented body any {@link DashboardError} renders to: the domain-wide
 * `{ error, message }` pair, extended with the two revisions the error is
 * about (`null` unless it is a conflict).
 */
export interface DashboardErrorBody {
  readonly error: DashboardErrorCode;
  readonly message: string;
  readonly expected: Revision | null;
  readonly current: Revision | null;
}

/**
 * The documented `409` body of an optimistic-lock conflict — the
 * {@link DashboardErrorBody} narrowed to `edit_conflict`, with both revisions
 * always present. This is the shape a client branches on:
 *
 * * `error`    — always `"edit_conflict"`.
 * * `message`  — human-readable, includes both revisions.
 * * `expected` — the `if_updated_at` the caller presented.
 * * `current`  — the board's live `updated_at`.
 */
export interface DashboardConflictBody extends DashboardErrorBody {
  readonly error: "edit_conflict";
  readonly expected: Revision;
  readonly current: Revision;
}

/** Convenience guard for `catch` blocks. */
export function isDashboardError(err: unknown): err is DashboardError {
  return err instanceof DashboardError;
}

/** Convenience guard: is this error an optimistic-lock conflict (409)? */
export function isConflict(err: unknown): err is DashboardError {
  return err instanceof DashboardError && err.isConflict;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The required precondition for an update: the revision the caller read.
 *
 * `if_updated_at` is deliberately **required** — an optional precondition would
 * let a caller omit it and silently get last-writer-wins, which is exactly the
 * race optimistic locking exists to prevent. A missing/garbage value is refused
 * {@link DashboardError} `missing_precondition` (→ 428).
 */
export interface DashboardUpdateInput {
  /** The `updated_at` this update is based on. Required. */
  readonly ifUpdatedAt: Revision;
  /** The new, caller-owned board document to apply on a successful compare. */
  readonly data: unknown;
}

/** Input accepted by {@link DashboardLock.create}. */
export interface CreateDashboardInput {
  readonly id: string;
  readonly projectId: string;
  readonly data: unknown;
}

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

/**
 * Storage seam for dashboards. Implemented by an in-memory fake in tests and by
 * a D1-backed (or DO-backed) adapter in production.
 *
 * The seam is intentionally narrow: this module owns the *rule* (compare, then
 * bump, or refuse) and the store owns *durability*. A production adapter that
 * can express the compare-and-set atomically (e.g. a single conditional
 * `UPDATE … WHERE updated_at = ?`) may implement {@link DashboardRepo.cas} that
 * way and be race-free across processes; the in-memory fake is atomic by dint
 * of JavaScript's single-threaded execution between the read and the write
 * (there is no `await` between them).
 */
export interface DashboardRepo {
  /** Insert a new board. Rejects a duplicate `id` (models the PK). */
  insert(board: Dashboard): Promise<Dashboard>;

  /** The board with this id, or `null`. */
  get(id: string): Promise<Dashboard | null>;

  /**
   * Compare-and-set the board's document.
   *
   * Applies `data` **only** when the stored `updated_at` equals `expectedAt`,
   * in which case it also sets `updated_at = nextUpdatedAt`. Returns the updated
   * board on success, `null` when the stored revision did **not** match (the
   * conflict case — including a revision that changed between the caller's read
   * and this write), and throws for an unknown id (the caller checks existence
   * first).
   */
  cas(
    id: string,
    expectedAt: Revision,
    data: unknown,
    nextUpdatedAt: Revision,
  ): Promise<Dashboard | null>;
}

/** Options accepted by {@link DashboardLock}. */
export interface DashboardLockOptions {
  /** Clock returning the current revision; `Date.now` by default. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Is `value` usable as an `if_updated_at` precondition?
 *
 * A precondition must be a **finite, non-negative number** — the exact stamp a
 * client read. Everything else (`undefined`, `null`, `NaN`, `Infinity`,
 * negatives, strings) is a forgotten or corrupted guard and is refused, so a
 * malformed value can never be treated as "no precondition given ⇒ apply".
 */
export function isRevision(value: unknown): value is Revision {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Optimistic-lock controller for dashboard edits, over a {@link DashboardRepo}.
 *
 * All public methods are async and follow the throw-on-failure convention of the
 * sibling domains: a denial is a typed {@link DashboardError} with a stable
 * `code` (never a `{ ok: false }` result).
 */
export class DashboardLock {
  readonly #repo: DashboardRepo;
  readonly #now: () => number;

  constructor(repo: DashboardRepo, options: DashboardLockOptions = {}) {
    this.#repo = repo;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Create a board at revision 0.
   *
   * The zero revision is a real, presentable precondition: a client that reads
   * a fresh board gets `updated_at: 0` and can guard its first edit with it.
   * Throws `invalid_input` for a blank id/project or a taken id.
   */
  async create(input: CreateDashboardInput): Promise<Dashboard> {
    const id = input.id?.trim();
    if (!id) throw new DashboardError("invalid_input", "dashboard id is required");
    const projectId = input.projectId?.trim();
    if (!projectId) throw new DashboardError("invalid_input", "projectId is required");

    const board: Dashboard = { id, projectId, data: input.data, updatedAt: 0 };
    return this.#repo.insert(board);
  }

  /**
   * Read a board, or throw `dashboard_not_found` (→ 404).
   *
   * The returned board's `updatedAt` is the value to send back as
   * `if_updated_at` on the next {@link DashboardLock.save}.
   */
  async get(id: string): Promise<Dashboard> {
    const board = await this.#repo.get(id);
    if (board === null) {
      throw new DashboardError("dashboard_not_found", `no such dashboard: ${id}`);
    }
    return board;
  }

  /**
   * Apply `data` to a board **iff** its current revision still equals the
   * caller's `ifUpdatedAt`; otherwise refuse `409`.
   *
   * Steps, in order:
   *   1. Validate the precondition ({@link isRevision}). Missing/garbage →
   *      `missing_precondition` (→ 428), before any store access so an
   *      unguarded write can never land.
   *   2. Read the board; unknown id → `dashboard_not_found` (→ 404).
   *   3. If `stored.updatedAt !== ifUpdatedAt` → `edit_conflict` (→ 409),
   *      carrying `expected = ifUpdatedAt` and `current = stored.updatedAt`.
   *      Nothing is mutated.
   *   4. Otherwise compare-and-set with a **strictly greater** stamp
   *      (`max(now, stored + 1)`) and return the updated board.
   */
  async save(id: string, input: DashboardUpdateInput): Promise<Dashboard> {
    const ifUpdatedAt = input?.ifUpdatedAt;
    if (!isRevision(ifUpdatedAt)) {
      const got =
        ifUpdatedAt === undefined
          ? "undefined"
          : ifUpdatedAt === null
            ? "null"
            : `${typeof ifUpdatedAt} ${JSON.stringify(ifUpdatedAt)}`;
      throw new DashboardError(
        "missing_precondition",
        `if_updated_at must be a finite, non-negative number (got ${got})`,
      );
    }

    const stored = await this.#repo.get(id);
    if (stored === null) {
      throw new DashboardError("dashboard_not_found", `no such dashboard: ${id}`);
    }

    if (stored.updatedAt !== ifUpdatedAt) {
      throw new DashboardError(
        "edit_conflict",
        `dashboard ${id} was edited by someone else: if_updated_at ${ifUpdatedAt} != ${stored.updatedAt}`,
        { expected: ifUpdatedAt, current: stored.updatedAt },
      );
    }

    // Strictly greater than the stored revision, whatever the clock's
    // resolution: a non-advancing stamp would leave the board open to the
    // *next* stale writer.
    const next = Math.max(this.#now(), stored.updatedAt + 1);
    const updated = await this.#repo.cas(id, ifUpdatedAt, input.data, next);
    if (updated === null) {
      // The revision matched our READ but no longer matches at the WRITE: a
      // concurrent save slipped in between (the read-then-cas has a TOCTOU
      // window). That is exactly a lost race, so report it as one — re-read the
      // live revision so the conflict carries the *current* value — rather than
      // surface an internal error.
      const live = await this.#repo.get(id);
      const current = live?.updatedAt ?? stored.updatedAt;
      throw new DashboardError(
        "edit_conflict",
        `dashboard ${id} was edited by someone else: if_updated_at ${ifUpdatedAt} != ${current}`,
        { expected: ifUpdatedAt, current },
      );
    }
    return updated;
  }
}

// ---------------------------------------------------------------------------
// In-memory fake — an honest implementation of the seam for tests & local dev
// ---------------------------------------------------------------------------

/**
 * In-memory {@link DashboardRepo}.
 *
 * Models the primary key (`id`) and a compare-and-set that is atomic because
 * there is no `await` between the read of the stored revision and the write of
 * the new one. Not a production store: it never evicts.
 */
export class InMemoryDashboardRepo implements DashboardRepo {
  readonly #byId = new Map<string, Dashboard>();

  /** Every stored board, insertion-ordered. */
  all(): readonly Dashboard[] {
    return Array.from(this.#byId.values());
  }

  async insert(board: Dashboard): Promise<Dashboard> {
    if (this.#byId.has(board.id)) {
      throw new Error(`InMemoryDashboardRepo: duplicate id ${board.id}`);
    }
    this.#byId.set(board.id, board);
    return board;
  }

  async get(id: string): Promise<Dashboard | null> {
    return this.#byId.get(id) ?? null;
  }

  async cas(
    id: string,
    expectedAt: Revision,
    data: unknown,
    nextUpdatedAt: Revision,
  ): Promise<Dashboard | null> {
    const existing = this.#byId.get(id);
    if (existing === undefined) {
      throw new Error(`InMemoryDashboardRepo: cas on unknown id ${id}`);
    }
    // The compare runs against the live revision, and the write immediately
    // follows — no interleaving point between them in single-threaded JS.
    if (existing.updatedAt !== expectedAt) return null;
    const updated: Dashboard = { ...existing, data, updatedAt: nextUpdatedAt };
    this.#byId.set(id, updated);
    return updated;
  }
}
