import { describe, expect, it } from "vitest";
import {
  TOKEN_BYTES,
  TOKEN_PREFIX,
  base64url,
  bytesToHex,
  generateToken,
  hashToken,
  hexToBytes,
} from "../../worker/src/platform/lib/tokens";
import {
  InMemoryTokenRepo,
  createProjectToken,
  revokeProjectToken,
  verifyProjectToken,
  type ProjectToken,
  type TokenRepo,
} from "../../worker/src/domains/identity/tokens";

/**
 * Spec tests for project device tokens.
 *
 * The two contracts that carry the security weight:
 *
 *   1. Only a SHA-256 digest is ever stored — dumping the whole store and
 *      searching it for the plaintext must come up empty.
 *   2. The plaintext is released exactly once (the create result) and a token
 *      revoked just now fails verification immediately, with no cached success.
 *
 * The tests drive the in-memory `TokenRepo` fake so the store is fully
 * inspectable, and a couple of cases use a thin spy wrapper to prove the domain
 * layer re-reads on every verification instead of memoising.
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

describe("platform/lib/tokens — hashing", () => {
  it("is deterministic: same plaintext -> same hash, different -> different", async () => {
    const a1 = await hashToken("pt_alpha");
    const a2 = await hashToken("pt_alpha");
    const b = await hashToken("pt_beta");

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    // SHA-256 rendered as lowercase hex.
    expect(a1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is async-safe under concurrency (no shared mutable state)", async () => {
    const values = Array.from({ length: 64 }, (_, i) => `pt_${i}`);
    const first = await Promise.all(values.map((v) => hashToken(v)));
    const second = await Promise.all(values.map((v) => hashToken(v)));
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(values.length);
  });

  it("hashing is case- and whitespace-sensitive (no normalisation)", async () => {
    expect(await hashToken("pt_a")).not.toBe(await hashToken("pt_A"));
    expect(await hashToken("pt_a")).not.toBe(await hashToken(" pt_a"));
  });
});

describe("platform/lib/tokens — generation", () => {
  it("mints an opaque prefixed token with enough entropy", async () => {
    const { plaintext, hash } = await generateToken();

    expect(plaintext.startsWith(TOKEN_PREFIX)).toBe(true);
    // Prefix + 32 random bytes as unpadded base64url (43 chars).
    expect(plaintext.slice(TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(await hashToken(plaintext));
  });

  it("never repeats across many draws", async () => {
    const drawn = await Promise.all(
      Array.from({ length: 200 }, () => generateToken()),
    );
    expect(new Set(drawn.map((t) => t.plaintext)).size).toBe(drawn.length);
    expect(new Set(drawn.map((t) => t.hash)).size).toBe(drawn.length);
  });

  it("base64url/hex helpers round-trip the byte encoding", () => {
    const bytes = new Uint8Array(TOKEN_BYTES);
    crypto.getRandomValues(bytes);

    // Base64url length for N bytes is ceil(4N/3) with no padding.
    expect(base64url(bytes)).toHaveLength(Math.ceil((bytes.length * 4) / 3));
    expect(base64url(bytes)).toMatch(/^[A-Za-z0-9_-]+$/);

    const hex = bytesToHex(bytes);
    expect(hex).toHaveLength(bytes.length * 2);
    expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes));
  });

  it("rejects malformed hex", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
  });
});

describe("identity/tokens — plaintext never persists", () => {
  it("stores only the hash; the store contains no plaintext anywhere", async () => {
    const repo = new InMemoryTokenRepo();

    const created = await createProjectToken(repo, {
      projectId: "prj_1",
      name: "CI deploy",
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
    const repo = new InMemoryTokenRepo();

    const created = await createProjectToken(repo, {
      projectId: "prj_2",
      name: "prod key",
    });

    // The plaintext lives ONLY on the create result object...
    const resultStrings = collectStrings(created.record);
    expect(resultStrings).not.toContain(created.plaintext);
    expect(created.plaintext).toMatch(/^pt_/);

    // ...so listing the project can never hand it back.
    const listed = await repo.listByProject("prj_2");
    expect(listed).toHaveLength(1);
    for (const row of listed) {
      expect(collectStrings(row)).not.toContain(created.plaintext);
      expect(row.tokenHash).toBe(await hashToken(created.plaintext));
    }

    // Re-reading by the plaintext's hash yields the record — still no plaintext.
    const record = await repo.findByHash(await hashToken(created.plaintext));
    expect(record).not.toBeNull();
    expect((record as ProjectToken).revokedAt).toBeNull();
    expect(collectStrings(record)).not.toContain(created.plaintext);
  });

  it("keeps two distinct tokens' secrets out of each other's rows", async () => {
    const repo = new InMemoryTokenRepo();
    const a = await createProjectToken(repo, { projectId: "prj", name: "a" });
    const b = await createProjectToken(repo, { projectId: "prj", name: "b" });

    const dump = JSON.stringify(repo.raw());
    expect(dump).not.toContain(a.plaintext);
    expect(dump).not.toContain(b.plaintext);

    expect(await verifyProjectToken(repo, a.plaintext)).toMatchObject({
      name: "a",
    });
    expect(await verifyProjectToken(repo, b.plaintext)).toMatchObject({
      name: "b",
    });
  });
});

describe("identity/tokens — verification & revocation", () => {
  it("verifies a valid token and rejects unknown plaintext", async () => {
    const repo = new InMemoryTokenRepo();
    const { plaintext, record } = await createProjectToken(repo, {
      projectId: "prj_3",
      name: "deploy",
    });

    expect(await verifyProjectToken(repo, plaintext)).toMatchObject({
      id: record.id,
      projectId: "prj_3",
      revokedAt: null,
    });
    expect(await verifyProjectToken(repo, "pt_not_a_real_token")).toBeUndefined();
    // A near-miss (same token, one char changed) must not verify.
    expect(
      await verifyProjectToken(repo, plaintext.slice(0, -1) + "X"),
    ).toBeUndefined();
  });

  it("the SAME plaintext fails after revoke, with no cached success", async () => {
    const repo = new InMemoryTokenRepo();
    const { plaintext, record } = await createProjectToken(repo, {
      projectId: "prj_4",
      name: "to revoke",
    });

    // Warm any would-be cache with several successful verifications.
    expect(await verifyProjectToken(repo, plaintext)).toBeDefined();
    expect(await verifyProjectToken(repo, plaintext)).toBeDefined();

    const revoked = await revokeProjectToken(repo, record.id);
    expect(revoked?.revokedAt).not.toBeNull();

    // Identical plaintext now fails — immediately, not after a TTL.
    expect(await verifyProjectToken(repo, plaintext)).toBeUndefined();
    expect(await verifyProjectToken(repo, plaintext)).toBeUndefined();
  });

  it("re-reads the store on every verification (no memoisation of the row)", async () => {
    const inner = new InMemoryTokenRepo();
    let lookups = 0;

    // Thin spy wrapper: the domain layer must hit `findByHash` each time.
    const spy: TokenRepo = {
      insert: (token) => inner.insert(token),
      findByHash: (hash) => {
        lookups += 1;
        return inner.findByHash(hash);
      },
      revoke: (id, at) => inner.revoke(id, at),
      listByProject: (projectId) => inner.listByProject(projectId),
    };

    const { plaintext, record } = await createProjectToken(spy, {
      projectId: "prj_5",
      name: "counted",
    });
    const afterCreate = lookups;

    await verifyProjectToken(spy, plaintext);
    await verifyProjectToken(spy, plaintext);
    expect(lookups).toBe(afterCreate + 2);

    // Revoking behind the domain layer's back is observed on the next call.
    await inner.revoke(record.id, Date.now());
    expect(await verifyProjectToken(spy, plaintext)).toBeUndefined();
    expect(lookups).toBe(afterCreate + 3);
  });

  it("rejects an expired but unrevoked token, honouring the clock seam", async () => {
    const repo = new InMemoryTokenRepo();
    const { plaintext } = await createProjectToken(repo, {
      projectId: "prj_6",
      name: "expiring",
      expiresAt: 1_000,
    });

    expect(await verifyProjectToken(repo, plaintext, () => 999)).toBeDefined();
    expect(await verifyProjectToken(repo, plaintext, () => 1_000)).toBeUndefined();
    expect(await verifyProjectToken(repo, plaintext, () => 2_000)).toBeUndefined();
  });

  it("revoking an unknown id returns null", async () => {
    const repo = new InMemoryTokenRepo();
    expect(await revokeProjectToken(repo, "tok_missing")).toBeNull();
  });

  it("create is deterministic under injected clock/id seams", async () => {
    const repo = new InMemoryTokenRepo();
    const { record } = await createProjectToken(
      repo,
      { projectId: "prj_7", name: "seeded" },
      () => 1_234,
      () => "tok_fixed",
    );
    expect(record.id).toBe("tok_fixed");
    expect(record.createdAt).toBe(1_234);
    expect(record.updatedAt).toBe(1_234);
    expect(record.revokedAt).toBeNull();
  });
});
