/**
 * Per-project-token ingress rate limiter for the device-facing routes.
 *
 * Scope
 * -----
 * A single, reusable limiter that a route (telemetry ingest in A08, OTA in
 * M3/A18) CAN compose — it is deliberately NOT wired into any route here, so
 * the policy is a standalone, fully-testable unit. The seam is `checkAndConsume`
 * keyed by an opaque string (the presented project token), so the caller decides
 * what a "key" is (token, token+device, token+route, …); the limiter itself
 * never parses credentials.
 *
 * Algorithm — SLIDING WINDOW LOG (documented, deterministic)
 * ---------------------------------------------------------
 * For each key we keep the timestamps at which it was allowed. A check at
 * instant `now` first *prunes* every recorded timestamp `t` with
 * `now - t >= windowMs` (those samples have left the window), then:
 *
 *   * if fewer than `limit` samples remain, the new request is ALLOWED and its
 *     timestamp is recorded;
 *   * otherwise it is DENIED and nothing is recorded (a denied request consumes
 *     no budget — retries during a burst cannot extend the penalty).
 *
 * This is a true sliding window: there is no fixed bucket boundary, so a burst
 * spread across a wall-clock minute boundary can never be double-counted, and
 * the exact `retry-after` is computable — it is the time until the OLDEST
 * surviving sample leaves the window, i.e. `windowMs - (now - oldest)`.
 *
 * Determinism
 * -----------
 * The clock is an injected {@link Clock} seam (`() => number`, epoch ms) — the
 * SAME seam shape the telemetry route already uses. The limiter reads it exactly
 * once per `checkAndConsume` call and never calls `Date.now()` itself, so a test
 * with a fixed-then-advanced clock observes byte-identical decisions. Time is
 * assumed monotonic across a single limiter instance; a backwards clock simply
 * makes the window look empty (fail-open on the window, never a throw).
 *
 * Response contract
 * -----------------
 * On denial the limiter produces a {@link RateLimitDecision} whose
 * {@link RateLimited.error} is frozen to `"rate_limited"` and whose status is
 * `429` — matching `test/contracts/contract-lock.ts`
 * (`CONTRACT_ERRORS.rate_limited.status === STATUS.tooManyRequests`). The
 * decision carries a ready-to-send `headers` object with `retry-after` in
 * whole seconds per RFC 9110 (a positive integer, rounded UP so a client that
 * honours it never retries a moment too early).
 *
 * Extension seam
 * --------------
 * {@link rateLimitedBody} produces the exact `{ error, message }` body the other
 * device routes use, and the limiter's decision carries a ready-to-send
 * `headers` object (the `retry-after`), so a route can compose the limiter
 * without reaching into its internals. Nothing else in this module touches HTTP.
 *
 * Public surface (kept deliberately small)
 * ----------------------------------------
 * Only what a caller actually composes is exported: {@link RateLimiter},
 * {@link RateLimiterOptions}, {@link RateLimitPolicy}, the {@link Clock} seam,
 * the {@link RateLimitDecision} union (with its two arms), the frozen
 * {@link RATE_LIMITED_CODE} / {@link RATE_LIMITED_STATUS} /
 * {@link RETRY_AFTER_HEADER} contract constants, {@link rateLimitedBody} and the
 * shared {@link defaultRateLimiter}. The body's `RateLimitedBody` type alias,
 * the default `429` message and the per-key sample-cap default are
 * implementation details: they were previously `export`ed but had no consumer in
 * `worker/` or `test/`, so they are now module-private (the constants are still
 * named and documented in place). Re-export them if and when a real caller
 * needs them — an unused export is a promise this module does not keep.
 */

import { defaultClock, type Clock } from "../../platform/lib/clock";

// ---------------------------------------------------------------------------
// Contract constants (mirror test/contracts/contract-lock.ts)
// ---------------------------------------------------------------------------

/**
 * Frozen error code for a denied request. Mirrors
 * `CONTRACT_ERRORS.rate_limited` in the contract lock — the string is asserted
 * there and must not drift.
 */
export const RATE_LIMITED_CODE = "rate_limited" as const;

/** Frozen HTTP status for a denied request (contract `STATUS.tooManyRequests`). */
export const RATE_LIMITED_STATUS = 429 as const;

/** Response header naming the seconds until the window frees (RFC 9110). */
export const RETRY_AFTER_HEADER = "retry-after" as const;

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

/** The request is within budget; the limiter recorded it. */
export interface RateLimitAllowed {
  readonly allowed: true;
  /** Always `429`-free; carried for a uniform decision shape. */
  readonly status: 200;
  /** Samples recorded for `key` inside the window AFTER this decision. */
  readonly remaining: number;
  /** The instant the decision was made (injected clock). */
  readonly now: number;
}

/** The request is over budget; nothing was recorded. */
export interface RateLimitExceeded {
  readonly allowed: false;
  /** Frozen `429`. */
  readonly status: typeof RATE_LIMITED_STATUS;
  /** Frozen `rate_limited`. */
  readonly error: typeof RATE_LIMITED_CODE;
  /** Always 0 on a denial (the request was not admitted). */
  readonly remaining: 0;
  /** The instant the decision was made (injected clock). */
  readonly now: number;
  /**
   * Whole seconds until the window frees (>= 1). Rounded up, so it is a valid
   * `retry-after` value and never an early retry. Always `>= 0` as required by
   * the acceptance spec.
   */
  readonly retryAfter: number;
  /** Epoch ms at which the OLDEST surviving sample leaves the window. */
  readonly resetAt: number;
  /** Headers a route should attach verbatim, e.g. `{ "retry-after": "2" }`. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Discriminated outcome of {@link RateLimiter.checkAndConsume}. */
export type RateLimitDecision = RateLimitAllowed | RateLimitExceeded;

/**
 * The `{ error, message }` body sent alongside a `429`.
 *
 * The frozen part is `error` (`"rate_limited"`); `message` is a human-readable
 * hint. Kept as the return type of {@link rateLimitedBody} so the shape is
 * named without being an exported alias of its own.
 */
interface RateLimitedBody {
  readonly error: typeof RATE_LIMITED_CODE;
  readonly message: string;
}

/** Default human message attached to a `429` body. */
const RATE_LIMITED_MESSAGE = "rate limit exceeded; retry later" as const;

/**
 * Build the frozen `429` body. Kept separate from the decision so a route can
 * serialise it however it likes (JSON here, but the shape is what is frozen).
 */
export function rateLimitedBody(message: string = RATE_LIMITED_MESSAGE): RateLimitedBody {
  return { error: RATE_LIMITED_CODE, message };
}

// ---------------------------------------------------------------------------
// Options & configuration
// ---------------------------------------------------------------------------

/** A `(limit, windowMs)` pair, so policy can be declared once and reused. */
export interface RateLimitPolicy {
  /** Max admitted requests per `windowMs` per key. Must be a positive integer. */
  readonly limit: number;
  /** Sliding window length in milliseconds. Must be a positive number. */
  readonly windowMs: number;
}

/** Construction options for {@link RateLimiter}. */
export interface RateLimiterOptions {
  /** Injected clock seam; defaults to wall-clock `Date.now`. */
  readonly now?: Clock;
  /**
   * Optional cap on the number of distinct keys tracked. When exceeded the
   * least-recently-touched key is evicted, bounding memory for a long-lived
   * limiter facing many tokens. Omit for unbounded (fine in tests / short
   * lived instances).
   */
  readonly maxKeys?: number;
  /**
   * Hard cap on the number of timestamps retained per key. Defaults to a value
   * that can never truncate a window below any sane `limit`; set it only to
   * bound worst-case memory for an enormous `limit`.
   */
  readonly maxSamplesPerKey?: number;
}

/**
 * Default per-key sample cap: generous enough for any realistic `limit`. Kept
 * module-private — it is an implementation default, not a knob callers express,
 * so it is not part of the limiter's public surface.
 */
const DEFAULT_MAX_SAMPLES_PER_KEY = 10_000;

// ---------------------------------------------------------------------------
// The limiter
// ---------------------------------------------------------------------------

/**
 * Sliding-window-log rate limiter with an injected clock.
 *
 * One instance holds the counters for many keys; {@link checkAndConsume} is the
 * only mutation point. All state is in-memory and per-instance — a Durable
 * Object or a Worker isolate can each own one, and tests get a fresh one.
 */
export class RateLimiter {
  readonly #clock: Clock;
  readonly #maxKeys: number | undefined;
  readonly #maxSamplesPerKey: number;
  /**
   * key -> admitted timestamps (ascending, since the clock is monotonic). The
   * Map's iteration order is used as a cheap LRU-ish recency order: a touched
   * key is re-inserted (delete + set) so the oldest key sits first.
   */
  readonly #windows = new Map<string, number[]>();

  constructor(options: RateLimiterOptions = {}) {
    this.#clock = options.now ?? defaultClock;
    this.#maxKeys = options.maxKeys;
    this.#maxSamplesPerKey = options.maxSamplesPerKey ?? DEFAULT_MAX_SAMPLES_PER_KEY;
  }

  /**
   * Decide whether `key` may proceed, consuming one unit of budget on success.
   *
   * Reads the injected clock exactly once. Prunes expired samples for `key`
   * (and never throws on a backwards clock — an empty window simply admits).
   *
   * @param key      Opaque limiter key; the caller passes the project token.
   * @param limit    Max admitted requests within `windowMs`. `<= 0` denies all.
   * @param windowMs Sliding window length in ms. `<= 0` is treated as "no
   *                 window": nothing is retained, so every request is allowed.
   */
  checkAndConsume(key: string, limit: number, windowMs: number): RateLimitDecision {
    const now = this.#clock();

    // A non-positive window has nothing to enforce against: admit without
    // recording, so the limiter degrades to "off" rather than to a hard block.
    if (!(windowMs > 0)) {
      return { allowed: true, status: 200, remaining: limit, now };
    }

    const samples = this.#prune(this.#windows.get(key) ?? [], now, windowMs);

    // DEFINE the window as half-open (now - windowMs, now]: a sample exactly
    // `windowMs` old has LEFT the window, which is what makes the retry-after
    // exactly reach the boundary.
    if (samples.length >= limit) {
      // Denied. The oldest surviving sample governs when the window frees. With
      // `limit <= 0` nothing was ever admitted (samples is empty), so there is
      // no oldest sample: fall back to a full window from now, which keeps
      // `retryAfter` a real, non-negative number instead of NaN.
      const oldest = samples[0];
      const resetAt = oldest === undefined ? now + windowMs : oldest + windowMs;
      const msUntilReset = Math.max(0, resetAt - now);
      // Round UP to whole seconds; floor at 1 because we are currently limited.
      const retryAfter = Math.max(1, Math.ceil(msUntilReset / 1000));

      this.#touch(key, samples);

      return {
        allowed: false,
        status: RATE_LIMITED_STATUS,
        error: RATE_LIMITED_CODE,
        remaining: 0,
        now,
        retryAfter,
        resetAt,
        headers: { [RETRY_AFTER_HEADER]: String(retryAfter) },
      };
    }

    // Allowed. Record the instant and store the (possibly trimmed) window.
    samples.push(now);
    if (samples.length > this.#maxSamplesPerKey) {
      samples.splice(0, samples.length - this.#maxSamplesPerKey);
    }
    this.#touch(key, samples);

    return { allowed: true, status: 200, remaining: limit - samples.length, now };
  }

  /** Remaining budget for `key` without consuming any (best-effort, read-only). */
  remaining(key: string, limit: number, windowMs: number): number {
    const now = this.#clock();
    if (!(windowMs > 0)) return limit;
    const live = this.#prune(this.#windows.get(key) ?? [], now, windowMs).length;
    return Math.max(0, limit - live);
  }

  /** Number of distinct keys currently tracked. */
  get size(): number {
    return this.#windows.size;
  }

  /** Drop all state for `key` (e.g. after a token is revoked). */
  reset(key: string): void {
    this.#windows.delete(key);
  }

  /** Drop all state for every key. */
  clear(): void {
    this.#windows.clear();
  }

  // -- internals ------------------------------------------------------------

  /** Drop samples at or before `now - windowMs`; keep the array sorted. */
  #prune(samples: number[], now: number, windowMs: number): number[] {
    const cutoff = now - windowMs;
    let i = 0;
    while (i < samples.length && (samples[i] as number) <= cutoff) i += 1;
    if (i > 0) samples.splice(0, i);
    return samples;
  }

  /** Store `samples` for `key` as most-recently-touched, enforcing `maxKeys`. */
  #touch(key: string, samples: number[]): void {
    // Re-insert to move `key` to the "newest" end of the Map's iteration order.
    this.#windows.delete(key);
    this.#windows.set(key, samples);

    if (this.#maxKeys !== undefined && this.#windows.size > this.#maxKeys) {
      const oldestKey = this.#windows.keys().next().value;
      if (oldestKey !== undefined) this.#windows.delete(oldestKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: one-shot check over a shared default limiter
// ---------------------------------------------------------------------------

/**
 * Process-wide default limiter. Exported so a route can adopt a single limiter
 * instance without writing its own singleton; tests should construct their own
 * {@link RateLimiter} to avoid cross-test state.
 */
export const defaultRateLimiter = new RateLimiter();
