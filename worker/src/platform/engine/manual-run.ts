/**
 * Automation engine — the **manual-run** route (A21c / FR-AUT-06).
 *
 * This module is the tested, tenant-safe HTTP surface a human uses to run one
 * stored automation *synchronously* and read what happened:
 *
 * ```
 *   POST /v1/admin/projects/:proj/automations/:id/run
 *     → 200 { run: RunRecord }   an existing automation, executed
 *     → 403 { error: "insufficient_scope" }   member session (owner/admin only)
 *     → 404 { error: "automation_not_found" } unknown id (or unreadable tenant)
 * ```
 *
 * A normal automation fires from a trigger (variable change, schedule, event).
 * The manual form exists so a user can press "Run now" while editing and see the
 * engine's real {@link RunReport} at once — an unknown id must not silently no-op
 * (`404`), and a run that happens must be *recorded*, so it never becomes an
 * unaudited side effect.
 *
 * ── The seams (nothing here owns storage) ──────────────────────────────────
 * Four injected ports, so the module is pure policy and can be pinned without a
 * Worker runtime, a D1 binding or a Durable Object:
 *
 *   1. {@link AutomationRepo}   — id → the stored automation's rule, scoped to
 *                                 one project. `null` is the `404` (the tenant
 *                                 is part of the query, so a foreign id is
 *                                 indistinguishable from a missing one).
 *   2. {@link RunLog}           — the audit/run-log seam. Every executed run is
 *                                 appended here before the response is returned;
 *                                 the response echoes the appended record.
 *   3. {@link AutomationEngine} — the real DAG engine (A21, `run.ts`). The route
 *                                 drives it over the *stored* rule and returns
 *                                 its {@link RunReport} verbatim.
 *   4. {@link MembershipService}— the owner/admin authorization used for the
 *                                 `403`. A `member` is authenticated but refused.
 *
 * ── Where auth comes from, and why a second check ──────────────────────────
 * The route assumes the caller has already been authenticated upstream — in the
 * composed worker the shared {@link resolveAdminProject} gate pinned the
 * principal (a *user session*, never a device token) and matched `:proj` against
 * it. This handler therefore reads the principal from the Hono context exactly
 * as that gate stores it (`c.get("principal")`), and then enforces the
 * *capability* the gate deliberately leaves to the handler: only `owner`/`admin`
 * may run an automation, so a `member` is denied `403` through the shared
 * membership permission table (`project:update`, the same admin-class action
 * every other mutating route uses). It never re-derives the tenant from the URL
 * — `:proj` is a claim the credential already had to satisfy.
 *
 * ── The order of checks (fail closed) ──────────────────────────────────────
 *   1. **authorize** — owner/admin, else `403`. Authorizing *before* the lookup
 *      keeps a non-privileged member from probing which automation ids exist.
 *   2. **look up**    — the automation under the resolved tenant, else `404`.
 *   3. **execute**    — the engine, synchronously, over the stored rule.
 *   4. **record**     — append the {@link RunRecord} to the run log *before*
 *      responding, so a recorded run is one that actually happened and a
 *      response always corresponds to a log entry.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { isMembershipError, type MembershipService } from "../../domains/projects/membership";
import {
  requireScope,
  resolveAdminProject,
  type CredentialLookup,
  type Principal,
} from "../../platform/middleware/resolve-project";
import type { AutomationEngine, Rule, RunReport } from "./run";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The permission running an automation requires: `project:update`, i.e. the
 * `admin` tier of the membership table. A `member` cannot run an automation —
 * the route is a *mutation* of project state, not a read.
 */
export const RUN_PERMISSION = "project:update" as const;

/**
 * Hono context key the upstream {@link resolveAdminProject} gate uses to expose
 * the authenticated principal. Named here so this module agrees with the gate
 * on one contract instead of spelling `"principal"` inline.
 */
export const PRINCIPAL_CONTEXT_KEY = "principal";

/** The default clock: Unix epoch milliseconds. */
const defaultClock = (): number => Date.now();

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * One stored automation, as the run route reads it.
 *
 * `projectId` is carried so a repository physically cannot answer with a row
 * from another tenant: the lookup is keyed `(projectId, automationId)` and the
 * row repeats its tenant, so the route can assert the two agree.
 */
export interface AutomationRecord {
  readonly id: string;
  readonly projectId: string;
  /** The trigger → condition → action graph the engine actually runs. */
  readonly rule: Rule;
}

/**
 * The automation store, scoped to a tenant.
 *
 * `get` is keyed by the **pair** `(projectId, automationId)`: the tenant is part
 * of the key, not a filter a caller must remember to apply. An id belonging to
 * another project resolves to `null` — exactly like an id that does not exist —
 * so the route can never be turned into an existence oracle for a foreign
 * tenant's automations. Production backs this with D1; tests use the in-memory
 * fake at the foot of this file.
 */
export interface AutomationRepo {
  get(projectId: string, automationId: string): Promise<AutomationRecord | null>;
}

/**
 * The audit/run-log seam — the "execution is recorded" half of FR-AUT-06.
 *
 * {@link RunLog.append} is called once per executed run, *before* the response
 * is returned, and its returned {@link RunRecord} is what the route echoes. The
 * appender owns the record's identity and timestamp (see {@link RunLogOptions}),
 * so the route never invents an id or reaches for the system clock directly and
 * the log is the single source of truth for "what was recorded".
 */
export interface RunLog {
  append(entry: NewRunRecord): Promise<RunRecord>;
}

/** The caller-supplied half of a run record; the log fills id + timestamp. */
export interface NewRunRecord {
  readonly projectId: string;
  readonly automationId: string;
  /** Who pressed "Run now" — the resolved user id. */
  readonly actorId: string;
  /** How the run was started. Always `"manual"` on this surface. */
  readonly trigger: "manual";
  /** The engine's own report, verbatim — the thing the caller reads back. */
  readonly report: RunReport;
}

/** A recorded run: the entry above plus the log-assigned identity + stamp. */
export interface RunRecord extends NewRunRecord {
  /** Stable id for this run record (the log's concern, not the route's). */
  readonly id: string;
  /** When the run was recorded, epoch ms — the log's clock, not the route's. */
  readonly createdAt: number;
}

/** Everything the run route needs, injectable end-to-end for tests. */
export interface ManualRunDeps {
  /** The real engine seam the route drives (A21). */
  readonly engine: AutomationEngine;
  /** Id → stored automation, scoped to the caller's project. */
  readonly automations: AutomationRepo;
  /** The append-only audit/run log every executed run is written to. */
  readonly runLog: RunLog;
  /** Membership service used for the owner/admin (`403`) gate. */
  readonly membership: MembershipService;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** Body of a successful `POST …/run`. */
export interface ManualRunBody {
  readonly run: RunRecord;
}

/** Stable, machine-readable failure reasons on this surface. */
export type ManualRunErrorCode =
  | "unauthorized"
  | "insufficient_scope"
  | "automation_not_found";

/** Error body shared by every rejection on this surface. */
export interface ManualRunErrorBody {
  readonly error: ManualRunErrorCode;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Options for the in-memory log + repo below; both default to the host's ids. */
export interface RunLogOptions {
  /** Id generator, defaults to `crypto.randomUUID`. */
  readonly genId?: () => string;
  /** Clock, defaults to `Date.now`; injected so tests pin `createdAt`. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Denials
// ---------------------------------------------------------------------------

/** JSON `401` body for a request the route itself had to authenticate. */
function unauthorized(c: Context, message: string): Response {
  const body: ManualRunErrorBody = { error: "unauthorized", message };
  return c.json(body, 401);
}

/** JSON `403` body: authenticated, but below the required role. */
function insufficientScope(c: Context, message: string): Response {
  const body: ManualRunErrorBody = { error: "insufficient_scope", message };
  return c.json(body, 403);
}

/** JSON `404` body: no such automation *in this tenant*. */
function notFound(c: Context, automationId: string): Response {
  const body: ManualRunErrorBody = {
    error: "automation_not_found",
    message: `no automation "${automationId}" in this project`,
  };
  return c.json(body, 404);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** The handler shape, named so a consumer can hold a reference. */
export type ManualRunHandler = (c: Context) => Promise<Response>;

/**
 * Build the `POST /:proj/automations/:id/run` handler.
 *
 * Steps, in order (see the module docblock for the reasoning):
 *   1. read the pinned principal (missing → `401`, wrong kind → `401`);
 *   2. authorize owner/admin through the membership table (member → `403`);
 *   3. look the automation up under the resolved tenant (absent → `404`);
 *   4. run the engine synchronously over the stored rule;
 *   5. append the run record, then return it.
 */
export function createManualRunHandler(deps: ManualRunDeps): ManualRunHandler {
  return async function manualRunHandler(c: Context): Promise<Response> {
    // 1. The principal is pinned upstream by resolveAdminProject. It is read
    //    defensively rather than asserted: a missing principal means the route
    //    was mounted without its gate (a composition mistake), and failing
    //    closed is the only safe answer. A device principal never belongs on
    //    this admin surface, so it is refused the same way.
    const principal = c.get(PRINCIPAL_CONTEXT_KEY) as Principal | undefined;
    if (principal === undefined || principal === null || principal.kind !== "user") {
      return unauthorized(c, "a user session is required");
    }

    // 2. Authorization FIRST: a member who cannot run is refused before the
    //    lookup, so the response is not an existence oracle for automation ids.
    //    The role check goes through the shared permission table via the
    //    membership service (a member → "forbidden"; a non-member →
    //    "not_a_member"); both map to `403`.
    try {
      await deps.membership.assertPermission(
        principal.projectId,
        principal.userId,
        RUN_PERMISSION,
      );
    } catch (err) {
      if (isMembershipError(err)) {
        if (err.code === "project_not_found") {
          return notFound(c, c.req.param("id") ?? "");
        }
        return insufficientScope(
          c,
          `running an automation requires the "${RUN_PERMISSION}" capability (owner or admin)`,
        );
      }
      throw err;
    }

    const automationId = c.req.param("id") ?? "";

    // 3. Tenant-scoped lookup. The resolved project — never the path — is the
    //    key, so a foreign id is simply "not found".
    const automation = await deps.automations.get(principal.projectId, automationId);
    if (automation === null) {
      return notFound(c, automationId);
    }

    // 4. Execute synchronously through the engine seam. A manual run is a
    //    direct trigger: no event, depth 0 — the engine's own anti-loop layers
    //    (cooldown, dedup, depth cap) still apply exactly as for an automatic run.
    const report = await deps.engine.run([automation.rule], {
      projectId: principal.projectId,
      depth: 0,
    });

    // 5. Record before responding: a returned run is always a recorded one.
    const run = await deps.runLog.append({
      projectId: principal.projectId,
      automationId: automation.id,
      actorId: principal.userId,
      trigger: "manual",
      report,
    });

    const body: ManualRunBody = { run };
    return c.json(body, 200);
  };
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

/** Options for {@link createManualRun}. */
export interface ManualRunOptions extends ManualRunDeps {
  /**
   * The credential seam the built-in admin gate uses to resolve a session and
   * pin the principal. Optional: when omitted (the default in tests, where the
   * harness mounts the gate itself) the returned app exposes the handler with
   * no gate. Production supplies it so the route is fail-closed on its own.
   */
  readonly credentials?: CredentialLookup;
}

/**
 * Build a ready-to-mount Hono app exposing the manual-run route.
 *
 * Mount with `app.route("/v1/admin/projects", createManualRun({...}))`. When
 * {@link ManualRunOptions.credentials} is supplied the shared
 * {@link resolveAdminProject} gate is mounted on the sub-tree first, so a
 * missing/unknown/wrong-kind credential is a fail-closed `401` and a `:proj`
 * claim that contradicts the session is a `403` — before the handler runs. When
 * it is omitted the app assumes an upstream gate (the harness supplies one),
 * which is what keeps this module's own tests free of a credential fixture.
 */
export function createManualRun(options: ManualRunOptions): Hono {
  const app = new Hono();
  if (options.credentials !== undefined) {
    app.use(
      "/:proj/automations/:id/run",
      resolveAdminProject({
        deviceTokens: options.credentials.deviceTokens,
        sessions: options.credentials.sessions,
      }),
    );
  }
  app.post("/:proj/automations/:id/run", createManualRunHandler(options));
  return app;
}

// ---------------------------------------------------------------------------
// In-memory seams — honest defaults so a caller can run without a platform
// ---------------------------------------------------------------------------

/**
 * In-memory {@link AutomationRepo}.
 *
 * Automations are stored per tenant, keyed `${projectId}\u0000${automationId}`,
 * so a lookup for a foreign id is simply absent — the tenant boundary is in the
 * key, which is what makes the isolation assertions real rather than a filter
 * that could be forgotten.
 */
export class InMemoryAutomations implements AutomationRepo {
  readonly #byKey = new Map<string, AutomationRecord>();

  static #key(projectId: string, automationId: string): string {
    return `${projectId}\u0000${automationId}`;
  }

  /** Store `rule` as automation `automationId` of `projectId`, and return this. */
  add(projectId: string, automationId: string, rule: Rule): this {
    this.#byKey.set(InMemoryAutomations.#key(projectId, automationId), {
      id: automationId,
      projectId,
      rule,
    });
    return this;
  }

  get(projectId: string, automationId: string): Promise<AutomationRecord | null> {
    const record = this.#byKey.get(InMemoryAutomations.#key(projectId, automationId));
    return Promise.resolve(record === undefined ? null : { ...record });
  }
}

/**
 * In-memory {@link RunLog} — the append-only journal a test reads back.
 *
 * It assigns each record an id and a `createdAt` stamp (from the injected
 * seams), so the route can stay clock-free: the log is the one place a run's
 * identity and time are decided. {@link RunLog.entries} is the audit trail.
 */
export class InMemoryRunLog implements RunLog {
  readonly entries: RunRecord[] = [];
  readonly #genId: () => string;
  readonly #now: () => number;

  constructor(options: RunLogOptions = {}) {
    this.#genId = options.genId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? defaultClock;
  }

  /** Append one record, assigning it an id and a `createdAt` stamp. */
  append(entry: NewRunRecord): Promise<RunRecord> {
    const record: RunRecord = {
      ...entry,
      id: this.#genId(),
      createdAt: this.#now(),
    };
    this.entries.push(record);
    return Promise.resolve(record);
  }

  /** Every recorded run, oldest first. */
  list(): readonly RunRecord[] {
    return this.entries;
  }

  /** The most recent run record, or `undefined` when none has been recorded. */
  last(): RunRecord | undefined {
    return this.entries[this.entries.length - 1];
  }
}

export default createManualRun;
