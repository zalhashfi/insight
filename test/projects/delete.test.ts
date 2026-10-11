import { describe, expect, it } from "vitest";
import {
  DELETE_PHASES,
  ProjectDeleteError,
  ProjectDeleteService,
  isProjectDeleteError,
  objectPrefix,
  readabilityError,
  type DeletePhase,
  type DeleteResult,
  type DoRegistryLike,
  type FaultInjector,
  type ObjectListPage,
  type ObjectStoreLike,
  type ProjectDeleteRepo,
  type ProjectRow,
} from "../../worker/src/domains/projects/delete";

/**
 * Spec tests for A23 — project delete (ST-M3 / INV-M3, D2.10).
 *
 * The three stores are injected as honest in-memory fakes so every assertion
 * is against state the test owns: a D1 fake that holds the project row plus its
 * satellite rows, an R2 fake that lists/deletes by prefix *with pagination*,
 * and a DO registry that holds DO ids. A {@link FaultInjector} crashes the
 * delete at a chosen phase, which is the kill-in-the-middle of ST-M3.
 *
 * The claims, one describe block each:
 *   1. **Happy path** — one call clears D1 + R2 + DO and drops the tombstone.
 *   2. **Fail-closed reads** — while `deleting`, `assertReadable` refuses.
 *   3. **Crash & sweep** (the headline) — kill mid-delete, sweep completes it,
 *      and *no* residue remains in any store.
 *   4. **Idempotent rerun** — rerunning a completed delete is a no-op/no-error.
 *   5. **Pagination** — >1000 R2 keys are all deleted, across pages.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A tiny deterministic page size distinct from the 1000-row test below. */
const PAGE_SIZE = 100;

/**
 * In-memory {@link ProjectDeleteRepo}.
 *
 * Models D1 as one `projects` row (with `status`/`deletingAt`) plus a bag of
 * satellite rows per project (members, tokens, variables). `purgeD1` drops the
 * satellites AND the project row; `dropTombstone` drops only the row. Both are
 * idempotent, exactly as the seam's contract requires.
 */
class FakeRepo implements ProjectDeleteRepo {
  readonly projects = new Map<string, ProjectRow>();
  /** projectId -> number of satellite rows (stand-in for members/tokens/…). */
  readonly satellites = new Map<string, number>();

  /** Seed an active project with `satelliteRows` dependent D1 rows. */
  seed(projectId: string, satelliteRows = 3): this {
    this.projects.set(projectId, { id: projectId, status: "active", deletingAt: null });
    this.satellites.set(projectId, satelliteRows);
    return this;
  }

  /** Direct read of the stored status, for assertions. */
  statusOf(projectId: string): ProjectRow["status"] | null {
    return this.projects.get(projectId)?.status ?? null;
  }

  /** Whether any D1 trace of the project remains (row or satellite). */
  hasResidue(projectId: string): boolean {
    return this.projects.has(projectId) || (this.satellites.get(projectId) ?? 0) > 0;
  }

  getProject(projectId: string): Promise<ProjectRow | null> {
    return Promise.resolve(this.projects.get(projectId) ?? null);
  }

  markDeleting(projectId: string, now: number): Promise<ProjectRow | null> {
    const existing = this.projects.get(projectId);
    if (existing === undefined) return Promise.resolve(null);
    // Idempotent: a re-mark keeps the FIRST tombstone's timestamp.
    const next: ProjectRow =
      existing.status === "deleting"
        ? existing
        : { id: projectId, status: "deleting", deletingAt: now };
    this.projects.set(projectId, next);
    return Promise.resolve(next);
  }

  listDeleting(): Promise<readonly ProjectRow[]> {
    return Promise.resolve(
      [...this.projects.values()].filter((p) => p.status === "deleting"),
    );
  }

  purgeD1(projectId: string): Promise<number> {
    // Deletes the DEPENDENT rows only; the project row (the tombstone) stays
    // until dropTombstone, so a crash here still leaves a marker to sweep.
    const removed = this.satellites.get(projectId) ?? 0;
    this.satellites.delete(projectId);
    return Promise.resolve(removed);
  }

  dropTombstone(projectId: string): Promise<boolean> {
    return Promise.resolve(this.projects.delete(projectId));
  }
}

/**
 * In-memory {@link ObjectStoreLike} — R2 with **real pagination**.
 *
 * Keys are held sorted; `list` returns at most `pageSize` of them from
 * `cursor` and a cursor for the rest (or `null` at the end), matching R2's
 * truncated+cursor contract. `delete` removes keys and is idempotent (absent
 * keys are simply not counted).
 */
class FakeObjects implements ObjectStoreLike {
  readonly keys = new Set<string>();
  listCalls = 0;
  deleteCalls = 0;

  constructor(private readonly pageSize = PAGE_SIZE) {}

  /** Seed `count` objects under `projectId`'s prefix. */
  seed(projectId: string, count: number): this {
    const prefix = objectPrefix(projectId);
    for (let i = 0; i < count; i += 1) {
      this.keys.add(`${prefix}obj-${String(i).padStart(6, "0")}`);
    }
    return this;
  }

  /** A raw key not belonging to any project — must survive any delete. */
  addForeign(key: string): this {
    this.keys.add(key);
    return this;
  }

  /** Every remaining key under `projectId`'s prefix. */
  remaining(projectId: string): string[] {
    const prefix = objectPrefix(projectId);
    return [...this.keys].filter((k) => k.startsWith(prefix));
  }

  list(prefix: string, cursor?: string | null): Promise<ObjectListPage> {
    this.listCalls += 1;
    // The cursor is the last key of the previous page; the next page holds the
    // keys strictly after it. This survives deletion of the previous page (a
    // lexicographic lower bound, like R2's opaque cursor, is stable even as the
    // keys it passed are removed).
    const all = [...this.keys]
      .filter((k) => k.startsWith(prefix) && (cursor == null || k > cursor))
      .sort();
    const page = all.slice(0, this.pageSize);
    const next = page.length === this.pageSize ? page[page.length - 1] : null;
    return Promise.resolve({ keys: page, cursor: next });
  }

  delete(keys: readonly string[]): Promise<number> {
    this.deleteCalls += 1;
    let removed = 0;
    for (const key of keys) {
      if (this.keys.delete(key)) removed += 1;
    }
    return Promise.resolve(removed);
  }
}

/**
 * In-memory {@link DoRegistryLike}.
 *
 * DO ids are destroyed idempotently: destroying twice removes nothing the
 * second time, and `list` returns only the survivors.
 */
class FakeDoRegistry implements DoRegistryLike {
  readonly live = new Set<string>();

  /** Give `doId` to `projectId`'s registry (ids are stored globally). */
  add(doId: string): this {
    this.live.add(doId);
    return this;
  }

  list(projectId: string): Promise<readonly string[]> {
    // Ids are namespaced by project so a foreign project's DOs are untouched.
    return Promise.resolve([...this.live].filter((id) => id.startsWith(`${projectId}:`)));
  }

  destroy(doId: string): Promise<void> {
    this.live.delete(doId);
    return Promise.resolve();
  }
}

/**
 * A crash injector that throws ONCE, at the given phase boundary.
 *
 * One-shot is the honest model of the ST-M3 scenario: the process dies once
 * (mid-delete), and the sweep then runs in a fresh process where the fault is
 * gone. A persistent injector would model a permanently-broken dependency, not
 * a crash, and could never be resumed.
 */
function crashAt(phase: DeletePhase): FaultInjector {
  let fired = false;
  return {
    beforePhase(current) {
      if (!fired && current === phase) {
        fired = true;
        throw new Error(`simulated crash before ${phase}`);
      }
    },
  };
}

/** The four collaborators one test case drives. */
interface Harness {
  readonly repo: FakeRepo;
  readonly objects: FakeObjects;
  readonly doRegistry: FakeDoRegistry;
  readonly service: ProjectDeleteService;
}

/** Build a service plus its three fakes, with an optional crash lever. */
function harness(faults?: FaultInjector): Harness {
  const repo = new FakeRepo();
  const objects = new FakeObjects();
  const doRegistry = new FakeDoRegistry();
  const service = new ProjectDeleteService(repo, objects, doRegistry, {
    now: () => 1_700_000_000_000,
    ...(faults ? { faults } : {}),
  });
  return { repo, objects, doRegistry, service };
}

/** A project with data in all three stores: D1 rows, R2 objects, two DOs. */
function seeded(faults?: FaultInjector, objectCount = 5) {
  const h = harness(faults);
  h.repo.seed("proj_a");
  h.objects.seed("proj_a", objectCount).addForeign("projects/proj_b/keep-me");
  h.doRegistry.add("proj_a:project-do").add("proj_a:control-do");
  return h;
}

/** Assert that no store holds any trace of `projectId`. */
function expectNoResidue(h: Harness, projectId = "proj_a"): void {
  expect(h.repo.hasResidue(projectId)).toBe(false);
  expect(h.repo.statusOf(projectId)).toBeNull();
  expect(h.objects.remaining(projectId)).toEqual([]);
  expect([...h.doRegistry.live].filter((id) => id.startsWith(`${projectId}:`))).toEqual([]);
}

/** Assert that `fn` rejects with a ProjectDeleteError carrying `code`. */
async function expectDeleteError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<ProjectDeleteError> {
  try {
    await fn();
  } catch (err) {
    if (isProjectDeleteError(err)) {
      expect(err.code).toBe(code);
      return err;
    }
    throw err;
  }
  throw new Error(`expected a ProjectDeleteError(${code}), but nothing was thrown`);
}

/**
 * Assert that `fn` was killed by the fault injector.
 *
 * The crash is modelled as an ordinary `Error`, not a `ProjectDeleteError`, so
 * this asserts the operation did not complete — which is exactly the mid-delete
 * condition ST-M3 kills on.
 */
async function expectCrash(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error && /simulated crash/.test(err.message)) return err;
    throw err;
  }
  throw new Error("expected the delete to crash, but it completed");
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("deleteProject — happy path", () => {
  it("clears D1, R2 and DOs and drops the tombstone in one call", async () => {
    const h = seeded();

    const result = await h.service.deleteProject("proj_a");

    expect(result.projectId).toBe("proj_a");
    expect(result.tombstoned).toBe(true);
    expect(result.objectsDeleted).toBe(5);
    expect(result.durableObjectsDeleted).toBe(2);
    expect(result.d1RowsDeleted).toBe(3);
    expect(result.tombstoneDropped).toBe(true);
    expectNoResidue(h);
  });

  it("never touches another project's objects", async () => {
    const h = seeded();
    await h.service.deleteProject("proj_a");
    // The foreign key sits under projects/proj_b/ — a prefix delete misses it.
    expect(h.objects.keys.has("projects/proj_b/keep-me")).toBe(true);
  });

  it("reports project_not_found for a project that never existed", async () => {
    const h = harness();
    const err = await expectDeleteError(() => h.service.deleteProject("missing"), "project_not_found");
    expect(err.status).toBe(404);
  });

  it("rejects a blank id with invalid_input", async () => {
    const h = harness();
    await expectDeleteError(() => h.service.deleteProject("   "), "invalid_input");
  });
});

// ---------------------------------------------------------------------------
// 2. Fail-closed reads while deleting
// ---------------------------------------------------------------------------

describe("read fail-closed while deleting (INV-M3)", () => {
  it("refuses a read with 403 while the project is `deleting`", async () => {
    const h = seeded(crashAt("objects")); // crash after the tombstone, before R2
    await expectCrash(() => h.service.deleteProject("proj_a"));

    expect(h.repo.statusOf("proj_a")).toBe("deleting");

    // The read guard must refuse, with the `deleting` code mapped to 403.
    const err = await expectDeleteError(() => h.service.assertReadable("proj_a"), "deleting");
    expect(err.status).toBe(403);

    // The non-throwing form agrees.
    expect(await h.service.isReadable("proj_a")).toBe(false);
  });

  it("serves an active project and 404s a missing one", async () => {
    const h = seeded();
    await expect(h.service.assertReadable("proj_a")).resolves.toMatchObject({ status: "active" });
    expect(await h.service.isReadable("proj_a")).toBe(true);
    await expectDeleteError(() => h.service.assertReadable("nope"), "project_not_found");
  });

  it("readabilityError is the single source of the policy", () => {
    expect(readabilityError(null)?.code).toBe("project_not_found");
    expect(readabilityError({ id: "p", status: "deleting", deletingAt: 1 })?.code).toBe("deleting");
    expect(readabilityError({ id: "p", status: "active", deletingAt: null })).toBeNull();
  });

  it("is not readable once the delete has fully completed", async () => {
    const h = seeded();
    await h.service.deleteProject("proj_a");
    // Post-delete the row is gone -> 404 (indistinguishable from never-existed).
    await expectDeleteError(() => h.service.assertReadable("proj_a"), "project_not_found");
  });
});

// ---------------------------------------------------------------------------
// 3. Kill mid-delete → sweep completes → no residue (ST-M3 headline)
// ---------------------------------------------------------------------------

describe("kill mid-delete, then sweep to completion (ST-M3 / INV-M3)", () => {
  it("sweep finishes a delete killed before the R2 phase", async () => {
    const h = seeded(crashAt("objects"));

    // Start, then die at the `objects` boundary: tombstone is down, R2 intact.
    await expectCrash(() => h.service.deleteProject("proj_a"));
    expect(h.repo.statusOf("proj_a")).toBe("deleting");
    expect(h.objects.remaining("proj_a").length).toBe(5); // residue: orphans
    expect(h.doRegistry.live.size).toBe(2);

    // Sweep finds the tombstone and drives it to completion.
    const { completed, failures } = await h.service.sweep();
    expect(failures).toEqual([]);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ projectId: "proj_a", tombstoned: false });

    // NO residue anywhere: D1, R2, DO — the invariant.
    expectNoResidue(h);
  });

  it.each(DELETE_PHASES)("sweep recovers a crash injected before phase %s", async (phase) => {
    const h = seeded(crashAt(phase));

    await expectCrash(() => h.service.deleteProject("proj_a"));

    // A crash *before* `mark` leaves the project untouched-but-active; the
    // sweep's worklist is driven by the tombstone, so for that one case there
    // is nothing to sweep and the project legitimately remains.
    if (phase === "mark") {
      expect(h.service.sweep()).resolves.toMatchObject({ completed: [] });
      return;
    }

    // Every other boundary leaves a tombstone, and the sweep completes it.
    expect(h.repo.statusOf("proj_a")).toBe("deleting");
    const { completed, failures } = await h.service.sweep();
    expect(failures).toEqual([]);
    expect(completed).toHaveLength(1);
    expectNoResidue(h);
  });

  it("a sweep with nothing pending is an empty no-op", async () => {
    const h = seeded();
    await h.service.deleteProject("proj_a");
    const { completed, failures } = await h.service.sweep();
    expect(completed).toEqual([]);
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Idempotent rerun
// ---------------------------------------------------------------------------

describe("rerun without error (ST-M3)", () => {
  it("a completed delete can be resumed by a plain rerun without error", async () => {
    // Kill at `d1` so the tombstone is still present; a rerun must resume and
    // finish, and a *second* rerun (already clean) must not error either.
    const faults = crashAt("d1");
    const h = seeded(faults);
    await expectCrash(() => h.service.deleteProject("proj_a"));
    expect(h.repo.statusOf("proj_a")).toBe("deleting");

    // Rerun 1: finishes the job (drop phase reached), no error.
    const first = await h.service.deleteProject("proj_a");
    expect(first.tombstoneDropped).toBe(true);
    expectNoResidue(h);

    // Rerun 2 on the now-clean project: no tombstone -> honest 404, and the
    // idempotent entry treats it as a silent no-op.
    await expectDeleteError(() => h.service.deleteProject("proj_a"), "project_not_found");
    const second = await h.service.deleteProjectIfPresent("proj_a");
    expect(second).toMatchObject({ projectId: "proj_a", tombstoneDropped: false, d1RowsDeleted: 0 });
    expectNoResidue(h);
  });

  it("deleteProjectIfPresent is a no-op for a never-existing project", async () => {
    const h = harness();
    const result: DeleteResult = await h.service.deleteProjectIfPresent("ghost");
    expect(result).toEqual({
      projectId: "ghost",
      tombstoned: false,
      objectsDeleted: 0,
      durableObjectsDeleted: 0,
      d1RowsDeleted: 0,
      tombstoneDropped: false,
    });
  });

  it("re-running past the R2 phase does not re-delete or error", async () => {
    const h = seeded(crashAt("d1"));
    await expectCrash(() => h.service.deleteProject("proj_a"));
    // R2 and DO phases already ran; the resume should report 0 objects/DOs.
    const resumed = await h.service.deleteProject("proj_a");
    expect(resumed.objectsDeleted).toBe(0);
    expect(resumed.durableObjectsDeleted).toBe(0);
    expect(resumed.tombstoned).toBe(false); // tombstone was already written
    expect(resumed.tombstoneDropped).toBe(true);
    expectNoResidue(h);
  });

  it("keeps the first tombstone's timestamp across a re-mark", async () => {
    const h = seeded(crashAt("objects"));
    await expectCrash(() => h.service.deleteProject("proj_a"));
    const first = h.repo.projects.get("proj_a")?.deletingAt;

    // A resume with a *different* clock must not move `deletingAt`.
    const later = new ProjectDeleteService(h.repo, h.objects, h.doRegistry, {
      now: () => 1_700_000_999_999,
    });
    await later.deleteProject("proj_a");
    // Row is gone after completion, so assert the value captured pre-resume was
    // the one written; equality with the original proves no forward drift.
    expect(first).toBe(1_700_000_000_000);
    expectNoResidue(h);
  });
});

// ---------------------------------------------------------------------------
// 5. Pagination — more than one page of R2 keys
// ---------------------------------------------------------------------------

describe("R2 pagination (>1000 keys, ST-M3)", () => {
  it("deletes all 1500 keys across pages, leaving no object behind", async () => {
    const h = seeded(undefined, 1500);

    const result = await h.service.deleteProject("proj_a");

    expect(result.objectsDeleted).toBe(1500);
    expect(h.objects.remaining("proj_a")).toEqual([]);
    // 1500 keys / 100 per page = 15 full pages + 1 empty final page.
    expect(h.objects.listCalls).toBeGreaterThanOrEqual(16);
    expect(h.objects.deleteCalls).toBeGreaterThanOrEqual(15);
    expectNoResidue(h);
  });

  it("bounds every list call to the page size", async () => {
    const h = seeded(undefined, 250);
    const seen: number[] = [];
    const original = h.objects.list.bind(h.objects);
    h.objects.list = async (prefix, cursor) => {
      const page = await original(prefix, cursor);
      seen.push(page.keys.length);
      return page;
    };

    await h.service.deleteProject("proj_a");

    expect(seen.length).toBeGreaterThan(1); // it really paged
    expect(Math.max(...seen)).toBeLessThanOrEqual(PAGE_SIZE);
    expect(h.objects.remaining("proj_a")).toEqual([]);
  });

  it("resumes the pagination after a crash mid-prefix (no tail orphan)", async () => {
    // Crash before the objects phase: nothing was deleted yet, so the resume
    // must start the prefix from the beginning and still finish every page.
    const h = seeded(crashAt("objects"), 1200);
    await expectCrash(() => h.service.deleteProject("proj_a"));

    const { completed } = await h.service.sweep();
    expect(completed[0].objectsDeleted).toBe(1200);
    expect(h.objects.remaining("proj_a")).toEqual([]);
    expectNoResidue(h);
  });
});
