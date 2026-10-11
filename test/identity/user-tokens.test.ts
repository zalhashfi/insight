import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { hashToken } from "../../worker/src/platform/lib/tokens";
import {
  InMemoryUserTokenRepo,
  canUserTokenAction,
  createUserToken,
  isUserTokenScope,
  listUserTokens,
  requireUserTokenAction,
  revokeUserToken,
  userTokenPrincipal,
  verifyUserToken,
  type UserToken,
  type UserTokenRepo,
} from "../../worker/src/domains/identity/user-tokens";
import {
  requireScope,
  type Principal,
} from "../../worker/src/platform/middleware/resolve-project";

/**
 * Spec tests for per-user API tokens.
 *
 * The contracts that carry the security weight:
 *
 *   1. Only a SHA-256 digest is ever stored — dumping the whole store and
 *      searching it for the plaintext must come up empty.
 *   2. The plaintext is released exactly once (the create result).
 *   3. Scope is a hard ceiling: a `read` token can never perform a write or an
 *      admin action; an `admin` token can.
 *   4. Expiry and revocation both fail closed, revocation immediately.
 *   5. A project-bound token is valid ONLY for its own project.
 *
 * The tests drive the in-memory `UserTokenRepo` fake so the store is fully
 * inspectable, and a couple of cases route a verified token through the REAL
 * shared `requireScope` middleware to prove user tokens reuse that gate rather
 * than re-implementing an authorization model.
 */

/** Recursively collect every string reachable from a value (the store dump). */
function collectStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item, seen));
  }
  return Object.values(value as Record<string, unknown>).flatMap((item) =>
    collectStrings(item, seen),
  );
}

describe("identity/user-tokens — plaintext never persists", () => {
  it("stores only the hash; the store contains no plaintext anywhere", async () => {
    const repo = new InMemoryUserTokenRepo();

    const created = await createUserToken(repo, {
      userId: "usr_1",
      name: "laptop CLI",
    });
    const plaintext = created.plaintext;

    // Dump EVERYTHING the store holds and prove the plaintext is absent.
    const dump = JSON.stringify(repo.raw());
    expect(dump).not.toContain(plaintext);
    expect(collectStrings(repo.raw())).not.toContain(plaintext);

    // ...and the only credential material present is the matching hash.
    const [row] = repo.raw();
    expect(row.tokenHash).toBe(await hashToken(plaintext));
    expect(dump).toContain(row.tokenHash);

    // The record shape has no plaintext slot at all.
    expect(Object.keys(row)).not.toContain("plaintext");
    expect(Object.keys(row)).not.toContain("token");
  });

  it("releases the plaintext exactly once and a second read cannot recover it", async () => {
    const repo = new InMemoryUserTokenRepo();

    const created = await createUserToken(repo, {
      userId: "usr_2",
      name: "ci runner",
    });

    // The plaintext lives ONLY on the create result object...
    expect(collectStrings(created.record)).not.toContain(created.plaintext);
    expect(created.plaintext).toMatch(/^pt_/);

    // ...so listing the user's tokens can never hand it back.
    const listed = await listUserTokens(repo, "usr_2");
    expect(listed).toHaveLength(1);
    for (const row of listed) {
      expect(collectStrings(row)).not.toContain(created.plaintext);
      expect(row.tokenHash).toBe(await hashToken(created.plaintext));
    }

    // Re-reading by the plaintext's hash yields the record — still no plaintext.
    const record = await repo.findByHash(await hashToken(created.plaintext));
    expect(record).not.toBeNull();
    expect((record as UserToken).revokedAt).toBeNull();
    expect(collectStrings(record)).not.toContain(created.plaintext);
  });

  it("reuses the shared hash: identical plaintext verifies against the stored digest", async () => {
    const repo = new InMemoryUserTokenRepo();
    const { plaintext, record } = await createUserToken(repo, {
      userId: "usr_3",
      name: "hashed elsewhere",
    });

    // The digest is exactly the shared SHA-256 helper's output (no re-hash).
    expect(record.tokenHash).toBe(await hashToken(plaintext));
    expect(await verifyUserToken(repo, plaintext)).toMatchObject({ id: record.id });
  });
});

describe("identity/user-tokens — scope is a hard ceiling", () => {
  it("scope `read` denies write and admin; scope `admin` allows them", () => {
    expect(canUserTokenAction("read", "read")).toBe(true);
    expect(canUserTokenAction("read", "write")).toBe(false);
    expect(canUserTokenAction("read", "admin")).toBe(false);

    expect(canUserTokenAction("admin", "read")).toBe(true);
    expect(canUserTokenAction("admin", "write")).toBe(true);
    expect(canUserTokenAction("admin", "admin")).toBe(true);
  });

  it("defaults to the least-privilege `read` scope", async () => {
    const repo = new InMemoryUserTokenRepo();
    const { record } = await createUserToken(repo, { userId: "usr_4", name: "no scope" });
    expect(record.scope).toBe("read");
  });

  it("`requireUserTokenAction` mirrors requireScope: null when allowed, 403 otherwise", async () => {
    const repo = new InMemoryUserTokenRepo();
    const read = await createUserToken(repo, { userId: "usr_5", name: "r", scope: "read" });
    const admin = await createUserToken(repo, { userId: "usr_5", name: "a", scope: "admin" });

    expect(requireUserTokenAction(read.record, "read")).toBeNull();
    expect(requireUserTokenAction(read.record, "write")).toMatchObject({
      status: 403,
      error: "insufficient_scope",
    });
    expect(requireUserTokenAction(read.record, "admin")).toMatchObject({ status: 403 });

    expect(requireUserTokenAction(admin.record, "read")).toBeNull();
    expect(requireUserTokenAction(admin.record, "write")).toBeNull();
    expect(requireUserTokenAction(admin.record, "admin")).toBeNull();
  });

  it("a verified token plugs into the REAL middleware requireScope gate", async () => {
    const repo = new InMemoryUserTokenRepo();
    const read = await createUserToken(repo, { userId: "usr_6", name: "r", scope: "read" });
    const admin = await createUserToken(repo, { userId: "usr_6", name: "a", scope: "admin" });

    // Build a tiny app whose handler gates the write exactly as a route would.
    const app = new Hono<{ Variables: { principal: Principal } }>();
    app.post("/v1/projects/:proj/telemetry", async (c) => {
      const token = await verifyUserToken(repo, c.req.header("authorization") ?? "");
      if (token === undefined) return c.json({ error: "unauthorized" }, 401);
      c.set("principal", userTokenPrincipal(token));
      return requireScope(c, "write") ?? c.json({ ok: true }, 200);
    });

    const writeAs = (plaintext: string) =>
      app.request("/v1/projects/prj_1/telemetry", {
        method: "POST",
        headers: { authorization: plaintext },
      });

    // A read-scoped token is refused the write (403), an admin-scoped one passes.
    expect((await writeAs(read.plaintext)).status).toBe(403);
    expect((await writeAs(admin.plaintext)).status).toBe(200);
  });

  it("rejects an unknown scope string", () => {
    expect(isUserTokenScope("read")).toBe(true);
    expect(isUserTokenScope("admin")).toBe(true);
    expect(isUserTokenScope("write")).toBe(false);
    expect(isUserTokenScope("")).toBe(false);
  });
});

describe("identity/user-tokens — expiry & revocation", () => {
  it("fails verification once expired, honouring the clock seam", async () => {
    const repo = new InMemoryUserTokenRepo();
    const { plaintext } = await createUserToken(repo, {
      userId: "usr_7",
      name: "expiring",
      expiresAt: 1_000,
    });

    expect(await verifyUserToken(repo, plaintext, null, () => 999)).toBeDefined();
    expect(await verifyUserToken(repo, plaintext, null, () => 1_000)).toBeUndefined();
    expect(await verifyUserToken(repo, plaintext, null, () => 2_000)).toBeUndefined();
  });

  it("a token with no expiry never expires", async () => {
    const repo = new InMemoryUserTokenRepo();
    const { plaintext } = await createUserToken(repo, { userId: "usr_8", name: "forever" });
    expect(await verifyUserToken(repo, plaintext, null, () => 10 ** 15)).toBeDefined();
  });

  it("the SAME plaintext fails immediately after revoke, with no cached success", async () => {
    const repo = new InMemoryUserTokenRepo();
    const { plaintext, record } = await createUserToken(repo, {
      userId: "usr_9",
      name: "to revoke",
    });

    // Warm any would-be cache with several successful verifications.
    expect(await verifyUserToken(repo, plaintext)).toBeDefined();
    expect(await verifyUserToken(repo, plaintext)).toBeDefined();

    const revoked = await revokeUserToken(repo, record.id);
    expect(revoked?.revokedAt).not.toBeNull();

    // Identical plaintext now fails — immediately, not after a TTL.
    expect(await verifyUserToken(repo, plaintext)).toBeUndefined();
  });

  it("re-reads the store on every verification (no memoisation of the row)", async () => {
    const inner = new InMemoryUserTokenRepo();
    let lookups = 0;

    const spy: UserTokenRepo = {
      insert: (token) => inner.insert(token),
      findByHash: (hash) => {
        lookups += 1;
        return inner.findByHash(hash);
      },
      revoke: (id, at) => inner.revoke(id, at),
      listByUser: (userId) => inner.listByUser(userId),
    };

    const { plaintext, record } = await createUserToken(spy, {
      userId: "usr_10",
      name: "counted",
    });
    const afterCreate = lookups;

    await verifyUserToken(spy, plaintext);
    await verifyUserToken(spy, plaintext);
    expect(lookups).toBe(afterCreate + 2);

    // Revoking behind the domain layer's back is observed on the next call.
    await inner.revoke(record.id, Date.now());
    expect(await verifyUserToken(spy, plaintext)).toBeUndefined();
    expect(lookups).toBe(afterCreate + 3);
  });

  it("revoking an unknown id returns null; unknown plaintext never verifies", async () => {
    const repo = new InMemoryUserTokenRepo();
    expect(await revokeUserToken(repo, "utk_missing")).toBeNull();
    expect(await verifyUserToken(repo, "pt_not_a_real_token")).toBeUndefined();
  });
});

describe("identity/user-tokens — project binding", () => {
  it("a project-bound token is valid ONLY for its own project", async () => {
    const repo = new InMemoryUserTokenRepo();
    const { plaintext } = await createUserToken(repo, {
      userId: "usr_11",
      name: "scoped",
      scope: "admin",
      projectId: "prj_own",
    });

    // Its own project verifies...
    expect(await verifyUserToken(repo, plaintext, "prj_own")).toMatchObject({
      projectId: "prj_own",
    });
    // ...a foreign project does not.
    expect(await verifyUserToken(repo, plaintext, "prj_other")).toBeUndefined();
    // No project supplied means "just check the credential".
    expect(await verifyUserToken(repo, plaintext)).toBeDefined();
  });

  it("an account-wide token (no projectId) is valid for any project", async () => {
    const repo = new InMemoryUserTokenRepo();
    const { plaintext, record } = await createUserToken(repo, {
      userId: "usr_12",
      name: "global",
    });

    expect(record.projectId).toBeNull();
    expect(await verifyUserToken(repo, plaintext, "prj_a")).toBeDefined();
    expect(await verifyUserToken(repo, plaintext, "prj_b")).toBeDefined();
  });

  it("create is deterministic under injected clock/id seams", async () => {
    const repo = new InMemoryUserTokenRepo();
    const { record } = await createUserToken(
      repo,
      { userId: "usr_13", name: "seeded", scope: "admin", projectId: "prj_seed" },
      () => 1_234,
      () => "utk_fixed",
    );
    expect(record.id).toBe("utk_fixed");
    expect(record.scope).toBe("admin");
    expect(record.projectId).toBe("prj_seed");
    expect(record.createdAt).toBe(1_234);
    expect(record.updatedAt).toBe(1_234);
    expect(record.revokedAt).toBeNull();
  });
});
