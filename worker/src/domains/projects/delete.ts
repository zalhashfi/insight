/**
 * A23 — project delete: tombstone-first, idempotent, resumable (D2.10, INV-M3).
 *
 * Deleting a project means deleting its data from *four* stores that share no
 * transaction: the D1 metadata rows, the R2 object prefix (telemetry cold
 * store, firmware images), the project's Durable Object(s), and the KV cache.
 * There is no way to do that atomically, and the interesting case is not the
 * happy path — it is the crash in the middle: D1 says "gone" while R2 still
 * holds a thousand objects, so a later reader resurrects the tenant and the
 * bytes are billed forever. That is the orphan this module exists to prevent.
 *
 * ## The shape (tombstone-first)
 *
 * The order is load-bearing and is the whole design:
 *
 *   1. **Mark `deleting` first** ("tombstone"). This is a single durable
 *      write to D1, before any bulk work. It is *not* an optimisation — it is
 *      what makes the operation crash-safe: from this instant the project is
 *      known to be mid-deletion by *anything* that looks it up, so reads can
 *      fail closed (see {@link ProjectDeleteService.assertReadable}) and a
 *      sweep can find the unfinished work.
 *   2. **Delete the R2 prefix**, paginated. R2 `list` returns at most a page of
 *      keys; we loop on the cursor until it is exhausted, deleting each page.
 *      Idempotent: deleting an already-absent key is not an error.
 *   3. **Delete the Durable Objects.** Idempotent: destroying a DO that is
 *      already gone is a no-op.
 *   4. **Delete the D1 dependent rows** (members, tokens, variables). The
 *      project row itself is *not* touched here: it carries the tombstone and
 *      must outlive the R2/DO phase so a crash still leaves a marker to resume
 *      from. It is removed in the final step.
 *   5. **Drop the tombstone** (delete the project row). Only now is the project
 *      truly gone — every store is clean and there is nothing left for a sweep
 *      to find.
 *
 * ## Why that is resumable
 *
 * A crash between any two steps leaves the tombstone in D1. The next
 * {@link ProjectDeleteService.deleteProject} — a retry, or a
 * {@link ProjectDeleteService.sweep} pass — re-runs *all* the phases from the
 * tombstone, and every phase is idempotent:
 *
 *   * re-marking `deleting` is a no-op (already deleted-marked);
 *   * deleting R2 keys that are gone is a no-op;
 *   * destroying a DO that is gone is a no-op;
 *   * deleting D1 dependent rows that are gone is a no-op;
 *   * dropping an absent tombstone is a no-op.
 *
 * So the operation converges: run it any number of times, interleaved with any
 * crashes, and it ends in exactly one state — everything gone, tombstone
 * dropped. That convergence is INV-M3 ("partial failure leaves no orphan").
 *
 * ## Seams
 *
 * Nothing here talks to a binding directly. The three stores are injected as
 * {@link ProjectDeleteRepo} (D1), {@link ObjectStoreLike} (R2) and
 * {@link DoRegistryLike} (the DO registry + KV). Tests inject honest in-memory
 * fakes; production injects the D1/R2/DO adapters. A {@link FaultInjector}
 * seam lets a test crash the operation at a named step to prove the resume.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable, machine-readable failure codes for the project-delete domain. */
export type ProjectDeleteErrorCode = "invalid_input" | "project_not_found" | "deleting" | "gone";

/**
 * Lookup of a {@link ProjectDeleteErrorCode} onto an HTTP status.
 *
 * `deleting` and `gone` are the *fail-closed read* codes (INV-M3): while a
 * project is mid-delete a read must not see the half-gone tenant, and once the
 * delete finished the project must read as absent, not as a stale shell.
 */
export const PROJECT_DELETE_STATUS: Record<ProjectDeleteErrorCode, number> = {
  invalid_input: 400,
  project_not_found: 404,
  // Mid-delete: the tenant is being torn down; a read is refused `403` (the
  // caller is authenticated but the resource is not servable right now).
  deleting: 403,
  // Deleted: indistinguishable from "never existed" to a reader -> 404.
  gone: 404,
};

/** Error thrown by every failing entry point of this module. */
export class ProjectDeleteError extends Error {
  /** Stable code suitable for mapping onto an HTTP response. */
  readonly code: ProjectDeleteErrorCode;

  /** HTTP status corresponding to {@link code}. */
  readonly status: number;

  constructor(code: ProjectDeleteErrorCode, message: string) {
    super(message);
    this.name = "ProjectDeleteError";
    this.code = code;
    this.status = PROJECT_DELETE_STATUS[code];
  }
}

/** Convenience guard for `catch` blocks. */
export function isProjectDeleteError(err: unknown): err is ProjectDeleteError {
  return err instanceof ProjectDeleteError;
}

// ---------------------------------------------------------------------------
// Lifecycle status & tombstone
// ---------------------------------------------------------------------------

/**
 * The lifecycle status of a project row.
 *
 *   * `active`   — normal; readable and writable.
 *   * `deleting` — the tombstone. Set first, dropped last; every read fails
 *                  closed and every delete phase re-runs until it is clear.
 */
export const PROJECT_STATUSES = ["active", "deleting"] as const;

/** A project lifecycle status. */
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Type guard: is `value` a known project status? */
export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}

/** The D1 row state this module reads and mutates. */
export interface ProjectRow {
  readonly id: string;
  readonly status: ProjectStatus;
  /** Epoch ms the tombstone was written; `null` while `active`. */
  readonly deletingAt: number | null;
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Storage seam for the D1 metadata half — the tombstone's home and the last
 * store to be purged.
 *
 * Every method is scoped by `projectId`, and every mutating method is
 * **idempotent** as a *contract of the seam*: a production adapter achieves
 * that with `UPDATE ... WHERE status != 'deleting'` (no-op when already
 * marked) and `DELETE ... WHERE project_id = ?` (no-op when already gone), so
 * this module never has to guard against a re-run producing an error.
 */
export interface ProjectDeleteRepo {
  /** The project row, or `null` when there is no such project at all. */
  getProject(projectId: string): Promise<ProjectRow | null>;

  /**
   * Write the tombstone: set `status = 'deleting'` and stamp `deletingAt`.
   *
   * Idempotent: marking an already-`deleting` project is a no-op that does not
   * move `deletingAt` (the *first* tombstone wins, so a re-run cannot push the
   * timestamp forward). Returns the stored row, or `null` when the project does
   * not exist.
   */
  markDeleting(projectId: string, now: number): Promise<ProjectRow | null>;

  /** Every project currently in the `deleting` state — the sweep's worklist. */
  listDeleting(): Promise<readonly ProjectRow[]>;

  /**
   * Delete the project's *dependent* D1 rows — members, tokens, variables —
   * leaving the project row itself in place.
   *
   * The project row is deliberately NOT touched here: it *is* the tombstone
   * (`status = 'deleting'`), and dropping it is a separate, final phase
   * ({@link dropTombstone}). Splitting the two is what keeps the tombstone
   * alive across the whole destructive sequence, so a crash after this phase
   * still leaves a marker for the sweep to find.
   *
   * Idempotent: rows that are already absent are not an error. Returns the
   * number of dependent rows removed (`0` on a re-run).
   */
  purgeD1(projectId: string): Promise<number>;

  /**
   * Drop the tombstone — delete the project row itself. The final phase.
   *
   * Idempotent and a no-op when the row is already gone. Returns whether a row
   * was actually removed by *this* call, so a resumed delete reports honestly
   * which attempt did the final step.
   */
  dropTombstone(projectId: string): Promise<boolean>;
}

/** One page of an object-store listing. */
export interface ObjectListPage {
  /** Keys in this page, in the store's deterministic order. */
  readonly keys: readonly string[];
  /**
   * Continuation cursor for the next page, or `null` when the listing is
   * exhausted. Mirrors R2's `truncated` + `cursor`: a caller loops on the
   * cursor and stops when it is `null`.
   */
  readonly cursor: string | null;
}

/**
 * Object-store seam (R2 in production).
 *
 * Deliberately a `list` + `delete` pair, mirroring R2's own surface: `list`
 * is *paginated* (a single call never returns an unbounded number of keys) and
 * `delete` takes a batch of keys and is **idempotent** — deleting a key that is
 * already absent succeeds, so a crash-and-resume that re-deletes a page is
 * harmless.
 *
 * The pagination is not optional: a project may hold far more than one page of
 * objects (ST-M3 asserts >1000), so an implementation that deleted only the
 * first page would leave an orphan — exactly the failure INV-M3 forbids.
 */
export interface ObjectStoreLike {
  /** One page of keys under `prefix`, starting at `cursor` (or the start). */
  list(prefix: string, cursor?: string | null): Promise<ObjectListPage>;
  /** Delete `keys`; absent keys are not an error. Returns how many existed. */
  delete(keys: readonly string[]): Promise<number>;
}

/**
 * Durable Object registry seam.
 *
 * A project owns zero or more DOs (its projection and control-plane instances).
 * The registry can enumerate them for a project and destroy them. Both
 * operations are **idempotent**: a `destroy` of an already-destroyed DO is a
 * no-op, so a resumed delete re-destroying a DO does not error.
 */
export interface DoRegistryLike {
  /** The DO ids owned by `projectId` (empty when none / already destroyed). */
  list(projectId: string): Promise<readonly string[]>;
  /** Destroy one DO id. Idempotent: a destroyed id is a no-op. */
  destroy(doId: string): Promise<void>;
}

/**
 * The four phases of the delete, in the order they run.
 *
 * Named as data so a {@link FaultInjector} can crash at a *phase boundary* and
 * a test can assert exactly which re-run performed the remaining work.
 */
export const DELETE_PHASES = [
  "mark",
  "objects",
  "durable_objects",
  "d1",
  "drop",
] as const;

/** One of the delete phases, in order. */
export type DeletePhase = (typeof DELETE_PHASES)[number];

/**
 * Fault-injection seam — the crash test's lever.
 *
 * `beforePhase` is called immediately *before* a phase runs; throwing from it
 * models a process death at that boundary (the phase does not run, and phases
 * after it do not run either). Defaults to a no-op, so production never pays
 * for it and a test injects a single `throw` at the phase it wants to kill.
 */
export interface FaultInjector {
  beforePhase?(phase: DeletePhase, projectId: string): Promise<void> | void;
}

/** Options for {@link ProjectDeleteService}. */
export interface ProjectDeleteServiceOptions {
  /** Clock, `Date.now` by default; injected so tests pin `deletingAt`. */
  readonly now?: () => number;
  /** Key prefix for a project's R2 objects. Defaults to {@link objectPrefix}. */
  readonly objectPrefix?: (projectId: string) => string;
  /** Crash lever, invoked before each phase. Defaults to a no-op. */
  readonly faults?: FaultInjector;
}

/** What one {@link ProjectDeleteService.deleteProject} (or sweep) call did. */
export interface DeleteResult {
  readonly projectId: string;
  /** `true` when this call wrote the tombstone; `false` when resuming one. */
  readonly tombstoned: boolean;
  /** R2 keys deleted across all pages. */
  readonly objectsDeleted: number;
  /** DO ids destroyed. */
  readonly durableObjectsDeleted: number;
  /** D1 dependent rows purged (`0` on a resume past the D1 phase). */
  readonly d1RowsDeleted: number;
  /** `true` when the tombstone was dropped by this call. */
  readonly tombstoneDropped: boolean;
}

/**
 * The writable twin of {@link DeleteResult}, used only inside
 * {@link ProjectDeleteService.deleteProject} to accumulate a run's tallies
 * phase by phase before returning them as the immutable result.
 */
interface DeleteTally {
  projectId: string;
  tombstoned: boolean;
  objectsDeleted: number;
  durableObjectsDeleted: number;
  d1RowsDeleted: number;
  tombstoneDropped: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The deterministic R2 key prefix under which a project's objects live.
 *
 * A pure function of the project id — no clock, no random — so the delete and
 * any future writer agree on the prefix without a shared constant drifting.
 */
export function objectPrefix(projectId: string): string {
  return `projects/${projectId}/`;
}

/**
 * Is `project` readable right now? — the fail-closed predicate.
 *
 * Returns `null` when the project may be read, or the {@link ProjectDeleteError}
 * to raise when it may not:
 *
 *   * no row at all  → `project_not_found` (404);
 *   * `deleting`     → `deleting`            (403) — mid-teardown, unservable;
 *
 * An `active` row is readable. Kept as a pure function (not folded into the
 * service's method) so a route can gate on it without constructing a service,
 * and so the policy has one home.
 */
export function readabilityError(project: ProjectRow | null): ProjectDeleteError | null {
  if (project === null) {
    return new ProjectDeleteError("project_not_found", "no such project");
  }
  if (project.status === "deleting") {
    return new ProjectDeleteError("deleting", `project ${project.id} is being deleted`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Project deletion use cases.
 *
 * All public methods are async and follow the throw-on-failure convention of
 * the sibling `projects/membership.ts`: a denial or a missing project throws a
 * typed {@link ProjectDeleteError} carrying a stable `code` and an HTTP
 * `status`.
 */
export class ProjectDeleteService {
  readonly #repo: ProjectDeleteRepo;
  readonly #objects: ObjectStoreLike;
  readonly #doRegistry: DoRegistryLike;
  readonly #now: () => number;
  readonly #prefix: (projectId: string) => string;
  readonly #faults: FaultInjector;

  constructor(
    repo: ProjectDeleteRepo,
    objects: ObjectStoreLike,
    doRegistry: DoRegistryLike,
    options: ProjectDeleteServiceOptions = {},
  ) {
    this.#repo = repo;
    this.#objects = objects;
    this.#doRegistry = doRegistry;
    this.#now = options.now ?? (() => Date.now());
    this.#prefix = options.objectPrefix ?? objectPrefix;
    this.#faults = options.faults ?? {};
  }

  /**
   * Read-guard: return the project row, or throw the fail-closed error.
   *
   * A caller that mutates or serves a project calls this *first*: a project
   * that is missing → `project_not_found` (404), and one mid-delete → `deleting`
   * (403). There is no window in which a `deleting` project is readable — the
   * tombstone is written before any destructive work and dropped only after all
   * of it, so the guard is correct for the entire duration of a delete.
   */
  async assertReadable(projectId: string): Promise<ProjectRow> {
    const id = projectId?.trim();
    if (!id) throw new ProjectDeleteError("invalid_input", "projectId is required");
    const project = await this.#repo.getProject(id);
    const blocked = readabilityError(project);
    if (blocked) throw blocked;
    // `blocked` is null only for an existing, non-`deleting` row.
    return project as ProjectRow;
  }

  /** Non-throwing form of {@link assertReadable}. */
  async isReadable(projectId: string): Promise<boolean> {
    try {
      await this.assertReadable(projectId);
      return true;
    } catch (err) {
      if (isProjectDeleteError(err)) return false;
      throw err;
    }
  }

  /**
   * Delete a project — the tombstone-first, resumable sequence.
   *
   * Safe to call on a project that is already mid-delete (a retry, or a sweep
   * pass): it *resumes* rather than restarting, because every phase is
   * idempotent and the tombstone names the work.
   *
   * Throws `project_not_found` when there is no such project and no tombstone
   * to resume — i.e. it was already fully deleted, or never existed. A second
   * call *after a completed delete* therefore throws `project_not_found`, which
   * is the honest answer ("there is nothing here"); a caller that wants a
   * rerun to be a silent no-op uses {@link deleteProjectIfPresent}.
   *
   * Returns a {@link DeleteResult} describing what *this* call did, so a sweep
   * can report progress and a test can assert which phases ran.
   */
  async deleteProject(projectId: string): Promise<DeleteResult> {
    const id = projectId?.trim();
    if (!id) throw new ProjectDeleteError("invalid_input", "projectId is required");

    const existing = await this.#repo.getProject(id);
    if (existing === null) {
      // No row and no tombstone: nothing to delete, and certainly nothing to
      // resume. (A tombstone IS a row, so a mid-delete project is not `null`.)
      throw new ProjectDeleteError("project_not_found", `no such project: ${id}`);
    }

    const result: DeleteTally = {
      projectId: id,
      tombstoned: false,
      objectsDeleted: 0,
      durableObjectsDeleted: 0,
      d1RowsDeleted: 0,
      tombstoneDropped: false,
    };

    // --- Phase 1: mark (the tombstone) -----------------------------------
    // Runs even when already `deleting` (it is a no-op) so the phase list is
    // uniform and the idempotency is exercised on every resume.
    await this.#phase("mark", id);
    const marked = await this.#repo.markDeleting(id, this.#now());
    if (marked !== null && existing.status !== "deleting") {
      result.tombstoned = true;
    }

    // --- Phase 2: objects (the R2 prefix, paginated) ---------------------
    await this.#phase("objects", id);
    result.objectsDeleted = await this.#deleteObjects(id);

    // --- Phase 3: durable objects (idempotent destroy) -------------------
    await this.#phase("durable_objects", id);
    result.durableObjectsDeleted = await this.#deleteDurableObjects(id);

    // --- Phase 4: D1 rows ------------------------------------------------
    await this.#phase("d1", id);
    result.d1RowsDeleted = await this.#repo.purgeD1(id);

    // --- Phase 5: drop the tombstone -------------------------------------
    await this.#phase("drop", id);
    result.tombstoneDropped = await this.#repo.dropTombstone(id);

    return result;
  }

  /**
   * Delete a project, treating "already gone" as success.
   *
   * The idempotent convenience form: unlike {@link deleteProject}, a fully
   * deleted (or never-existing) project is a zeroed {@link DeleteResult} rather
   * than a `project_not_found` throw. This is the entry a re-run/retry uses, so
   * "rerun without error" (ST-M3) holds even for a rerun that races a completed
   * delete.
   */
  async deleteProjectIfPresent(projectId: string): Promise<DeleteResult> {
    const id = projectId?.trim();
    if (!id) throw new ProjectDeleteError("invalid_input", "projectId is required");
    const exists = await this.#repo.getProject(id);
    if (exists === null) {
      return {
        projectId: id,
        tombstoned: false,
        objectsDeleted: 0,
        durableObjectsDeleted: 0,
        d1RowsDeleted: 0,
        tombstoneDropped: false,
      };
    }
    return this.deleteProject(id);
  }

  /**
   * The completing sweep: finish every project left mid-delete.
   *
   * Iterates the tombstoned worklist and runs {@link deleteProject} on each,
   * resuming it to completion. This is the recovery entry a scheduled job or a
   * cold-start hook calls: after a crash, *some* project is in `deleting` with
   * residue behind it, and one sweep pass removes that residue and drops the
   * tombstone. A second sweep finds no `deleting` rows and does nothing.
   *
   * A per-project failure is collected rather than aborting the sweep, so one
   * stuck project cannot block the completion of the others; the errors are
   * returned for the caller to log/retry.
   */
  async sweep(): Promise<{ completed: DeleteResult[]; failures: { projectId: string; error: unknown }[] }> {
    const pending = await this.#repo.listDeleting();
    const completed: DeleteResult[] = [];
    const failures: { projectId: string; error: unknown }[] = [];

    for (const row of pending) {
      try {
        completed.push(await this.deleteProject(row.id));
      } catch (err) {
        failures.push({ projectId: row.id, error: err });
      }
    }

    return { completed, failures };
  }

  // -- internals ----------------------------------------------------------

  /** Invoke the fault injector for a phase boundary (throws to model a crash). */
  async #phase(phase: DeletePhase, projectId: string): Promise<void> {
    await this.#faults.beforePhase?.(phase, projectId);
  }

  /**
   * Delete every object under the project prefix, page by page.
   *
   * Loops on the store's cursor until it is `null`: a single `list` returns one
   * page, and a project may span many pages (`>1000` keys), so this is the loop
   * that makes the delete complete rather than leaving the tail behind. Keys
   * are deleted page by page (bounded memory, and a crash mid-way resumes from
   * a fresh listing on the next run — never a stale cursor).
   */
  async #deleteObjects(projectId: string): Promise<number> {
    const prefix = this.#prefix(projectId);
    let cursor: string | null = null;
    let deleted = 0;

    for (;;) {
      const page = await this.#objects.list(prefix, cursor);
      if (page.keys.length > 0) {
        deleted += await this.#objects.delete(page.keys);
      }
      if (page.cursor === null) break;
      cursor = page.cursor;
    }

    return deleted;
  }

  /**
   * Destroy every DO owned by the project.
   *
   * Lists the registry's ids and destroys each; both sides are idempotent, so a
   * resume re-listing returns only the survivors (usually none) and a repeated
   * destroy is a no-op.
   */
  async #deleteDurableObjects(projectId: string): Promise<number> {
    const ids = await this.#doRegistry.list(projectId);
    for (const doId of ids) {
      await this.#doRegistry.destroy(doId);
    }
    return ids.length;
  }
}
