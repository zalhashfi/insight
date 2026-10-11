import { describe, expect, it } from "vitest";
import {
  DASHBOARD_STATUS_CODE,
  DashboardError,
  DashboardLock,
  InMemoryDashboardRepo,
  isConflict,
  isDashboardError,
  isRevision,
  type Dashboard,
  type DashboardConflictBody,
  type DashboardRepo,
} from "../../worker/src/domains/dashboards/lock";

/**
 * Spec tests for optimistic locking on dashboard edits
 * (`worker/src/domains/dashboards/lock.ts`, task A?).
 *
 * The domain talks to the {@link DashboardRepo} seam, so these tests drive an
 * in-memory fake with a deterministic, strictly-increasing clock. The rule
 * under test is compare-and-set over an `if_updated_at` precondition:
 *
 *   1. **Concurrent writers** — two updates built from the SAME base revision:
 *      exactly one applies, the other is refused `409`.
 *   2. **Stale vs current** — a stale revision is `409`; a current revision
 *      applies and **bumps** the revision (asserted against the clock).
 *   3. **Conflict shape** — the `409` carries `expected`/`current` and the
 *      documented body; the response shape is frozen here.
 *
 * Denials are asserted through the module's documented convention: entry points
 * **throw** a {@link DashboardError} with a stable `code` (never `{ ok:false }`).
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Build a service over a fresh in-memory repo and a deterministic clock whose
 * every read advances by 1_000ms, so revisions are predictable
 * (`0` on create, then `1_000`, `2_000`, …) and a "bump" is observable.
 */
function setup() {
  const repo: DashboardRepo = new InMemoryDashboardRepo();
  let clock = 0;
  const lock = new DashboardLock(repo, { now: () => (clock += 1_000) });
  const create = (overrides: Partial<Parameters<DashboardLock["create"]>[0]> = {}) =>
    lock.create({ id: "dash_1", projectId: "proj_a", data: { widgets: [] }, ...overrides });
  return { repo, lock, create };
}

/** Assert that `fn` rejects with a DashboardError carrying `code`. */
async function expectDenied(fn: () => Promise<unknown>, code: string): Promise<DashboardError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DashboardError);
    const error = err as DashboardError;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected rejection with code "${code}", but the call resolved`);
}

// ---------------------------------------------------------------------------
// Revision helper & creation
// ---------------------------------------------------------------------------

describe("revision precondition helper", () => {
  it("accepts finite, non-negative numbers and rejects everything else", () => {
    expect(isRevision(0)).toBe(true);
    expect(isRevision(1_752_000_000_000)).toBe(true);

    for (const bad of [-1, NaN, Infinity, -Infinity, undefined, null, "5", {}, []]) {
      expect(isRevision(bad)).toBe(false);
    }
  });
});

describe("create", () => {
  it("creates a board at revision 0, a presentable precondition", async () => {
    const { create } = setup();
    const board = await create({ data: { name: "Ops" } });
    expect(board).toEqual({
      id: "dash_1",
      projectId: "proj_a",
      data: { name: "Ops" },
      updatedAt: 0,
    });
  });

  it("refuses a blank id/project as invalid_input (400)", async () => {
    const { lock } = setup();
    expect((await expectDenied(() => lock.create({ id: "  ", projectId: "p", data: 1 }), "invalid_input")).status).toBe(400);
    await expectDenied(() => lock.create({ id: "d", projectId: "", data: 1 }), "invalid_input");
  });
});

// ---------------------------------------------------------------------------
// The core rule: concurrent writers from one base revision
// ---------------------------------------------------------------------------

describe("two updates from the same base revision", () => {
  it("applies exactly one and refuses the other with 409", async () => {
    const { lock, create } = setup();
    await create(); // revision 0

    // Both writers read the board at revision 0 and race to save.
    const first = await lock.save("dash_1", { ifUpdatedAt: 0, data: { by: "A" } });

    expect(first.updatedAt).toBe(1_000);
    expect(first.data).toEqual({ by: "A" });

    const conflict = await expectDenied(
      () => lock.save("dash_1", { ifUpdatedAt: 0, data: { by: "B" } }),
      "edit_conflict",
    );
    expect(conflict.status).toBe(409);
    expect(conflict.expected).toBe(0);
    expect(conflict.current).toBe(1_000);

    // The loser's payload did NOT land: the store still holds A's write.
    const stored = await lock.get("dash_1");
    expect(stored.data).toEqual({ by: "A" });
    expect(stored.updatedAt).toBe(1_000);
  });

  it("is order-independent: whichever write lands first wins, the second is 409", async () => {
    const { lock, create } = setup();
    await create();

    // Fire both without awaiting in between, as two clients truly would.
    const results = await Promise.allSettled([
      lock.save("dash_1", { ifUpdatedAt: 0, data: "A" }),
      lock.save("dash_1", { ifUpdatedAt: 0, data: "B" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const conflict = (rejected[0] as PromiseRejectedResult).reason as DashboardError;
    expect(isConflict(conflict)).toBe(true);
    expect(conflict.status).toBe(409);
    expect(conflict.expected).toBe(0);
    expect(conflict.current).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// Stale vs current revision
// ---------------------------------------------------------------------------

describe("stale vs current revision", () => {
  it("bumps the revision on every applied save", async () => {
    const { lock, create } = setup();
    await create(); // 0

    const v1 = await lock.save("dash_1", { ifUpdatedAt: 0, data: "v1" });
    expect(v1.updatedAt).toBe(1_000);

    const v2 = await lock.save("dash_1", { ifUpdatedAt: v1.updatedAt, data: "v2" });
    expect(v2.updatedAt).toBe(2_000);

    const v3 = await lock.save("dash_1", { ifUpdatedAt: v2.updatedAt, data: "v3" });
    expect(v3.updatedAt).toBe(3_000);
    expect(v3.data).toBe("v3");
  });

  it("refuses a STALE revision with 409 and mutates nothing", async () => {
    const { lock, create } = setup();
    await create(); // 0
    await lock.save("dash_1", { ifUpdatedAt: 0, data: "v1" }); // -> 1000

    // A writer that still believes revision 0 is stale.
    const conflict = await expectDenied(
      () => lock.save("dash_1", { ifUpdatedAt: 0, data: "stale" }),
      "edit_conflict",
    );
    expect(conflict.expected).toBe(0);
    expect(conflict.current).toBe(1_000);

    const stored = await lock.get("dash_1");
    expect(stored.data).toBe("v1");
    expect(stored.updatedAt).toBe(1_000);
  });

  it("accepts a CURRENT revision and bumps the revision", async () => {
    const { lock, create } = setup();
    await create();
    const v1 = await lock.save("dash_1", { ifUpdatedAt: 0, data: "v1" });

    const v2 = await lock.save("dash_1", { ifUpdatedAt: v1.updatedAt, data: "v2" });
    expect(v2.data).toBe("v2");
    expect(v2.updatedAt).toBeGreaterThan(v1.updatedAt);
  });

  it("lets the loser recover by retrying with the conflict's `current` revision", async () => {
    const { lock, create } = setup();
    await create();
    await lock.save("dash_1", { ifUpdatedAt: 0, data: "A" });

    const conflict = await expectDenied(
      () => lock.save("dash_1", { ifUpdatedAt: 0, data: "B" }),
      "edit_conflict",
    );

    // Retry with the revision the conflict reported — now it applies.
    const retried = await lock.save("dash_1", { ifUpdatedAt: conflict.current!, data: "B" });
    expect(retried.data).toBe("B");
    expect(retried.updatedAt).toBe(2_000);
  });

  it("bumps strictly even when the clock does not advance (coarse-clock safety)", async () => {
    const repo: DashboardRepo = new InMemoryDashboardRepo();
    const frozen = 5_000;
    const lock = new DashboardLock(repo, { now: () => frozen }); // clock never advances
    await lock.create({ id: "d", projectId: "p", data: "v0" });

    const v1 = await lock.save("d", { ifUpdatedAt: 0, data: "v1" });
    expect(v1.updatedAt).toBe(5_000);

    // A second save from the SAME wall-clock instant must still move the
    // revision, or a stale writer could slip through.
    const v2 = await lock.save("d", { ifUpdatedAt: v1.updatedAt, data: "v2" });
    expect(v2.updatedAt).toBe(5_001);
  });
});

// ---------------------------------------------------------------------------
// Precondition required (428) and unknown id (404)
// ---------------------------------------------------------------------------

describe("precondition is mandatory", () => {
  it("refuses a MISSING if_updated_at with missing_precondition (428)", async () => {
    const { lock, create } = setup();
    await create();
    const err = await expectDenied(
      () => lock.save("dash_1", {} as never),
      "missing_precondition",
    );
    expect(err.status).toBe(428);
    // Nothing applied.
    expect((await lock.get("dash_1")).updatedAt).toBe(0);
  });

  it("refuses a GARBAGE if_updated_at (NaN, Infinity, negative, string)", async () => {
    const { lock, create } = setup();
    await create();
    for (const bad of [NaN, Infinity, -1, "0", null, undefined]) {
      await expectDenied(
        () => lock.save("dash_1", { ifUpdatedAt: bad, data: 1 } as never),
        "missing_precondition",
      );
    }
  });

  it("checks the precondition BEFORE the store, so a 428 wins over a 404", async () => {
    const { lock } = setup();
    await expectDenied(() => lock.save("no_such", {} as never), "missing_precondition");
  });
});

describe("unknown dashboard", () => {
  it("is 404 (dashboard_not_found), never a 409", async () => {
    const { lock, create } = setup();
    await create({ id: "exists" });

    const getErr = await expectDenied(() => lock.get("missing"), "dashboard_not_found");
    expect(getErr.status).toBe(404);

    const saveErr = await expectDenied(
      () => lock.save("missing", { ifUpdatedAt: 0, data: 1 }),
      "dashboard_not_found",
    );
    expect(saveErr.status).toBe(404);
    // A 404 is NOT a conflict, so a client does not loop retrying it.
    expect(isConflict(saveErr)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The conflict response shape — documented and frozen
// ---------------------------------------------------------------------------

describe("conflict response shape", () => {
  it("is `{ error: 'edit_conflict', message, expected, current }` under 409", async () => {
    const { lock, create } = setup();
    await create();
    await lock.save("dash_1", { ifUpdatedAt: 0, data: "A" }); // -> 1000

    const conflict = await expectDenied(
      () => lock.save("dash_1", { ifUpdatedAt: 0, data: "B" }),
      "edit_conflict",
    );

    expect(conflict.status).toBe(DASHBOARD_STATUS_CODE.edit_conflict);
    expect(conflict.status).toBe(409);
    expect(isDashboardError(conflict)).toBe(true);
    expect(isConflict(conflict)).toBe(true);

    const body: DashboardConflictBody = conflict.toConflictBody();
    expect(body).toEqual({
      error: "edit_conflict",
      message: "dashboard dash_1 was edited by someone else: if_updated_at 0 != 1000",
      expected: 0,
      current: 1_000,
    });

    // toBody() carries the same fields, widened to every code.
    expect(conflict.toBody()).toEqual(body);

    // The body is exactly serialisable JSON (a route can write it verbatim).
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("toConflictBody() throws when the error is not a conflict", () => {
    const err = new DashboardError("dashboard_not_found", "no such dashboard: x");
    expect(() => err.toConflictBody()).toThrow(/not a conflict/);
  });

  it("carries `expected === current` only for a same-revision no-op, never on a real conflict", async () => {
    const { lock, create } = setup();
    await create();
    const conflict = await expectDenied(
      () => lock.save("dash_1", { ifUpdatedAt: 42, data: "x" }), // board is at 0
      "edit_conflict",
    );
    expect(conflict.expected).toBe(42);
    expect(conflict.current).toBe(0);
    expect(conflict.expected).not.toBe(conflict.current);
  });

  it("returns a non-conflict body with nulled revisions for other codes", async () => {
    const { lock } = setup();
    const notFound = await expectDenied(() => lock.get("nope"), "dashboard_not_found");
    expect(notFound.toBody()).toEqual({
      error: "dashboard_not_found",
      message: "no such dashboard: nope",
      expected: null,
      current: null,
    });
    expect(notFound.isConflict).toBe(false);
  });

  it("maps every code to its HTTP status", () => {
    expect(DASHBOARD_STATUS_CODE).toEqual({
      invalid_input: 400,
      missing_precondition: 428,
      dashboard_not_found: 404,
      edit_conflict: 409,
    });
  });

  it("has a stable `name` and nulled revisions by default", () => {
    const err = new DashboardError("edit_conflict", "boom");
    expect(err.name).toBe("DashboardError");
    expect(err.expected).toBeNull();
    expect(err.current).toBeNull();
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// The in-memory fake is an honest implementation of the seam
// ---------------------------------------------------------------------------

describe("InMemoryDashboardRepo", () => {
  it("rejects duplicate ids on insert (models the PK)", async () => {
    const repo = new InMemoryDashboardRepo();
    const board: Dashboard = { id: "d", projectId: "p", data: 1, updatedAt: 0 };
    await repo.insert(board);
    await expect(repo.insert(board)).rejects.toThrow(/duplicate id/);
  });

  it("cas applies only on a matching revision and returns null otherwise", async () => {
    const repo = new InMemoryDashboardRepo();
    await repo.insert({ id: "d", projectId: "p", data: "v0", updatedAt: 0 });

    expect(await repo.cas("d", 99, "nope", 100)).toBeNull(); // mismatch -> no write
    expect((await repo.get("d"))?.updatedAt).toBe(0);

    const applied = await repo.cas("d", 0, "v1", 10);
    expect(applied).toEqual({ id: "d", projectId: "p", data: "v1", updatedAt: 10 });
  });

  it("cas on an unknown id throws (the service checks existence first)", async () => {
    const repo = new InMemoryDashboardRepo();
    await expect(repo.cas("ghost", 0, 1, 2)).rejects.toThrow(/unknown id/);
  });
});
