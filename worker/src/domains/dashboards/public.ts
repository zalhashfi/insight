/**
 * dashboards/public — the public, read-only shared-dashboard surface.
 *
 * A dashboard can be **shared** with someone who has no account: a public URL
 * that carries a `share token`. That token is the whole credential, so this
 * module is written as if every shared link were hostile — because a shared
 * link is exactly the artefact that gets pasted into a chat, emailed on, or
 * posted publicly, and it never expires on its own.
 *
 * ## The one invariant: an allow-list, enforced at the server (§D4.3 / INV-D2)
 *
 * The deciding rule for a shared dashboard is **D4.3**: what a public viewer
 * may see is an *explicit allow-list derived from the layout*, filtered **on
 * the server**, and **fail-closed** — anything not named by the layout is not
 * sent. This is the fix for `INV-D2` (no leakage of data outside the layout).
 *
 * "Fail-closed" is load-bearing and shapes the whole module:
 *
 *   * The filter runs **server-side**, on the finished payload, immediately
 *     before serialisation. It is the last thing that touches the bytes a
 *     viewer receives, so there is no code path that produces a public payload
 *     the filter did not see.
 *   * A point is admitted **only** when its variable is a member of the layout's
 *     allow-list. Membership is a `Set` lookup, not a pattern, so a variable
 *     whose name merely *resembles* an entry (a superstring, a different case,
 *     a homoglyph) is not admitted. An entry that names nothing matches nothing;
 *     it never widens the filter.
 *   * Undefined is a **denial**, never a convenience: a token that does not
 *     resolve, an expired or revoked share, an unknown variable, a shape the
 *     filter cannot read — each is refused rather than passed through. There is
 *     deliberately no "if we cannot tell, send it anyway" branch anywhere here.
 *
 * The consequence `ST-D2` asserts is direct: a project that also holds
 * `secret_token`, with a layout that names only `temp`, yields payloads in
 * which `secret_token` **never appears** — not in the initial snapshot, not in
 * any live frame. The filter is applied to *both*, from the same allow-list, so
 * the two can never disagree.
 *
 * ## Read-only, and read-only *by construction*
 *
 * A share token grants reading and nothing else. This module therefore exposes
 * no mutating operation at all — there is no create/save/delete here, and the
 * public surface cannot be reached through {@link DashboardLock} or a repo. The
 * `read_only` scope on the resolved share (see {@link ShareScope}) is the second
 * lock on the same door: {@link PublicDashboard.writable} is **always** `false`,
 * and {@link PublicDashboard.assertReadOnly} throws {@link PublicDashboardError}
 * code `read_only` for any attempted write, so a caller that tries to mutate
 * through a share is refused with a stable, testable code rather than by
 * omission. Two independent reasons a share can never write is the intended
 * redundancy: the absence of a write path cannot regress by accident, and the
 * explicit refusal documents the intent where a route would look for it.
 *
 * ## Refusals are uniform (no oracle)
 *
 * A bad token and an expired/revoked token are the *same* refusal: NOT_FOUND
 * (404) with the same body. Distinguishing them would turn the public endpoint
 * into an oracle that confirms whether a guessed token ever existed, and the
 * existing credential surfaces of this codebase are deliberately
 * indistinguishable for the same reason (see `resolve-project`). `NOT_FOUND`
 * rather than `UNAUTHORIZED` also matches the resource semantics of a shared
 * URL: an absent/expired share is "no such dashboard", not "you failed to
 * authenticate". A *presented* credential that a caller tries to use to write
 * is the one case answered `UNAUTHORIZED` (401) — the share is valid for
 * reading, and this operation is not that.
 *
 * ## Snapshots and streams share one filter
 *
 * Both the initial snapshot and the live stream are produced by
 * {@link PublicDashboard.snapshot} / {@link PublicDashboard.filterFrame}, and
 * both go through the *one* private filter. The live path is the dangerous one:
 * a stream keeps emitting after the initial read, so a filter applied only to
 * the snapshot would leak every subsequent change. Here a frame whose variable
 * is outside the layout is **dropped** (returns `null`), not redacted, so a live
 * subscription can be wired to it without any further judgement.
 *
 * ## Not here
 *
 * This module owns the *rule* (resolve → allow-list → filter → serve) over
 * injected seams. It does not define an HTTP route, and it does not re-implement
 * the fan-out — {@link ProjectionSource} is structurally the same seam
 * `DashboardDO` already consumes, so production drives both with one adapter.
 * The `/embed/:token` surface (A33) and the 30 s/5 s cache are later tasks; this
 * is the filtering core they will stand on.
 */

// ---------------------------------------------------------------------------
// Layout & allow-list
// ---------------------------------------------------------------------------

/**
 * A dashboard layout, reduced to what the public filter needs: the variables it
 * names.
 *
 * The stored layout is a caller-owned document (widgets, settings, …) that this
 * module never inspects beyond one field, exactly as the lock treats a board as
 * opaque. `variables` is the **allow-list**: the complete set of variables a
 * viewer of this layout may see. Everything else a project holds is invisible
 * to the public surface, whether or not a widget references it — the layout is
 * the authority, not the data.
 *
 * The list is optional so a layout that names nothing is expressible: it is
 * then an **empty** allow-list, which admits nothing. A missing list and an
 * empty list therefore mean the same thing — no public variables — which is the
 * fail-closed reading a malformed layout deserves.
 */
export interface DashboardLayout {
  readonly id: string;
  /** The variables this layout exposes publicly. Absent ⇒ an empty allow-list. */
  readonly variables?: readonly string[];
}

/**
 * A share token, reduced to what resolution needs.
 *
 * `tokenHash` is the SHA-256 hex digest of the plaintext share secret — the
 * same convention as project/user tokens (`platform/lib/tokens.ts`): the
 * plaintext is a bearer string held only by the client and is never stored, so
 * a store can only ever be indexed by its digest. Hashing here (rather than
 * comparing plaintexts) keeps a leaked share store from being a leaked set of
 * usable links.
 *
 * `expiresAt` and `revokedAt` mirror the token vocabulary of the identit domain:
 * `expiresAt === null` is "never expires"; any `expiresAt <= now` is expired.
 * Revocation is a timestamp so the same row can express "was usable until then",
 * and it is checked with the same immediate effect as a revoked device token.
 */
export interface Share {
  readonly id: string;
  readonly tokenHash: string;
  readonly projectId: string;
  readonly layoutId: string;
  /** Epoch ms after which the share is dead; `null` ⇒ never expires. */
  readonly expiresAt: number | null;
  /** Epoch ms at which the share was revoked; `null` while usable. */
  readonly revokedAt: number | null;
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Resolves a presented plaintext share token to its record, or `null`.
 *
 * A `null` return is the single "not usable" answer: unknown token, expired,
 * revoked — the resolver may collapse them (as production does, by digesting
 * the plaintext and looking up one row) and this module **re-checks expiry and
 * revocation itself** from the returned record, so a resolver's omission cannot
 * open the door. The digest is recomputed here too, so a token that does not
 * hash to the record's `tokenHash` is refused even if a resolver returned the
 * wrong row.
 */
export type ShareResolver = (presentedToken: string) => Promise<Share | null>;

/** Reads a layout by id, or `null` when it does not exist. */
export type LayoutLookup = (layoutId: string) => Promise<DashboardLayout | null>;

/**
 * Reads a bounded snapshot of a project's projection.
 *
 * Structurally identical to `DashboardDO`'s `ProjectionSource.snapshot`, minus
 * the cursor (a public snapshot is a still picture; the live path is a separate
 * frame sink). Kept as its own narrow type so this module depends on one read
 * and nothing else of the fan-out.
 */
export interface ProjectionSource {
  /** The current projection, newest first, capped at `limit` points. */
  snapshot(projectId: string, limit: number): Promise<readonly Point[]>;
}

/** A projected reading: the shape the public payload exposes, and no more. */
export interface Point {
  readonly device: string;
  readonly variable: string;
  readonly value: number | null;
  readonly ts: number;
  readonly seq: number;
}

/** A live update handed to a public subscriber. Structurally a {@link Point}. */
export type StreamFrame = Point;

/** The hash function used to fold a plaintext share token to its digest. */
export type TokenHasher = (plaintext: string) => Promise<string>;

/** A clock returning Unix epoch milliseconds. */
export type Clock = () => number;

/** Construction options for {@link PublicDashboard}. */
export interface PublicDashboardOptions {
  readonly shares: ShareResolver;
  readonly layouts: LayoutLookup;
  readonly projection: ProjectionSource;
  /**
   * SHA-256 hex hasher; defaults to WebCrypto (`crypto.subtle`). Injected so a
   * test can pin digests without an async digest in its own body, and so a
   * non-WebCrypto runtime can supply its own.
   */
  readonly hash?: TokenHasher;
  /** Clock seam; the ONLY source of "now" for expiry. Defaults to `Date.now`. */
  readonly now?: Clock;
  /** Points per snapshot; defaults to {@link DEFAULT_PUBLIC_SNAPSHOT_POINTS}. */
  readonly snapshotLimit?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Points in a public snapshot by default.
 *
 * A public dashboard paints from its snapshot, so it wants a useful recent
 * window; 300 is the fan-out's own ceiling (`SNAPSHOT_MAX_POINTS`) and keeping
 * the public default equal to it means the public view cannot be *wider* than
 * the authenticated one. A caller that wants less passes `snapshotLimit`.
 * (Note this bounds *points*, not variables: the allow-list is what hides data,
 * the limit is only how much of the visible data is sent at once.)
 */
export const DEFAULT_PUBLIC_SNAPSHOT_POINTS = 300;

/** Default SHA-256 hex hasher, matching the token modules of this codebase. */
const defaultHasher: TokenHasher = async (plaintext) => {
  const data = new TextEncoder().encode(plaintext);
  const digest = await crypto.subtle.digest("SHA-256", data);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

/** Default wall clock: Unix epoch milliseconds. */
const defaultClock: Clock = () => Date.now();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Stable, machine-readable failure codes for the public dashboard surface.
 *
 *   * `not_found` — no usable share (unknown, expired, revoked, or one whose
 *     layout is gone). Maps to `404`. The code is deliberately singular: the
 *     refusal does not say *which* of those it was, so the endpoint is not an
 *     oracle for guessed tokens.
 *   * `invalid_input` — the caller presented nothing usable (an empty token).
 *     Also `404` (see {@link PUBLIC_STATUS_CODE}), because "you gave me a
 *     blank token" and "that token is not valid" must be indistinguishable to
 *     an anonymous caller.
 *   * `read_only` — a write was attempted through a public share. Maps to `401`:
 *     the *share* is fine, this operation is not one a share may perform. The
 *     only code this module ever answers `401` for a *presented* credential.
 */
export type PublicDashboardErrorCode = "not_found" | "invalid_input" | "read_only";

/**
 * Lookup of {@link PublicDashboardErrorCode} onto an HTTP status.
 *
 * `not_found`/`invalid_input` → **404** (a missing share and a blank token are
 * the same answer to a stranger) and `read_only` → **401** (the credential is
 * real but may not do this). Frozen here, and asserted verbatim in
 * `test/dashboards/public.test.ts`, so the mapping is a contract rather than a
 * scatter of literals in a route.
 */
export const PUBLIC_STATUS_CODE: Record<PublicDashboardErrorCode, number> = {
  not_found: 404,
  invalid_input: 404,
  read_only: 401,
};

/**
 * The documented body of every public-dashboard refusal: the domain-wide
 * `{ error, message }` pair. No share token, digest or project id ever appears
 * in a message — a refusal that echoed the credential it rejected would defeat
 * the uniform-answer rule the codes exist to keep.
 */
export interface PublicDashboardErrorBody {
  readonly error: PublicDashboardErrorCode;
  readonly message: string;
}

/**
 * Error thrown by every failing entry point of this module.
 *
 * `code` is stable and machine-readable; `status` is the HTTP status it maps
 * onto. The module follows the throw-on-failure convention of the sibling
 * dashboard domain ({@link DashboardError}): a denial is a typed error, never a
 * `{ ok: false }` result a caller could forget to branch on.
 */
export class PublicDashboardError extends Error {
  /** Stable code suitable for mapping onto an HTTP response. */
  readonly code: PublicDashboardErrorCode;

  /** HTTP status corresponding to {@link code}. */
  readonly status: number;

  constructor(code: PublicDashboardErrorCode, message: string) {
    super(message);
    this.name = "PublicDashboardError";
    this.code = code;
    this.status = PUBLIC_STATUS_CODE[code];
  }

  /** The response body for this refusal: `{ error, message }`. */
  toBody(): PublicDashboardErrorBody {
    return { error: this.code, message: this.message };
  }
}

/** Convenience guard for `catch` blocks. */
export function isPublicDashboardError(err: unknown): err is PublicDashboardError {
  return err instanceof PublicDashboardError;
}

// ---------------------------------------------------------------------------
// Resolved view
// ---------------------------------------------------------------------------

/**
 * The scope a resolved share grants. Deliberately a single-valued union: there
 * is no `write` member, so "a share that may write" is not expressible in the
 * type system, let alone reachable at runtime.
 */
export type ShareScope = "read_only";

/**
 * The public, filtered view of one project — what a share token resolves to and
 * everything a public route needs.
 *
 * The value is minted only by {@link PublicDashboard.resolve}, so it cannot be
 * constructed with a wide scope or a layout it did not resolve to. It carries:
 *
 *   * `projectId` / `layoutId` — the tenant and the layout this view is bound to;
 *   * `variables` — the **allow-list**, as a frozen array for a caller that
 *     wants to echo the layout;
 *   * `scope` — always `read_only`;
 *   * `writable` — always `false`; and
 *   * the filtered reads, {@link snapshot} and {@link filterFrame}, each of
 *     which re-checks the allow-list rather than trusting a caller to have done
 *     so.
 *
 * `snapshot()` re-reads the projection on every call, so a long-lived view
 * cannot serve stale data — and, more importantly, cannot serve rows published
 * after it was minted but filtered with an allow-list that has since been
 * narrowed.
 */
export interface PublicDashboard {
  readonly projectId: string;
  readonly layoutId: string;
  /** The allow-list, frozen. Empty when the layout names no variables. */
  readonly variables: readonly string[];
  readonly scope: ShareScope;
  /** Always `false`; a public view is never writable. */
  readonly writable: false;
  /** A bounded, allow-list-filtered snapshot of the project's projection. */
  snapshot(): Promise<readonly Point[]>;
  /** The frame to deliver for `point`, or `null` when it is not public. */
  filterFrame(point: Point): StreamFrame | null;
  /** Refuse (throw `read_only`) any attempted write through this view. */
  assertReadOnly(op: string): never;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Fold a layout into its allow-list: a `Set` of the variables it names.
 *
 * Membership is exact string equality, which is the whole point — a `Set` does
 * not match `temp_high` for an entry `temp`, does not fold case, and does not
 * treat an entry as a pattern. A layout with no `variables`, a `null` element,
 * or a non-string element contributes nothing: an entry that is not a usable
 * variable name cannot widen the filter. The result is therefore a **closed**
 * allow-list: only the names it literally contains are public.
 */
export function allowList(layout: DashboardLayout): ReadonlySet<string> {
  const set = new Set<string>();
  const names = layout?.variables;
  if (!Array.isArray(names)) return set; // fail-closed: no list ⇒ nothing public
  for (const name of names) {
    if (typeof name === "string" && name.length > 0) set.add(name);
  }
  return set;
}

/**
 * Is `point` a well-formed projected reading?
 *
 * The filter needs a `variable` it can compare; a payload missing one (a
 * malformed row from a store, or a junk object a caller passed as a frame) is
 * not something the filter can *admit*, and admitting what it cannot inspect
 * would be the leak this module exists to prevent. So a shape the filter cannot
 * read is dropped, fail-closed — a nullish point, or one whose `variable` is not
 * a non-empty string, is not public.
 */
function isPoint(point: unknown): point is Point {
  if (typeof point !== "object" || point === null) return false;
  if (!("variable" in point)) return false;
  const { variable } = point;
  return typeof variable === "string" && variable.length > 0;
}

/**
 * Apply the allow-list to one candidate point: the point when its variable is
 * public, otherwise `null`.
 *
 * This is the single filter both the snapshot and the stream pass through, so
 * "public" is defined in exactly one place. It returns the point **unchanged**
 * on admission (no field-level redaction): the allow-list is a whole-variable
 * decision, so an admitted point is sent as-is, and a point outside the list is
 * dropped, never partially sent.
 */
export function filterPoint(
  allow: ReadonlySet<string>,
  point: unknown,
): Point | null {
  if (!isPoint(point)) return null;
  return allow.has(point.variable) ? point : null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * The public shared-dashboard service, over injected seams.
 *
 * Construct with {@link PublicDashboardOptions}, then:
 *
 *   * {@link PublicDashboard.resolve} — turn a presented share token into a
 *     filtered {@link PublicDashboard} view, or throw
 *     `not_found`/`invalid_input`. This is the only way to obtain a view.
 *   * the returned view's `snapshot()` / `filterFrame()` — the reads a public
 *     route serves, both already allow-listed.
 *
 * All public methods are async (resolution and reads touch seams) and follow
 * the throw-on-failure convention: a denial is a typed
 * {@link PublicDashboardError}, never a permissive default.
 */
export class PublicDashboardService {
  readonly #shares: ShareResolver;
  readonly #layouts: LayoutLookup;
  readonly #projection: ProjectionSource;
  readonly #hash: TokenHasher;
  readonly #now: Clock;
  readonly #snapshotLimit: number;

  constructor(options: PublicDashboardOptions) {
    this.#shares = options.shares;
    this.#layouts = options.layouts;
    this.#projection = options.projection;
    this.#hash = options.hash ?? defaultHasher;
    this.#now = options.now ?? defaultClock;
    this.#snapshotLimit = options.snapshotLimit ?? DEFAULT_PUBLIC_SNAPSHOT_POINTS;
    if (!Number.isInteger(this.#snapshotLimit) || this.#snapshotLimit <= 0) {
      // A non-positive limit would ask the projection for "no points" and make
      // every snapshot empty — a silent blackout rather than a loud mistake.
      throw new RangeError(
        `PublicDashboard: snapshotLimit must be a positive integer (got ${this.#snapshotLimit})`,
      );
    }
  }

  /**
   * Resolve a presented share token into a read-only, allow-listed view.
   *
   * The order is a decision sequence, each step fail-closed:
   *
   *   1. A blank token is `invalid_input` (→ 404). There is nothing to hash and
   *      pretending otherwise would reach a store with `""`.
   *   2. The token is folded to its SHA-256 digest and looked up. No row — or a
   *      row whose `tokenHash` disagrees with the presented token's digest — is
   *      `not_found` (→ 404): a resolver that returned a neighbouring row must
   *      not be able to hand out a share that the token did not authenticate.
   *   3. An **expired** or **revoked** share is `not_found` (→ 404), checked
   *      here from the record itself (never delegated to the resolver), with the
   *      same uniform answer as step 2 so a stranger cannot tell "expired" from
   *      "never existed".
   *   4. The layout is read by `layoutId`. A share whose layout is missing is
   *      `not_found` (→ 404), **not** an empty dashboard: a layout pointer that
   *      resolves to nothing is a broken share, and a broken share must not
   *      degrade into a working (or, worse, wider) one.
   *   5. The layout is folded to its allow-list ({@link allowList}) and the
   *      read-only view is minted over it.
   *
   * Every refusal is uniform at the wire (`404`, `{ error: "not_found" }`), so
   * the public endpoint confirms nothing about a guessed token.
   *
   * @throws PublicDashboardError `invalid_input` for a blank token; `not_found`
   *   for unknown/expired/revoked/token-mismatch/missing-layout.
   */
  async resolve(presentedToken: string): Promise<PublicDashboard> {
    if (typeof presentedToken !== "string" || presentedToken.trim().length === 0) {
      throw new PublicDashboardError("invalid_input", "a share token is required");
    }

    const digest = await this.#hash(presentedToken);
    const share = await this.#shares(presentedToken);

    // One uniform refusal for every "no usable share" case below: unknown token,
    // a resolver that returned a row for a *different* token, an expired or
    // revoked share, or a share whose layout is gone. The message and code are
    // fixed, so a stranger cannot tell the conditions apart — no oracle. Declared
    // with a `never` return type so each call site narrows (a `never`-returning
    // call is treated as unreachable for control flow).
    const refuse: () => never = () => {
      throw new PublicDashboardError("not_found", "no such shared dashboard");
    };

    if (share === null || typeof share !== "object" || share.tokenHash !== digest) {
      refuse();
    }

    const now = this.#now();
    if (share.revokedAt !== null || share.expiresAt !== null && share.expiresAt <= now) {
      refuse();
    }

    const layout = await this.#layouts(share.layoutId);
    if (layout === null || typeof layout !== "object") {
      refuse();
    }

    return this.#view(share.projectId, layout);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Mint the read-only view over a resolved project + layout.
   *
   * The allow-list is captured once, here, as an immutable `Set`, and both reads
   * close over *that same set* — so the snapshot and the stream can never use
   * different filters. `variables` is a frozen copy for callers that want to
   * echo the layout; it is a view of the allow-list, not an authority the reads
   * consult, so mutating it (which the freeze prevents) could not widen a read
   * anyway.
   */
  #view(projectId: string, layout: DashboardLayout): PublicDashboard {
    const allow = allowList(layout);
    const variables = Object.freeze([...allow]);
    const projection = this.#projection;
    const limit = this.#snapshotLimit;

    return {
      projectId,
      layoutId: layout.id,
      variables,
      scope: "read_only",
      writable: false,

      /**
       * A bounded snapshot, filtered through the allow-list. The projection is
       * read fresh on each call (a public snapshot is a live read, not a cached
       * one), then every point is passed through the *one* filter — so a
       * variable outside the layout is absent from the snapshot by the same rule
       * that drops it from a frame.
       */
      async snapshot(): Promise<readonly Point[]> {
        const points = await projection.snapshot(projectId, limit);
        const out: Point[] = [];
        for (const point of points) {
          const admitted = filterPoint(allow, point);
          if (admitted !== null) out.push(admitted);
        }
        return out;
      },

      /**
       * The frame to deliver for `point`, or `null` when it is not public.
       *
       * Returning `null` (rather than throwing) is the deliberate shape for a
       * high-rate stream: "this change is not for you" is the *normal* case for
       * a public subscriber of a project with private variables, so it is a
       * drop, not an error. A live subscription is wired straight to this and
       * has no further decision to make.
       */
      filterFrame(point: Point): StreamFrame | null {
        return filterPoint(allow, point);
      },

      /**
       * Refuse any write through a public share. Always throws; the return type
       * is `never` so a caller that reaches for a mutation cannot proceed.
       */
      assertReadOnly(op: string): never {
        throw new PublicDashboardError(
          "read_only",
          `public share is read-only; cannot ${op}`,
        );
      },
    };
  }
}
