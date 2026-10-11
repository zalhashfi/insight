import { describe, expect, it } from "vitest";
import {
  bootstrapOwner,
  type BootstrapResult,
  type NewOwner,
  type UserRepo,
} from "../../worker/src/domains/identity/bootstrap";

/**
 * Spec tests for the atomic first-owner bootstrap.
 *
 * The production module talks to the tiny `UserRepo` seam rather than a real
 * D1 binding, which lets these tests drive an in-memory fake that models just
 * enough of the store to make the concurrency contract real:
 *
 *   * a `users` table whose count is observable,
 *   * an `insertOwner` that is the atomic empties-only claim: the whole
 *     check-then-insert runs inside one mutual-exclusion section, so of N
 *     concurrent inserts exactly one reports `true` and the rest `false`.
 *
 * Every `countUsers`/`insertOwner` awaits a turn before entering its critical
 * section, so N `Promise.all`ed `bootstrapOwner` calls genuinely interleave
 * (both callers read 0, both reach the insert) instead of accidentally running
 * one-after-another. Without that yield the race would be covered up and the
 * test would pass against a racy implementation.
 */

/**
 * A promise that resolves after `hops` microtask turns. Awaiting this inside
 * the fake's critical sections guarantees callers observe real interleaving.
 */
async function turn(hops = 1): Promise<void> {
  for (let i = 0; i < hops; i += 1) {
    // `Promise.withResolvers` would read better, but the repo's lib is ES2022.
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
  }
}

/**
 * Simulates the slice of the user store bootstrap depends on. The `users`
 * array stands in for the table; `insertOwner` is the atomic claim.
 */
class FakeUserRepo implements UserRepo {
  /** The persisted users, in insertion order. */
  readonly users: NewOwner[] = [];

  /** Serializes the two critical sections so the claim is atomic. */
  #lock: Promise<unknown> = Promise.resolve();

  /** Run `fn` with exclusive access to the fake's mutable state. */
  #withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.#lock.then(() => fn());
    // Keep the chain alive even if this operation rejects (it should not).
    this.#lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async countUsers(): Promise<number> {
    // Hop *before* the critical section: a caller parked here can be overtaken
    // by another that already read the count, which is exactly the interleave
    // that a racy read-then-insert would lose to.
    await turn();
    return this.#withLock(() => this.users.length);
  }

  async insertOwner(owner: NewOwner): Promise<boolean> {
    await turn();
    return this.#withLock(() => {
      // Atomic empties-only guard: the count check and the append are one
      // indivisible step, so exactly one concurrent insert can win.
      if (this.users.length > 0) return false;
      this.users.push(owner);
      return true;
    });
  }

  /** Test helper: how many owners/users exist. */
  get count(): number {
    return this.users.length;
  }
}

describe("bootstrapOwner — empty instance", () => {
  it("creates the founding owner and persists exactly one user", async () => {
    const repo = new FakeUserRepo();

    const result = await bootstrapOwner(repo, { email: "founder@example.com", name: "Founder" });

    expect(result.ok).toBe(true);
    expect(repo.count).toBe(1);
    expect(repo.users[0]).toMatchObject({ email: "founder@example.com", name: "Founder" });
    if (result.ok) {
      expect(result.owner.email).toBe("founder@example.com");
      expect(result.owner.id).toBe(repo.users[0].id);
    }
  });

  it("honours the id and clock seams", async () => {
    const repo = new FakeUserRepo();

    const result = await bootstrapOwner(repo, {
      email: "founder@example.com",
      generateId: () => "usr_fixed",
      now: () => 1_700_000_000_000,
    });

    expect(result.ok).toBe(true);
    expect(repo.users[0]).toMatchObject({ id: "usr_fixed", createdAt: 1_700_000_000_000 });
  });
});

describe("bootstrapOwner — concurrency", () => {
  it("two parallel calls yield exactly one success and one 409", async () => {
    const repo = new FakeUserRepo();

    const results = await Promise.all([
      bootstrapOwner(repo, { email: "a@example.com" }),
      bootstrapOwner(repo, { email: "b@example.com" }),
    ]);

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, status: 409 });
    // Never two owners: exactly one user survives the race.
    expect(repo.count).toBe(1);
  });

  it("is a real race — both callers reach the insert before either wins", async () => {
    const repo = new FakeUserRepo();
    let countReads = 0;
    let insertAttempts = 0;
    const originalCount = repo.countUsers.bind(repo);
    const originalInsert = repo.insertOwner.bind(repo);
    // Wrap the seams to count how far each caller got. If the pre-check were
    // serializing the callers, `insertAttempts` would be 1, not 2.
    repo.countUsers = async () => {
      const n = await originalCount();
      countReads += 1;
      return n;
    };
    repo.insertOwner = async (owner: NewOwner) => {
      insertAttempts += 1;
      return originalInsert(owner);
    };

    await Promise.all([
      bootstrapOwner(repo, { email: "a@example.com" }),
      bootstrapOwner(repo, { email: "b@example.com" }),
    ]);

    // Both callers observed the empty instance and both tried to claim it —
    // the loser's claim is what the atomic guard has to reject.
    expect(countReads).toBe(2);
    expect(insertAttempts).toBe(2);
    expect(repo.count).toBe(1);
  });

  it("losers never win for any N", async () => {
    for (const N of [2, 3, 5, 13]) {
      const repo = new FakeUserRepo();

      const results: BootstrapResult[] = await Promise.all(
        Array.from({ length: N }, (_, i) => bootstrapOwner(repo, { email: `u${i}@example.com` })),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(N - 1);
      for (const r of results.filter((r) => !r.ok)) expect(r.status).toBe(409);
      expect(repo.count).toBe(1);
    }
  });
});

describe("bootstrapOwner — invite-only after the first owner", () => {
  it("refuses a later bootstrap with 409 and writes nothing", async () => {
    const repo = new FakeUserRepo();
    const first = await bootstrapOwner(repo, { email: "founder@example.com" });
    expect(first.ok).toBe(true);

    const second = await bootstrapOwner(repo, { email: "later@example.com" });

    expect(second).toMatchObject({ ok: false, status: 409 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("already_initialized");
    // No second owner, and the original user is untouched.
    expect(repo.count).toBe(1);
    expect(repo.users[0].email).toBe("founder@example.com");
  });

  it("short-circuits on the pre-check without attempting an insert", async () => {
    const repo = new FakeUserRepo();
    await bootstrapOwner(repo, { email: "founder@example.com" });
    let insertAttempts = 0;
    const originalInsert = repo.insertOwner.bind(repo);
    repo.insertOwner = async (owner: NewOwner) => {
      insertAttempts += 1;
      return originalInsert(owner);
    };

    const second = await bootstrapOwner(repo, { email: "later@example.com" });

    expect(second.ok).toBe(false);
    expect(insertAttempts).toBe(0);
    expect(repo.count).toBe(1);
  });
});
