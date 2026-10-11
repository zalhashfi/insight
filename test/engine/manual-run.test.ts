import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  InMemoryAutomations,
  InMemoryRunLog,
  RUN_PERMISSION,
  createManualRun,
  createManualRunHandler,
  type ManualRunDeps,
  type RunRecord,
} from "../../worker/src/platform/engine/manual-run";
import {
  AutomationEngine,
  InMemoryProjection,
  RecordingExecutor,
  type Rule,
} from "../../worker/src/platform/engine/run";
import {
  MembershipService,
  type ProjectMember,
  type ProjectRepo,
  type Role,
} from "../../worker/src/domains/projects/membership";
import {
  resolveAdminProject,
  type CredentialLookupResult,
  type Principal,
  type UserPrincipal,
} from "../../worker/src/platform/middleware/resolve-project";

/**
 * Spec tests for the A21c manual-run route (FR-AUT-06).
 *
 * Every dependency is injected, so each contract is asserted against a value the
 * test owns outright — the *real* {@link AutomationEngine} runs over the
 * in-memory seams the engine module ships, the repo/log are the module's own
 * fakes, and only membership is a tiny controlled fake:
 *
 *   1. **A valid run executes, returns its result and is recorded.** The route
 *      drives the engine over the stored rule, the caller reads the engine's own
 *      {@link RunReport} back, and the audit/run-log seam recorded one entry.
 *   2. **Member → 403.** An authenticated `member` session is authorized below
 *      the `project:update` tier the run action requires, and is refused without
 *      the automation ever running.
 *   3. **Unknown id → 404.** An id that is not in the caller's tenant is "not
 *      found" — and a foreign tenant's id is indistinguishable from a missing
 *      one (the tenant is part of the lookup key).
 *   4. **Owner/admin pass.** Both privileged roles may run; the actor is recorded.
 *
 * The route sits behind the shared {@link resolveAdminProject} gate, exactly as
 * the composed worker mounts it: a user session resolves the tenant and must
 * agree with `:proj`. That gate's own behaviour is pinned in
 * `test/middleware/resolve-project.test.ts`; here it is exercised only far
 * enough to prove the manual-run surface is mounted behind it.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT = "prj_alpha";
const FOREIGN_PROJECT = "prj_beta";
const AUTOMATION = "aut_warmup";

const SESSION_OWNER = "sess_owner_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION_MEMBER = "sess_member_bbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SESSION_ADMIN = "sess_admin_cccccccccccccccccccccccccccc";

/** A user-session resolver: session token → the principal it authenticates. */
const SESSIONS: Record<string, CredentialLookupResult> = {
  [SESSION_OWNER]: { kind: "user", userId: "usr_owner", projectId: PROJECT, role: "owner" },
  [SESSION_ADMIN]: { kind: "user", userId: "usr_admin", projectId: PROJECT, role: "admin" },
  [SESSION_MEMBER]: { kind: "user", userId: "usr_member", projectId: PROJECT, role: "member" },
};

/** The credential seam the shared admin gate consults (sessions only). */
const CREDENTIALS = {
  // Admin routes never accept a device token; this resolver always declines.
  deviceTokens: async () => null,
  sessions: async (session: string) => SESSIONS[session] ?? null,
} as const;

/** The role each fixture user holds, so the membership fake can answer. */
const ROLE_BY_USER: Record<string, Role> = {
  usr_owner: "owner",
  usr_admin: "admin",
  usr_member: "member",
};

/**
 * A minimal in-memory {@link ProjectRepo} holding one project and its members.
 *
 * Only the two methods {@link MembershipService.assertPermission} walks
 * (`getProject`, `getMember`) carry real behaviour; the rest throw so an
 * accidental use in this test is loud rather than silently tolerated.
 */
class FakeProjectRepo implements ProjectRepo {
  async createProject(): Promise<never> {
    throw new Error("not used in this test");
  }

  async getProject(projectId: string): Promise<{ id: string; name: string; slug: string; ownerId: string; createdAt: number; updatedAt: number } | null> {
    return projectId === PROJECT || projectId === FOREIGN_PROJECT
      ? { id: projectId, name: projectId, slug: projectId, ownerId: "usr_owner", createdAt: 0, updatedAt: 0 }
      : null;
  }

  async getMember(projectId: string, userId: string): Promise<ProjectMember | null> {
    // Membership is keyed by the PAIR: a user of PROJECT is not a member of
    // FOREIGN_PROJECT, so cross-tenant access resolves to "no membership".
    if (projectId !== PROJECT) return null;
    const role = ROLE_BY_USER[userId];
    if (role === undefined) return null;
    return { projectId, userId, role, createdAt: 0, updatedAt: 0 };
  }

  async listMembers(): Promise<ProjectMember[]> {
    return [];
  }

  async addMember(): Promise<never> {
    throw new Error("not used in this test");
  }

  async removeMember(): Promise<boolean> {
    throw new Error("not used in this test");
  }
}

/** The rule the stored automation carries: it sets one variable. */
function warmupRule(): Rule {
  return {
    id: AUTOMATION,
    cooldownMs: 0,
    conditions: [],
    actions: [{ type: "set_variable", key: "warmed", value: 1 }],
  };
}

interface Harness {
  app: Hono;
  engine: AutomationEngine;
  executor: RecordingExecutor;
  runLog: InMemoryRunLog;
}

/**
 * Build a harness that mirrors production: the manual-run app is mounted at the
 * admin path *behind the shared gate*, over the real engine and in-memory seams.
 */
function harness(): Harness {
  const projection = new InMemoryProjection();
  const executor = new RecordingExecutor();
  const engine = new AutomationEngine({
    projection,
    executor,
    integrations: executor,
    // A fixed clock keeps the (here-irrelevant) cooldown window deterministic.
    now: () => 0,
  });

  const automations = new InMemoryAutomations().add(PROJECT, AUTOMATION, warmupRule());
  const runLog = new InMemoryRunLog({ genId: () => "run_1", now: () => 1_700_000_000_000 });

  const deps: ManualRunDeps = {
    engine,
    automations,
    runLog,
    membership: new MembershipService(new FakeProjectRepo()),
  };

  // The admin surface: the shared gate resolves the session + matches `:proj`,
  // then the manual-run router handles the run. No gate is mounted a second
  // time inside createManualRun here — the harness owns it, exactly as the
  // composed worker's `/v1/admin` subtree would.
  const admin = new Hono();
  admin.use("/:proj/automations/*", resolveAdminProject(CREDENTIALS));
  admin.route("/", createManualRun({ ...deps }));

  const app = new Hono();
  app.route("/v1/admin/projects", admin);

  return { app, engine, executor, runLog };
}

/** POST helper that attaches a Bearer session credential. */
function bearer(session: string): Record<string, string> {
  return { authorization: `Bearer ${session}` };
}

/** The run URL for one automation inside a project. */
function runUrl(projectId = PROJECT, automationId = AUTOMATION): string {
  return `/v1/admin/projects/${projectId}/automations/${automationId}/run`;
}

/** Unwrap the `{ error }` code from a denial body. */
async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string };
  return body.error ?? "<none>";
}

// ---------------------------------------------------------------------------
// 1. A valid run executes, returns the result and is recorded
// ---------------------------------------------------------------------------

describe("a valid manual run executes and is recorded", () => {
  it("runs the stored automation and returns the engine's report", async () => {
    const h = harness();

    const res = await h.app.request(runUrl(), {
      method: "POST",
      headers: bearer(SESSION_OWNER),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: RunRecord };

    // The engine's own report, verbatim: one rule, executed, one action run.
    expect(body.run.report.rules).toHaveLength(1);
    expect(body.run.report.rules[0].ruleId).toBe(AUTOMATION);
    expect(body.run.report.rules[0].status).toBe("executed");
    expect(body.run.report.rules[0].actions).toEqual([
      { type: "set_variable", executed: true },
    ]);

    // It really executed: the side-effecting seam recorded the write.
    expect(h.executor.writes).toEqual([
      { kind: "set_variable", projectId: PROJECT, detail: { key: "warmed", value: 1 } },
    ]);
  });

  it("produces an audit/run-log record with identity, actor and stamp", async () => {
    const h = harness();

    const res = await h.app.request(runUrl(), {
      method: "POST",
      headers: bearer(SESSION_OWNER),
    });
    const body = (await res.json()) as { run: RunRecord };

    // The run-log seam holds exactly one entry, and it is the one returned.
    expect(h.runLog.list()).toHaveLength(1);
    const recorded = h.runLog.last();
    expect(recorded).toBeDefined();
    expect(recorded).toEqual(body.run);
    expect(recorded).toMatchObject({
      id: "run_1",
      createdAt: 1_700_000_000_000,
      projectId: PROJECT,
      automationId: AUTOMATION,
      actorId: "usr_owner",
      trigger: "manual",
    });
  });

  it("an admin (not only an owner) may run, and the actor is recorded", async () => {
    const h = harness();

    const res = await h.app.request(runUrl(), {
      method: "POST",
      headers: bearer(SESSION_ADMIN),
    });

    expect(res.status).toBe(200);
    expect(h.runLog.last()?.actorId).toBe("usr_admin");
  });
});

// ---------------------------------------------------------------------------
// 2. A member is refused 403
// ---------------------------------------------------------------------------

describe("authorization: owner/admin only", () => {
  it("refuses a member session with 403 and runs nothing", async () => {
    const h = harness();

    const res = await h.app.request(runUrl(), {
      method: "POST",
      headers: bearer(SESSION_MEMBER),
    });

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("insufficient_scope");
    // Denied before executing: no write, no run record, no cooldown consumed.
    expect(h.executor.writes).toHaveLength(0);
    expect(h.runLog.list()).toHaveLength(0);
    expect(h.engine.lastExecution(AUTOMATION)).toBeUndefined();
  });

  it("names the required capability in the refusal", async () => {
    const h = harness();

    const res = await h.app.request(runUrl(), {
      method: "POST",
      headers: bearer(SESSION_MEMBER),
    });

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("insufficient_scope");
    expect(body.message).toContain(RUN_PERMISSION);
  });
});

// ---------------------------------------------------------------------------
// 3. Unknown automation → 404
// ---------------------------------------------------------------------------

describe("an unknown automation is 404", () => {
  it("returns 404 for an id that does not exist in the project", async () => {
    const h = harness();

    const res = await h.app.request(runUrl(PROJECT, "aut_missing"), {
      method: "POST",
      headers: bearer(SESSION_OWNER),
    });

    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("automation_not_found");
    expect(h.executor.writes).toHaveLength(0);
    expect(h.runLog.list()).toHaveLength(0);
  });

  it("a path claiming a foreign project is denied by the gate (403)", async () => {
    const h = harness();
    // The automation exists — but in PROJECT; the path claims FOREIGN_PROJECT,
    // which the session credential does not grant. The shared gate refuses the
    // mismatch fail-closed before the handler (and its lookup) ever runs.
    const res = await h.app.request(runUrl(FOREIGN_PROJECT, AUTOMATION), {
      method: "POST",
      headers: bearer(SESSION_OWNER),
    });

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("project_mismatch");
    expect(h.runLog.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Tenant isolation for the lookup itself (unit, no gate)
// ---------------------------------------------------------------------------

describe("the repo lookup is tenant-scoped", () => {
  /** The variables this harness forces onto the context, for typing. */
  type AppVars = { principal: Principal };

  /** Build a handler-only app whose principal is forced onto the context. */
  function principalApp(principal: Principal, deps: ManualRunDeps): Hono<{ Variables: AppVars }> {
    const app = new Hono<{ Variables: AppVars }>();
    // Stand in for the shared gate: pin the principal, then hand off. This
    // isolates the lookup's tenant-scoping from the gate's path matching.
    app.use("*", async (c, next) => {
      c.set("principal", principal);
      await next();
    });
    app.post("/:proj/automations/:id/run", createManualRunHandler(deps));
    return app;
  }

  it("a foreign tenant's id is 'not found' for this project's owner", async () => {
    const automations = new InMemoryAutomations().add(FOREIGN_PROJECT, AUTOMATION, warmupRule());
    const runLog = new InMemoryRunLog();
    const engine = new AutomationEngine({
      projection: new InMemoryProjection(),
      executor: new RecordingExecutor(),
      integrations: new RecordingExecutor(),
      now: () => 0,
    });
    const deps: ManualRunDeps = {
      engine,
      automations,
      runLog,
      membership: new MembershipService(new FakeProjectRepo()),
    };

    const ownerOfProject: UserPrincipal = {
      kind: "user",
      userId: "usr_owner",
      projectId: PROJECT,
      role: "owner",
    };

    // The automation lives only in FOREIGN_PROJECT; scoped to PROJECT it is
    // simply unknown — never an existence oracle for the other tenant. This
    // app mounts the handler directly (`/:proj/automations/:id/run`), so the
    // request is the bare handler path.
    const res = await principalApp(ownerOfProject, deps).request(
      `/${PROJECT}/automations/${AUTOMATION}/run`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("automation_not_found");
    expect(runLog.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Route construction — the self-gating app is fail-closed
// ---------------------------------------------------------------------------

describe("createManualRun can carry its own admin gate", () => {
  it("refuses a missing credential with 401 before the handler runs", async () => {
    const runLog = new InMemoryRunLog();
    const engine = new AutomationEngine({
      projection: new InMemoryProjection(),
      executor: new RecordingExecutor(),
      integrations: new RecordingExecutor(),
      now: () => 0,
    });
    const manualRun = createManualRun({
      engine,
      automations: new InMemoryAutomations().add(PROJECT, AUTOMATION, warmupRule()),
      runLog,
      membership: new MembershipService(new FakeProjectRepo()),
      credentials: CREDENTIALS,
    });

    const app = new Hono();
    app.route("/v1/admin/projects", manualRun);

    const res = await app.request(runUrl(), { method: "POST" });
    expect(res.status).toBe(401);
    expect(runLog.list()).toHaveLength(0);
  });
});
