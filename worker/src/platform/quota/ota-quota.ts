/**
 * ota-quota — the SINGLE OTA rate-limit implementation (D2.8 / INV-O2).
 *
 * There used to be two: a sliding-window log inside `firmware/image.ts` and a
 * fixed-window counter inside `platform/durable-objects/project-control.ts`.
 * Two independent budget algorithms for the *same* device and the *same* hour
 * is a correctness bug waiting to happen — they disagree on the window boundary
 * and neither is the other's source of truth. This module is now the one place
 * the OTA budget is defined; both callers consume it and neither re-implements
 * it.
 *
 * ## The rule (D2.8): a fixed one-hour window, per key
 *
 * "Kuota OTA pakai jam server, dihitung di `ProjectDO`" — the budget is a
 * **fixed** window: the first admitted call inside an hour opens the window at
 * the current clock instant and spends one unit; every further admitted call
 * increments usage; the call that would exceed `limitPerHour` is denied and
 * spends **nothing**; and once the clock reaches `windowStart + 1h` the row is
 * reset so the budget is whole again exactly once per hour.
 *
 * The window is *fixed*, not sliding, on purpose: the persisted `ota_quota` row
 * carries only `(windowStart, used)`, so the decision must be derivable from
 * those two numbers and the clock. A sliding log would need unbounded state and
 * a different persistence shape; this is the algorithm the DO schema stores.
 *
 * ## One pure core, two thin consumers
 *
 * {@link decideOtaQuota} is the whole algorithm as a pure function of
 * `(storedRow, now, limitPerHour)` — no clock, no storage, no I/O. Everything
 * else is an adapter:
 *
 *   * `ProjectControl.checkAndConsumeOtaQuota` persists the returned row in the
 *     DO's `ota_quota` table (production, survives restarts);
 *   * {@link MemoryOtaQuota} keeps the same rows in a `Map` and satisfies the
 *     image route's async `consume` seam — used by tests and by any deploy
 *     without a DO binding.
 *
 * Both therefore make *identical* decisions for identical inputs; a divergence
 * is now impossible by construction rather than by two implementations agreeing
 * by hand.
 *
 * ## Keying is the caller's choice — and must be the PRINCIPAL, not a header
 *
 * The algorithm is parameterised by an opaque `key` and knows nothing about
 * where it came from. The OTA image route MUST pass the **verified principal**
 * (the credential's identity), never a client-supplied header: a request header
 * like `x-insight-device` is attacker-controlled, so keying the budget on it
 * lets a caller rotate the header and mint a fresh budget on every request —
 * the quota would be free to bypass. {@link imageQuotaKey} is the one shared
 * function that folds a principal into a stable key so every caller agrees.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The width of one OTA quota window: one hour (D2.8). */
export const OTA_QUOTA_WINDOW_MS = 60 * 60 * 1000;

/**
 * The default OTA budget: admitted image downloads per key per hour.
 *
 * One shared default so the DO path and the image route cannot drift to two
 * different numbers for the same hour.
 */
export const DEFAULT_OTA_QUOTA_PER_HOUR = 60;

// ---------------------------------------------------------------------------
// Row & decision shapes
// ---------------------------------------------------------------------------

/** One key's OTA consumption inside the window it is currently counting. */
export interface OtaQuotaRow {
  /** The opaque budget key (a principal key in production — see `imageQuotaKey`). */
  readonly key: string;
  /** Epoch ms the current hour window opened. */
  readonly windowStart: number;
  /** Units consumed inside that window. */
  readonly used: number;
}

/** The allowance, carrying the row to persist and the fresh usage count. */
export interface OtaQuotaAllowed {
  readonly allowed: true;
  /** Usage after this call, including the unit it just spent. */
  readonly used: number;
  readonly limitPerHour: number;
  readonly windowStart: number;
  /** The row to persist so the next call sees this spend. */
  readonly row: OtaQuotaRow;
}

/** The refusal: usage unchanged, plus a whole-second `retry-after`. */
export interface OtaQuotaDenied {
  readonly allowed: false;
  readonly reason: "quota_exceeded";
  readonly used: number;
  readonly limitPerHour: number;
  readonly windowStart: number;
  /** Whole seconds until the window rolls; `>= 1`, safe as `retry-after`. */
  readonly retryAfter: number;
  /** The row to persist (unchanged usage; keeps the window pinned). */
  readonly row: OtaQuotaRow;
}

/** Discriminated outcome of one OTA budget decision. */
export type OtaQuotaDecision = OtaQuotaAllowed | OtaQuotaDenied;

// ---------------------------------------------------------------------------
// The pure core
// ---------------------------------------------------------------------------

/**
 * The one OTA budget decision: allow-and-spend, or deny with a `retry-after`.
 *
 * Pure: it reads `stored`/`now`/`limitPerHour` and returns the decision plus the
 * row the caller should persist. A `null` `stored` row (first call, or a row
 * whose window has been pruned) is treated as "no window open yet".
 *
 * A **denial spends nothing** — `used` is returned unchanged and the persisted
 * row keeps its `used`, so a caller hammering a throttled route cannot extend
 * its own penalty (the property INV-O2's "tanpa hammer" depends on).
 */
export function decideOtaQuota(
  stored: OtaQuotaRow | null,
  now: number,
  limitPerHour: number,
  key: string,
): OtaQuotaDecision {
  // A window that has reached an hour in age has rolled; a fresh one opens now.
  const rolled = stored === null || now >= stored.windowStart + OTA_QUOTA_WINDOW_MS;
  const windowStart = rolled ? now : stored.windowStart;
  const used = rolled ? 0 : stored.used;
  const row: OtaQuotaRow = { key, windowStart, used };

  if (used >= limitPerHour) {
    const msUntilReset = Math.max(0, windowStart + OTA_QUOTA_WINDOW_MS - now);
    const retryAfter = Math.max(1, Math.ceil(msUntilReset / 1000));
    return {
      allowed: false,
      reason: "quota_exceeded",
      used,
      limitPerHour,
      windowStart,
      retryAfter,
      row,
    };
  }

  const next = row.used + 1;
  return {
    allowed: true,
    used: next,
    limitPerHour,
    windowStart,
    row: { key, windowStart, used: next },
  };
}

// ---------------------------------------------------------------------------
// Principal-keyed identity — the shared key derivation
// ---------------------------------------------------------------------------

/** The minimal shape {@link imageQuotaKey} needs from a resolved principal. */
export interface QuotaPrincipal {
  /** A user/device id when the credential resolves to a stored record. */
  readonly tokenId?: string;
  readonly userId?: string;
  /** The tenant the credential is scoped to. */
  readonly projectId: string;
}

/**
 * Fold a verified principal into the OTA budget key.
 *
 * This is the ONE function every OTA caller uses, so the budget is keyed by the
 * *authenticated* identity and never by a request header a client can rotate:
 *
 *   * a device token id when the credential resolves to one (`tokenId`), so two
 *     tokens on the same project hold separate budgets and one cannot spend the
 *     other's;
 *   * otherwise the user id (a session principal);
 *   * otherwise the project id — the last non-empty identity a credential is
 *     guaranteed to carry, so the key is never the empty string.
 *
 * The `token`/`user` prefixes keep the three families in separate key spaces, so
 * a token id can never collide with a user id of the same spelling.
 */
export function imageQuotaKey(principal: QuotaPrincipal): string {
  const tokenId = principal.tokenId?.trim();
  if (tokenId) return `token:${tokenId}`;
  const userId = principal.userId?.trim();
  if (userId) return `user:${userId}`;
  return `project:${principal.projectId}`;
}

// ---------------------------------------------------------------------------
// In-memory implementation of the async consume seam
// ---------------------------------------------------------------------------

/** A quota denial, with the ready-to-send `retry-after` in whole seconds. */
export interface QuotaExceeded {
  readonly allowed: false;
  /** Whole seconds until the budget frees; `>= 1`, safe as `retry-after`. */
  readonly retryAfter: number;
}

/** A quota admission; nothing else is needed to serve the request. */
export interface QuotaAllowed {
  readonly allowed: true;
}

/** Discriminated outcome of {@link MemoryOtaQuota.consume}. */
export type QuotaDecision = QuotaAllowed | QuotaExceeded;

/** Construction options for {@link MemoryOtaQuota}. */
export interface MemoryOtaQuotaOptions {
  /** Admitted downloads per key per window. Defaults to {@link DEFAULT_OTA_QUOTA_PER_HOUR}. */
  readonly limit?: number;
  /** Window length in ms. Defaults to one hour ({@link OTA_QUOTA_WINDOW_MS}). */
  readonly windowMs?: number;
  /** Clock seam (epoch ms); defaults to `Date.now`, injected for determinism. */
  readonly now?: () => number;
}

/**
 * The in-memory OTA quota — {@link decideOtaQuota} over a `Map` of rows.
 *
 * Deliberately keyed by an opaque `key` and nothing else: two keys never share a
 * counter, so one principal's flood cannot throttle another. A denial records
 * nothing (a denied request is free), and `retryAfter` is the whole-second,
 * rounded-up time until the window rolls — a valid, never-negative
 * `retry-after`. Satisfies the image route's async `consume` seam.
 */
export class MemoryOtaQuota {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #rows = new Map<string, OtaQuotaRow>();

  constructor(options: MemoryOtaQuotaOptions = {}) {
    this.#limit = options.limit ?? DEFAULT_OTA_QUOTA_PER_HOUR;
    this.#windowMs = options.windowMs ?? OTA_QUOTA_WINDOW_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Remaining budget for `key` without consuming any (read-only). */
  remaining(key: string): number {
    const now = this.#now();
    const row = this.#live(key, now);
    return Math.max(0, this.#limit - (row?.used ?? 0));
  }

  /** Drop all state for `key` (e.g. after a credential is revoked). */
  reset(key: string): void {
    this.#rows.delete(key);
  }

  /** Allow-and-record, or deny with a retry hint. */
  async consume(key: string): Promise<QuotaDecision> {
    const now = this.#now();
    const stored = this.#live(key, now);
    const decision = decideOtaQuota(stored, now, this.#limit, key);
    // Persist the row the decision returned — on a denial that row keeps `used`
    // unchanged, so the penalty cannot be extended by hammering.
    this.#rows.set(key, decision.row);
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, retryAfter: decision.retryAfter };
  }

  /** The stored row for `key` with an expired window collapsed to `null`. */
  #live(key: string, now: number): OtaQuotaRow | null {
    const row = this.#rows.get(key);
    if (row === undefined) return null;
    if (now >= row.windowStart + this.#windowMs) return null;
    return row;
  }
}
