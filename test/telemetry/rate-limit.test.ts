import { describe, expect, it } from "vitest";
import {
  RATE_LIMITED_CODE,
  RATE_LIMITED_STATUS,
  RETRY_AFTER_HEADER,
  RateLimiter,
  type RateLimitDecision,
  type RateLimitExceeded,
} from "../../worker/src/domains/telemetry/rate-limit";
import { CONTRACT_ERRORS, STATUS } from "../contracts/contract-lock";

/**
 * Spec tests for the per-project-token ingress rate limiter.
 *
 * The limiter is a sliding-window log over an INJECTED clock, so every case
 * below is fully deterministic: a mutable `clock` variable stands in for time
 * and is advanced by hand, never slept on.
 *
 * The acceptance properties, one `describe` each:
 *
 *   1. **Under the limit** — the first `limit` checks are allowed; the
 *      `(limit + 1)`th in the window is denied with a `retry-after >= 0`.
 *   2. **Window roll** — advancing the clock by the full window admits again.
 *   3. **Independence** — two tokens never share a counter.
 *   4. **Frozen contract** — the denial's code/status match the contract lock
 *      (`rate_limited` / `429`), and the `retry-after` header is a valid,
 *      non-negative whole-second value.
 *
 * A `RateLimiter` is rebuilt per test via {@link harness}, so no state leaks
 * between cases (and none of them touch the module-level default limiter).
 */

const LIMIT = 3;
const WINDOW_MS = 60_000;
const TOKEN = "pt_live_alpha";

/** A limiter plus a hand-cranked clock, so time is entirely controlled. */
function harness(): { limiter: RateLimiter; advance: (ms: number) => void; at: () => number } {
  let now = 1_700_000_000_000;
  const limiter = new RateLimiter({ now: () => now });
  return {
    limiter,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

/** Type guard: narrow a decision to its denial arm, failing loudly otherwise. */
function assertDenied(
  decision: RateLimitDecision,
): asserts decision is RateLimitExceeded {
  if (decision.allowed) throw new Error("expected a denial but the request was allowed");
}

describe("rate-limiter: under the limit", () => {
  it("allows exactly `limit` requests, then denies the (limit + 1)th", () => {
    const { limiter } = harness();

    for (let i = 1; i <= LIMIT; i += 1) {
      const decision = limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);
      expect(decision.allowed).toBe(true);
      expect(decision.status).toBe(200);
      // Budget strictly decreases: after i admissions, limit - i remain.
      expect(decision.remaining).toBe(LIMIT - i);
    }

    const denied = limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // Acceptance: a denial carries a retry-after that is never negative.
    assertDenied(denied);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(0);
  });

  it("does not consume budget on a denial (a denied request is free)", () => {
    const { limiter } = harness();
    for (let i = 0; i < LIMIT; i += 1) limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);

    // Hammer the limiter while over budget; each attempt must stay denied.
    for (let i = 0; i < 5; i += 1) {
      const denied = limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);
      expect(denied.allowed).toBe(false);
      assertDenied(denied);
      // Retries inside the window cannot push the reset further out.
      expect(denied.retryAfter).toBeLessThanOrEqual(Math.ceil(WINDOW_MS / 1000));
    }
  });
});

describe("rate-limiter: window roll", () => {
  it("admits again once the sliding window has fully passed", () => {
    const { limiter, advance } = harness();
    for (let i = 0; i < LIMIT; i += 1) expect(limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS).allowed).toBe(true);

    // At the boundary the limiter is still saturated...
    expect(limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS).allowed).toBe(false);

    // ...but advancing by the full window retires every recorded sample.
    advance(WINDOW_MS);
    const afterRoll = limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);
    expect(afterRoll.allowed).toBe(true);
    expect(afterRoll.remaining).toBe(LIMIT - 1);
  });

  it("retry-after descends as the window drains, hitting the exact boundary", () => {
    const { limiter, advance, at } = harness();
    const base = at();
    for (let i = 0; i < LIMIT; i += 1) limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);

    const early = limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);
    assertDenied(early);
    // Oldest sample is `base`, so the window frees at base + WINDOW_MS.
    expect(early.resetAt).toBe(base + WINDOW_MS);
    expect(early.retryAfter).toBe(Math.ceil(WINDOW_MS / 1000));

    advance(WINDOW_MS - 1_000); // one second short of the boundary
    const late = limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);
    assertDenied(late);
    expect(late.retryAfter).toBe(1);

    advance(1_000); // exactly at the boundary -> window frees
    expect(limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS).allowed).toBe(true);
  });
});

describe("rate-limiter: per-token independence", () => {
  it("keeps a separate counter for each token", () => {
    const { limiter } = harness();

    // Saturate token A.
    for (let i = 0; i < LIMIT; i += 1) limiter.checkAndConsume("pt_a", LIMIT, WINDOW_MS);
    expect(limiter.checkAndConsume("pt_a", LIMIT, WINDOW_MS).allowed).toBe(false);

    // Token B is untouched by A's spend.
    const first = limiter.checkAndConsume("pt_b", LIMIT, WINDOW_MS);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(LIMIT - 1);

    // And A stays denied: B's admission did not replenish A.
    expect(limiter.checkAndConsume("pt_a", LIMIT, WINDOW_MS).allowed).toBe(false);
  });

  it("tracks each key independently across a window roll", () => {
    const { limiter, advance } = harness();
    for (let i = 0; i < LIMIT; i += 1) limiter.checkAndConsume("pt_a", LIMIT, WINDOW_MS);

    advance(WINDOW_MS);
    // A fresh key was never recorded, so it is admitted with full budget.
    expect(limiter.checkAndConsume("pt_b", LIMIT, WINDOW_MS).remaining).toBe(LIMIT - 1);
    // A's old samples retired too, so A is admitted once more.
    expect(limiter.checkAndConsume("pt_a", LIMIT, WINDOW_MS).allowed).toBe(true);
  });
});

describe("rate-limiter: frozen 429 contract", () => {
  it("denies with the contract's `rate_limited` code and 429 status", () => {
    const { limiter } = harness();
    for (let i = 0; i < LIMIT; i += 1) limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);

    const denied = limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);
    assertDenied(denied);
    expect(denied.error).toBe(RATE_LIMITED_CODE);
    expect(denied.error).toBe("rate_limited");
    expect(denied.status).toBe(RATE_LIMITED_STATUS);
    expect(denied.status).toBe(429);
  });

  it("agrees with the frozen contract lock (code + status are wired to 429)", () => {
    expect(RATE_LIMITED_CODE).toBe("rate_limited");
    expect(RATE_LIMITED_STATUS).toBe(429);
    expect(CONTRACT_ERRORS.rate_limited.status).toBe(STATUS.tooManyRequests);
    expect(STATUS.tooManyRequests).toBe(429);
  });

  it("exposes retry-after as a non-negative whole-second header", () => {
    const { limiter, advance } = harness();
    for (let i = 0; i < LIMIT; i += 1) limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);

    const denied = limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);
    assertDenied(denied);
    const raw = denied.headers[RETRY_AFTER_HEADER];
    expect(raw).toBeDefined();
    const seconds = Number(raw);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(0);
    // The header mirrors the decision field exactly.
    expect(raw).toBe(String(denied.retryAfter));

    // Still a valid whole-second value right up to the boundary.
    advance(WINDOW_MS - 500);
    const late = limiter.checkAndConsume(TOKEN, LIMIT, WINDOW_MS);
    assertDenied(late);
    expect(Number.isInteger(Number(late.headers[RETRY_AFTER_HEADER]))).toBe(true);
    expect(Number(late.headers[RETRY_AFTER_HEADER])).toBeGreaterThanOrEqual(0);
  });
});

describe("rate-limiter: edge policies", () => {
  it("denies every request when the limit is zero or negative", () => {
    const { limiter } = harness();
    for (const limit of [0, -1]) {
      const decision = limiter.checkAndConsume(`pt_zero_${limit}`, limit, WINDOW_MS);
      expect(decision.allowed).toBe(false);
      assertDenied(decision);
      expect(decision.retryAfter).toBeGreaterThanOrEqual(0);
    }
  });

  it("admits everything when the window is non-positive (limiter disabled)", () => {
    const { limiter } = harness();
    for (let i = 0; i < LIMIT + 5; i += 1) {
      const decision = limiter.checkAndConsume(TOKEN, LIMIT, 0);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(LIMIT);
    }
    // Nothing was recorded, so the limiter holds no state for the key.
    expect(limiter.size).toBe(0);
  });

  it("can reset one key or clear all keys", () => {
    const { limiter } = harness();
    for (let i = 0; i < LIMIT; i += 1) limiter.checkAndConsume("pt_a", LIMIT, WINDOW_MS);
    limiter.checkAndConsume("pt_b", LIMIT, WINDOW_MS);
    expect(limiter.size).toBe(2);

    limiter.reset("pt_a");
    expect(limiter.size).toBe(1);
    // A's budget is restored; B's is untouched by A's reset.
    expect(limiter.checkAndConsume("pt_a", LIMIT, WINDOW_MS).remaining).toBe(LIMIT - 1);

    limiter.clear();
    expect(limiter.size).toBe(0);
  });

  it("bounds tracked keys with `maxKeys`, evicting the least-recently-used", () => {
    let now = 1_700_000_000_000;
    const limiter = new RateLimiter({ now: () => now, maxKeys: 2 });

    limiter.checkAndConsume("pt_a", LIMIT, WINDOW_MS); // recency: [a]
    limiter.checkAndConsume("pt_b", LIMIT, WINDOW_MS); // recency: [a, b]
    limiter.checkAndConsume("pt_c", LIMIT, WINDOW_MS); // recency: [b, c] — a evicted
    expect(limiter.size).toBe(2);

    // `pt_a` was evicted, so it starts a fresh window — and admitting it now
    // evicts the new least-recently-used key, `pt_b` (recency [b, c] -> [c, a]).
    now += 1;
    expect(limiter.checkAndConsume("pt_a", LIMIT, WINDOW_MS).remaining).toBe(LIMIT - 1);

    // `pt_b` was just evicted, so it too starts fresh rather than resuming.
    expect(limiter.checkAndConsume("pt_b", LIMIT, WINDOW_MS).remaining).toBe(LIMIT - 1);
    expect(limiter.size).toBe(2);
  });
});
