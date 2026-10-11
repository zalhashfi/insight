import { describe, expect, it } from "vitest";
import { hashToken } from "../../worker/src/platform/lib/tokens";
import {
  InMemoryInviteRepo,
  acceptInvite,
  createInvite,
  isInviteError,
  listInvites,
  revokeInvite,
  type Invite,
  type InviteError,
  type InviteRepo,
  type MembershipGrant,
} from "../../worker/src/domains/identity/invites";
import type { Role } from "../../worker/src/domains/projects/membership";

/**
 * Spec tests for project invitations.
 *
 * The three contracts that carry the weight, and how each is proved behaviourally
 * rather than by prose:
 *
 *   1. **Single use.** The guard is the *conditional* store write, not an
 *      application check. `ConcurrentAcceptRepo` makes `findByHash` yield to a
 *      microtask before it returns, so two accepts genuinely interleave the
 *      read-then-write and both reach the accept — a racy implementation would
 *      hand out two memberships; the conditional `markAccepted` lets exactly
 *      one win.
 *   2. **No plaintext at rest.** The whole store is dumped and searched for the
 *      token; it must come up empty, and the only credential material present
 *      must be the SHA-256 digest `platform/lib/tokens.ts` computes.
 *   3. **Bound to its project/role.** The granted membership is the invite's
 *      own `(projectId, role)`, never anything the accepting caller supplies.
 *
 * The tests drive the in-memory `InviteRepo` fake so the store is fully
 * inspectable; a spy wrapper proves accepts are uncached, and a recording
 * {@link MembershipGrant} proves a refused accept never writes a membership.
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

/**
 * A membership-grant seam that records what it was asked to write, so a test
 * can assert the *exact* `(projectId, userId, role)` an accept produced — and
 * that a refused accept produced *nothing*.
 */
class RecordingGrant implements MembershipGrant {
  readonly grants: Array<{ projectId: string; userId: string; role: Role; now: number }> = [];

  async grant(input: {
    projectId: string;
    userId: string;
    role: Role;
    now: number;
  }): Promise<void> {
    this.grants.push(input);
  }
}

/**
 * A repo whose `findByHash` yields a microtask turn before returning, opening
 * the interleaving window between the domain's read and its conditional write.
 * Without the window a "check `acceptedAt`, then set it" implementation would
 * pass by accident; with it, only the atomic conditional write can keep the
 * accept single-use.
 */
class ConcurrentAcceptRepo extends InMemoryInviteRepo {
  /** Every read the domain performs — the oracle for "was it re-read?" */
  reads = 0;

  override async findByHash(tokenHash: string): Promise<Invite | null> {
    this.reads += 1;
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    return super.findByHash(tokenHash);
  }
}

/** Assert that `fn` rejects with an `InviteError`, and return it. */
async function expectInviteError(fn: () => Promise<unknown>): Promise<InviteError> {
  try {
    await fn();
  } catch (err) {
    expect(isInviteError(err)).toBe(true);
    if (!isInviteError(err)) throw err;
    return err;
  }
  throw new Error("expected an InviteError but the call resolved");
}

/** A fresh repo plus a recording grant — the standard pair for a case. */
function setup() {
  const repo = new InMemoryInviteRepo();
  const grant = new RecordingGrant();
  return { repo, grant };
}

// ---------------------------------------------------------------------------
// Valid invite: accepted ONCE
// ---------------------------------------------------------------------------

describe("acceptInvite — happy path is single-use", () => {
  it("accepts a valid invite once; a second accept is refused 4xx", async () => {
    const { repo, grant } = setup();

    const created = await createInvite(repo, {
      projectId: "prj_a",
      email: "newbie@example.com",
      role: "member",
      invitedBy: "u_admin",
    });

    const accepted = await acceptInvite(repo, grant, {
      token: created.plaintext,
      userId: "u_newbie",
    });

    // The acceptance carries the invite's own project/role and the caller.
    expect(accepted).toMatchObject({
      projectId: "prj_a",
      role: "member",
      userId: "u_newbie",
    });
    expect(accepted.invite.acceptedAt).not.toBeNull();
    expect(grant.grants).toHaveLength(1);
    expect(grant.grants[0]).toMatchObject({
      projectId: "prj_a",
      userId: "u_newbie",
      role: "member",
    });

    // ---- second accept of the SAME token: refused, and no second membership.
    const err = await expectInviteError(() =>
      acceptInvite(repo, grant, { token: created.plaintext, userId: "u_other" }),
    );
    expect(err.code).toBe("invalid_invite");
    expect(err.status).toBeGreaterThanOrEqual(400);
    expect(err.status).toBeLessThan(500);
    expect(grant.grants).toHaveLength(1); // nothing extra was written
  });

  it("under concurrent accepts of one token, EXACTLY one wins", async () => {
    const repo = new ConcurrentAcceptRepo();
    const grant = new RecordingGrant();

    const created = await createInvite(repo, {
      projectId: "prj_race",
      email: "racer@example.com",
      role: "admin",
    });

    // Ten accepts of the same token, all interleaved at the read.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        acceptInvite(repo, grant, { token: created.plaintext, userId: `u_${i}` }),
      ),
    );

    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");

    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(9);
    // The losers are all the same 4xx-class refusal.
    for (const loss of losses) {
      if (loss.status !== "rejected") continue;
      expect(isInviteError(loss.reason)).toBe(true);
      if (isInviteError(loss.reason)) {
        expect(loss.reason.status).toBeGreaterThanOrEqual(400);
        expect(loss.reason.status).toBeLessThan(500);
      }
    }

    // Exactly one membership was granted — no double-join through the race.
    expect(grant.grants).toHaveLength(1);
    expect(grant.grants[0].projectId).toBe("prj_race");
  });

  it("reads the store on every accept (no cache of the consumed invite)", async () => {
    const repo = new ConcurrentAcceptRepo();
    const grant = new RecordingGrant();
    const created = await createInvite(repo, {
      projectId: "prj_uncached",
      email: "x@example.com",
      role: "member",
    });

    await acceptInvite(repo, grant, { token: created.plaintext, userId: "u1" });
    const afterFirst = repo.reads;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // The reuse attempt performs its own fresh read before rejecting.
    await expectInviteError(() =>
      acceptInvite(repo, grant, { token: created.plaintext, userId: "u2" }),
    );
    expect(repo.reads).toBe(afterFirst + 1);
  });
});

// ---------------------------------------------------------------------------
// Expiry & revocation
// ---------------------------------------------------------------------------

describe("acceptInvite — expired and revoked invites are refused 4xx", () => {
  it("rejects an expired invite, honouring the clock seam", async () => {
    const { repo, grant } = setup();

    const created = await createInvite(repo, {
      projectId: "prj_exp",
      email: "late@example.com",
      role: "member",
      expiresAt: 1_000,
    });

    // Just inside the window: accepted.
    const early = await acceptInvite(
      repo,
      grant,
      { token: created.plaintext, userId: "u_early" },
      () => 999,
    );
    expect(early.projectId).toBe("prj_exp");

    // A second, still-live invite proves the boundary exactly at `expiresAt`.
    const boundary = await createInvite(repo, {
      projectId: "prj_exp2",
      email: "boundary@example.com",
      role: "member",
      expiresAt: 2_000,
    });
    expect(
      (
        await acceptInvite(
          repo,
          grant,
          { token: boundary.plaintext, userId: "u_b" },
          () => 1_999,
        )
      ).projectId,
    ).toBe("prj_exp2");

    const expired = await createInvite(repo, {
      projectId: "prj_exp3",
      email: "stale@example.com",
      role: "member",
      expiresAt: 1_000,
    });
    const err = await expectInviteError(() =>
      acceptInvite(
        repo,
        grant,
        { token: expired.plaintext, userId: "u_stale" },
        () => 1_000,
      ),
    );
    expect(err.code).toBe("invalid_invite");
    expect(err.status).toBeGreaterThanOrEqual(400);
    expect(err.status).toBeLessThan(500);
    // Nothing was granted for the expired invite.
    expect(grant.grants.map((g) => g.projectId)).not.toContain("prj_exp3");
  });

  it("rejects a revoked invite even though it is unexpired and unused", async () => {
    const { repo, grant } = setup();

    const created = await createInvite(repo, {
      projectId: "prj_rev",
      email: "revoked@example.com",
      role: "member",
    });

    const revoked = await revokeInvite(repo, created.record.id);
    expect(revoked?.revokedAt).not.toBeNull();

    const err = await expectInviteError(() =>
      acceptInvite(repo, grant, { token: created.plaintext, userId: "u_x" }),
    );
    expect(err.code).toBe("invalid_invite");
    expect(err.status).toBeGreaterThanOrEqual(400);
    expect(err.status).toBeLessThan(500);
    expect(grant.grants).toHaveLength(0);
  });

  it("revoking an unknown id returns null (no throw)", async () => {
    const { repo } = setup();
    expect(await revokeInvite(repo, "inv_missing")).toBeNull();
  });

  it("rejects an unknown token and a near-miss without leaking why", async () => {
    const { repo, grant } = setup();
    const created = await createInvite(repo, {
      projectId: "prj_o",
      email: "o@example.com",
      role: "member",
    });

    const unknown = await expectInviteError(() =>
      acceptInvite(repo, grant, { token: "in_totally_made_up", userId: "u" }),
    );
    const nearMiss = await expectInviteError(() =>
      acceptInvite(repo, grant, {
        token: created.plaintext.slice(0, -1) + "X",
        userId: "u",
      }),
    );

    // Same code and status: the accept path is not an existence oracle.
    expect(unknown.code).toBe("invalid_invite");
    expect(nearMiss.code).toBe("invalid_invite");
    expect(unknown.status).toBe(nearMiss.status);
    expect(grant.grants).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Project / role binding
// ---------------------------------------------------------------------------

describe("acceptInvite — grants exactly the intended project membership/role", () => {
  it("grants the invite's own project and role, never the caller's choice", async () => {
    const { repo, grant } = setup();

    const memberInvite = await createInvite(repo, {
      projectId: "prj_team",
      email: "m@example.com",
      role: "member",
    });
    const adminInvite = await createInvite(repo, {
      projectId: "prj_team",
      email: "a@example.com",
      role: "admin",
    });

    await acceptInvite(repo, grant, { token: memberInvite.plaintext, userId: "u_m" });
    await acceptInvite(repo, grant, { token: adminInvite.plaintext, userId: "u_a" });

    expect(grant.grants).toContainEqual({
      projectId: "prj_team",
      userId: "u_m",
      role: "member",
      now: expect.any(Number),
    });
    expect(grant.grants).toContainEqual({
      projectId: "prj_team",
      userId: "u_a",
      role: "admin",
      now: expect.any(Number),
    });
  });

  it("binds the invite to its project: two projects, no cross-grant", async () => {
    const { repo, grant } = setup();

    await createInvite(repo, { projectId: "prj_1", email: "p1@example.com", role: "member" });
    const p2 = await createInvite(repo, {
      projectId: "prj_2",
      email: "p2@example.com",
      role: "member",
    });

    const accepted = await acceptInvite(repo, grant, {
      token: p2.plaintext,
      userId: "u_p2",
    });

    // Accepting p2's invite never produced a prj_1 membership.
    expect(accepted.projectId).toBe("prj_2");
    expect(grant.grants.every((g) => g.projectId === "prj_2")).toBe(true);
    expect(grant.grants.some((g) => g.projectId === "prj_1")).toBe(false);
  });

  it("refuses to mint an invite at the owner role", async () => {
    const { repo } = setup();
    const err = await expectInviteError(() =>
      createInvite(repo, {
        projectId: "prj_x",
        email: "o@example.com",
        // Cast past the type: a caller coercing the value must still be refused.
        role: "owner" as Role,
      }),
    );
    expect(err.code).toBe("invalid_input");
    expect(err.status).toBe(400);
    expect(repo.raw()).toHaveLength(0);
  });

  it("rejects blank project/email and a duplicate active invite", async () => {
    const { repo } = setup();

    expect(
      (await expectInviteError(() =>
        createInvite(repo, { projectId: "  ", email: "x@example.com", role: "member" }),
      )).code,
    ).toBe("invalid_input");
    expect(
      (await expectInviteError(() =>
        createInvite(repo, { projectId: "prj_d", email: "  ", role: "member" }),
      )).code,
    ).toBe("invalid_input");

    await createInvite(repo, { projectId: "prj_d", email: "dup@example.com", role: "member" });
    const dup = await expectInviteError(() =>
      createInvite(repo, { projectId: "prj_d", email: "DUP@example.com", role: "admin" }),
    );
    expect(dup.code).toBe("already_invited");
    expect(dup.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Secret hygiene: the token is stored hashed, never in plaintext
// ---------------------------------------------------------------------------

describe("createInvite — the token is stored hashed, no plaintext at rest", () => {
  it("stores only the hash; the store contains no plaintext anywhere", async () => {
    const { repo } = setup();

    const created = await createInvite(repo, {
      projectId: "prj_sec",
      email: "sec@example.com",
      role: "admin",
      invitedBy: "u_owner",
    });
    const plaintext = created.plaintext;

    // Dump EVERYTHING the store holds and prove the token is absent.
    const dump = JSON.stringify(repo.raw());
    expect(dump).not.toContain(plaintext);
    expect(collectStrings(repo.raw())).not.toContain(plaintext);

    // ...and the only credential material present is the matching sha-256.
    const [row] = repo.raw();
    expect(row.tokenHash).toBe(await hashToken(plaintext));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(dump).toContain(row.tokenHash);

    // The record shape has no plaintext slot at all.
    expect(Object.keys(row)).not.toContain("plaintext");
    expect(Object.keys(row)).not.toContain("token");
    // Listing a project can never hand the secret back either.
    for (const listed of await listInvites(repo, "prj_sec")) {
      expect(collectStrings(listed)).not.toContain(plaintext);
      expect(listed.tokenHash).toBe(await hashToken(plaintext));
    }
  });

  it("keeps two invites' secrets out of each other's rows", async () => {
    const { repo, grant } = setup();
    const a = await createInvite(repo, { projectId: "prj", email: "a@x.com", role: "member" });
    const b = await createInvite(repo, { projectId: "prj", email: "b@x.com", role: "admin" });

    const dump = JSON.stringify(repo.raw());
    expect(dump).not.toContain(a.plaintext);
    expect(dump).not.toContain(b.plaintext);
    expect(a.plaintext).not.toBe(b.plaintext);

    // Each token still resolves to its own invite, and accepts in isolation.
    expect(await acceptInvite(repo, grant, { token: a.plaintext, userId: "u_a" })).toMatchObject({
      userId: "u_a",
      role: "member",
    });
    expect(await acceptInvite(repo, grant, { token: b.plaintext, userId: "u_b" })).toMatchObject({
      userId: "u_b",
      role: "admin",
    });
  });

  it("returns the plaintext exactly once and a re-read cannot recover it", async () => {
    const { repo } = setup();
    const created = await createInvite(repo, {
      projectId: "prj_once",
      email: "once@example.com",
      role: "member",
    });

    // The plaintext lives ONLY on the create result, never on the record.
    expect(collectStrings(created.record)).not.toContain(created.plaintext);
    expect(created.plaintext).toMatch(/^pt_/);

    const record = await repo.findByHash(await hashToken(created.plaintext));
    expect(record).not.toBeNull();
    expect(collectStrings(record)).not.toContain(created.plaintext);
  });

  it("create is deterministic under injected clock/id seams", async () => {
    const { repo } = setup();
    const { record } = await createInvite(
      repo,
      { projectId: "prj_seed", email: "seed@example.com", role: "member" },
      () => 1_234,
      () => "inv_fixed",
    );
    expect(record.id).toBe("inv_fixed");
    expect(record.createdAt).toBe(1_234);
    expect(record.updatedAt).toBe(1_234);
    expect(record.acceptedAt).toBeNull();
    expect(record.revokedAt).toBeNull();
  });

  it("the in-memory fake refuses a duplicate token_hash (UNIQUE index)", async () => {
    const { repo } = setup();
    const created = await createInvite(repo, {
      projectId: "prj_uniq",
      email: "uniq@example.com",
      role: "member",
    });

    await expect(
      repo.insert({
        id: "inv_clash",
        projectId: "prj_uniq",
        role: "member",
        email: "other@example.com",
        tokenHash: created.record.tokenHash,
        tokenPrefix: "pt_xxxx",
        invitedBy: null,
        expiresAt: null,
        acceptedAt: null,
        revokedAt: null,
        createdAt: 0,
        updatedAt: 0,
      }),
    ).rejects.toThrow();
  });

  it("a spy repo sees the same hash the token hashes to (reused hashing)", async () => {
    const inner = new InMemoryInviteRepo();
    const seen: string[] = [];
    const spy: InviteRepo = {
      insert: (invite) => {
        seen.push(invite.tokenHash);
        return inner.insert(invite);
      },
      findByHash: (hash) => inner.findByHash(hash),
      markAccepted: (id, at) => inner.markAccepted(id, at),
      revoke: (id, at) => inner.revoke(id, at),
      listByProject: (projectId) => inner.listByProject(projectId),
    };

    const created = await createInvite(spy, {
      projectId: "prj_reuse",
      email: "reuse@example.com",
      role: "member",
    });
    expect(seen).toEqual([await hashToken(created.plaintext)]);
  });
});
