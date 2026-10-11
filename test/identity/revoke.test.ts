import { describe, expect, it } from "vitest";
import {
  InMemoryTokenRepo,
  createProjectToken,
  listProjectTokens,
  revokeProjectToken,
  verifyProjectToken,
  type ProjectToken,
} from "../../worker/src/domains/identity/tokens";

/**
 * INV-A3 — device-token revoke is IMMEDIATE; there is NO cache.
 *
 * A project device token authenticates an *unattended* machine client. When an
 * operator revokes one (stolen CI key, decommissioned runner) the expectation
 * is absolute: the very NEXT request bearing that plaintext must be rejected,
 * not "within a TTL". Any memo, module-level map or ≤60s cache between
 * `verifyProjectToken` and the store turns a revocation into a live window in
 * which a leaked secret still works — that is the vulnerability these tests
 * exist to make impossible.
 *
 * The proof strategy is behavioural, not prose:
 *
 *   1. drive a spy `TokenRepo` that COUNTS every `findByHash`;
 *   2. request #1 succeeds → the counter moved (a real read happened);
 *   3. revoke, then send request #2 with the *same* plaintext;
 *   4. assert #2 is rejected AND the counter moved again — i.e. the rejection
 *      came from a FRESH store read, not a cached success being replayed.
 *
 * If any layer memoised a positive result, step 4 would still return the old
 * record and the counter would NOT advance; both assertions fail loudly.
 *
 * A *user-session* cache (≤60s) is explicitly allowed for browser sessions, so
 * the last block builds one and shows the device path derives no benefit from
 * it — device verification always hits the store.
 */

/**
 * A repo that counts `findByHash` invocations on top of the honest in-memory
 * store. The counter is the oracle for "did a fresh read actually happen?":
 * no caching layer can move it on its own, so a cached success would leave it
 * frozen across a revocation. Only `findByHash` adds behaviour; everything
 * else is inherited unchanged from {@link InMemoryTokenRepo}.
 */
class CountingTokenRepo extends InMemoryTokenRepo {
  /** How many store reads the domain layer has triggered. */
  reads = 0;

  override async findByHash(tokenHash: string): Promise<ProjectToken | null> {
    this.reads += 1;
    return super.findByHash(tokenHash);
  }
}

/**
 * A *permitted* user-session cache: a naive positive-result memo with a ≤60s
 * TTL, layered over the honest store. Used only to show the device path does
 * NOT behave like this — a device token bypasses it entirely (every call
 * re-reads).
 *
 * It deliberately caches nothing about revocation, modelling the "sessions may
 * ride a short TTL, device tokens may not" asymmetry from the assignment.
 */
class SessionCacheRepo extends InMemoryTokenRepo {
  readonly #memo = new Map<string, { row: ProjectToken; at: number }>();
  /** Number of times the cache actually short-circuited a store read. */
  hits = 0;
  #now = 0;

  constructor(private readonly ttlMs = 60_000) {
    super();
  }

  setClock(t: number): void {
    this.#now = t;
  }

  override async findByHash(tokenHash: string): Promise<ProjectToken | null> {
    const cached = this.#memo.get(tokenHash);
    if (cached !== undefined && this.#now - cached.at < this.ttlMs) {
      this.hits += 1;
      return cached.row;
    }
    const row = await super.findByHash(tokenHash);
    if (row !== null) this.#memo.set(tokenHash, { row, at: this.#now });
    return row;
  }
}

describe("INV-A3 — device token revoke is immediate (no cache)", () => {
  // NB: a test asserting `DEVICE_TOKEN_VERIFY_IS_UNCACHED === true` would be
  // tautological — the value is a `true as const` literal, so the assertion can
  // never fail and proves nothing about behaviour. The load-bearing proof is
  // the read-counter tests below: they drive a real repo and show a fresh store
  // read on every verification, which is what actually makes revocation
  // immediate.
  it("request #1 succeeds, revoke, request #2 is rejected with a FRESH read", async () => {
    const repo = new CountingTokenRepo();
    const { plaintext, record } = await createProjectToken(repo, {
      projectId: "prj_ci",
      name: "runner token",
    });

    const afterCreate = repo.reads;

    // ---- request #1: a device proves it may talk to the project. ----
    const first = await verifyProjectToken(repo, plaintext);
    expect(first).toMatchObject({ id: record.id, revokedAt: null });
    // A real store read happened for this request (no cache could fake it).
    expect(repo.reads).toBe(afterCreate + 1);
    const readsAfterFirst = repo.reads;

    // ---- the operator revokes the leaked/dying device token. ----
    const revoked = await revokeProjectToken(repo, record.id);
    expect(revoked?.revokedAt).not.toBeNull();

    // ---- request #2: the SAME plaintext, the very next call. ----
    const second = await verifyProjectToken(repo, plaintext);
    expect(second).toBeUndefined();
    // The rejection came from a fresh read — the counter advanced. A cached
    // positive would have returned `first` again and left this frozen.
    expect(repo.reads).toBe(readsAfterFirst + 1);
  });

  it("never returns a stale positive for a revoked token, however often it is asked", async () => {
    const repo = new CountingTokenRepo();
    const { plaintext, record } = await createProjectToken(repo, {
      projectId: "prj_ci",
      name: "repeat offender",
    });

    // Warm any would-be cache with a burst of successful verifications.
    for (let i = 0; i < 5; i += 1) {
      expect(await verifyProjectToken(repo, plaintext)).toBeDefined();
    }
    const readsBeforeRevoke = repo.reads;
    expect(readsBeforeRevoke).toBeGreaterThanOrEqual(5);

    await revokeProjectToken(repo, record.id);

    // Every subsequent presentation is rejected, and each one hit the store.
    for (let i = 1; i <= 10; i += 1) {
      expect(await verifyProjectToken(repo, plaintext)).toBeUndefined();
      expect(repo.reads).toBe(readsBeforeRevoke + i);
    }
  });

  it("revocation is observed even when the row changes behind the domain layer's back", async () => {
    const repo = new CountingTokenRepo();
    const { plaintext, record } = await createProjectToken(repo, {
      projectId: "prj_ci",
      name: "out-of-band revoke",
    });

    expect(await verifyProjectToken(repo, plaintext)).toBeDefined();

    // Revoke straight through the store — no domain-layer involvement at all.
    await repo.revoke(record.id, Date.now());

    // The next verify still fails: there is nothing to be stale.
    expect(await verifyProjectToken(repo, plaintext)).toBeUndefined();
  });

  it("an unrevoked token keeps working (immediacy is not over-rejection)", async () => {
    const repo = new CountingTokenRepo();
    const { plaintext } = await createProjectToken(repo, {
      projectId: "prj_ci",
      name: "healthy",
    });

    // Negative control: no revocation ⇒ the device stays authorised, and each
    // check is still a fresh read (a shared cache would be a correctness risk).
    expect(await verifyProjectToken(repo, plaintext)).toBeDefined();
    expect(await verifyProjectToken(repo, plaintext)).toBeDefined();
    expect(repo.reads).toBeGreaterThanOrEqual(2);
  });
});

describe("INV-A3 — device verify does NOT use a user-session style cache", () => {
  it("a ≤60s session cache short-circuits reads; the device path does not", async () => {
    // --- Build a session cache and prove it genuinely caches (so the contrast
    //     is a real cache being declined, not a broken cache being absent). ---
    const session = new SessionCacheRepo(60_000);
    const sessionToken = await createProjectToken(session, {
      projectId: "prj_web",
      name: "browser session",
    });
    session.setClock(0);
    await verifyProjectToken(session, sessionToken.plaintext);
    await verifyProjectToken(session, sessionToken.plaintext);
    await verifyProjectToken(session, sessionToken.plaintext);
    // Two of the three reads were served from the ≤60s memo.
    expect(session.hits).toBe(2);

    // --- Now the device path. Same shape of calls, but NEVER cached. ---
    const device = new CountingTokenRepo();
    const deviceToken = await createProjectToken(device, {
      projectId: "prj_ci",
      name: "device token",
    });
    const base = device.reads;
    await verifyProjectToken(device, deviceToken.plaintext);
    await verifyProjectToken(device, deviceToken.plaintext);
    await verifyProjectToken(device, deviceToken.plaintext);
    // Every single call hit the store — no short-circuit, unlike the session.
    expect(device.reads).toBe(base + 3);
  });

  it("contrast made sharp: the session cache can serve a revoked row, the device path cannot", async () => {
    // A positive-result cache with a TTL is exactly the hazard INV-A3 bans for
    // device tokens. Demonstrate the hazard, then show the device path is free
    // of it — same operations, opposite outcome.
    const session = new SessionCacheRepo(60_000);
    const created = await createProjectToken(session, {
      projectId: "prj_web",
      name: "cached session",
    });
    session.setClock(0);
    await verifyProjectToken(session, created.plaintext); // warms the memo

    // Revoke through the store, then verify before the TTL elapses.
    await session.revoke(created.record.id, 1);
    session.setClock(1_000); // still within 60s
    // The cached row is still stale-positive — the very window a device token
    // must never have.
    expect(await verifyProjectToken(session, created.plaintext)).toBeDefined();

    // The device path, given the identical sequence, rejects immediately.
    const device = new CountingTokenRepo();
    const dev = await createProjectToken(device, {
      projectId: "prj_ci",
      name: "uncached device",
    });
    await verifyProjectToken(device, dev.plaintext); // "warms" nothing
    await revokeProjectToken(device, dev.record.id);
    expect(await verifyProjectToken(device, dev.plaintext)).toBeUndefined();
  });

  it("revoke→verify is atomic per call: no window opens between the two", async () => {
    const repo = new CountingTokenRepo();
    const { plaintext, record } = await createProjectToken(repo, {
      projectId: "prj_ci",
      name: "tight window",
    });

    // Interleave revoke and verify with no clock advance: a zero-width window.
    await verifyProjectToken(repo, plaintext);
    const revoked = await revokeProjectToken(repo, record.id, () => 42);
    expect(revoked?.revokedAt).toBe(42);
    expect(await verifyProjectToken(repo, plaintext, () => 42)).toBeUndefined();

    // The stored row itself carries the revocation — the store of record.
    const [row] = await listProjectTokens(repo, "prj_ci");
    expect(row.revokedAt).toBe(42);
  });
});
