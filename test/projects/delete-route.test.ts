import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  DELETE_PERMISSION,
  createProjectDeleteRoute,
  createProjectDeleteHandler,
  type ProjectDeleteRouteDeps,
} from "../../worker/src/domains/projects/delete-route";
import {
  ProjectDeleteService,
  type DoRegistryLike,
  type ObjectStoreLike,
  type ProjectDeleteRepo,
  type ProjectRow,
} from "../../worker/src/domains/projects/delete";
import {
  MembershipService,
  type ProjectMember,
  type ProjectRepo,
  type Role,
} from "../../worker/src/domains/projects/membership";
import {
  resolveAdminProject,
  type CredentialLookupResult,
} from "../../worker/src/platform/middleware/resolve-project";

/**
 * Spec tests for the A23 project-delete ROUTE (owner-only, orphan-free).
 *
 * `delete.ts` is pinned by its own suite; this one covers the *wire* that was
 * missing: the route, its owner-only authorization, and the fact that a
 * successful delete leaves no residue in any of the three stores.
 *
 *   1. **Owner deletes** — `200 { deleted }`, and every store is emptied.
 *   2. **Member/admin → 403** — only the `owner` role may delete.
 *   3. **No session → 401** — the shared admin gate fails closed.
 *   4. **Idempotent rerun** — a second delete of a gone project is a zeroed
 *      `200`, not an error, and leaves nothing behind (INV-M3).
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT = "prj_alpha";

const SESSION_OWNER = "sess_owner_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION_ADMIN = "sess_admin_cccccccccccccccccccccccccccc";
const SESSION_MEMBER = "sess_member_bbbbbbbbbbbbbbbbbbbbbbbbbbb";

const SESSIONS: Record<string, CredentialLookupResult> = {
  [SESSION_OWNER]: { kind: "user", userId: "usr_owner", projectId: PROJECT, role: "owner" },
  [SESSION_ADMIN]: { kind: "user", userId: "usr_admin", projectId: PROJECT, role: "admin" },
  [SESSION_MEMBER]: { kind: "user", userId: "usr_member", projectId: PROJECT, role: "member" },
};

const CREDENTIALS = {
  deviceTokens: async () => null,
  sessions: async (session: string) => SESSIONS[session] ?? null,
} as const;

const ROLE_BY_USER: Record<string, Role> = {
  usr_owner: "owner",
  usr_admin: "admin",
  usr_member: "member",
};

class FakeProjectRepo implements ProjectRepo {
  async createProject(): Promise<never> {
    throw new Error("not used");
  }
  async getProject(projectId: string) {
    return projectId === PROJECT
      ? { id: projectId, name: projectId, slug: projectId, ownerId: "usr_owner", createdAt: 0, updatedAt: 0 }
      : null;
  }
  async getMember(projectId: string, userId: string): Promise<ProjectMember | null> {
    if (projectId !== PROJECT) return null;
    const role = ROLE_BY_USER[userId];
    if (role === undefined) return null;
    return { projectId, userId, role, createdAt: 0, updatedAt: 0 };
  }
  async listMembers(): Promise<ProjectMember[]> {
    return [];
  }
  async addMember(): Promise<never> {
    throw new Error("not used");
  }
  async removeMember(): Promise<boolean> {
    throw new Error("not used");
  }
}

/** D1 fake: the project row plus satellite rows. */
class FakeDeleteRepo implements ProjectDeleteRepo {
  readonly projects = new Map<string, ProjectRow>();
  readonly satellites = new Map<string, number>();

  seed(projectId: string, satelliteRows = 3): this {
    this.projects.set(projectId, { id: projectId, status: "active", deletingAt: null });
    this.satellites.set(projectId, satelliteRows);
    return this;
  }

  getProject(projectId: string): Promise<ProjectRow | null> {
    return Promise.resolve(this.projects.get(projectId) ?? null);
  }

  markDeleting(projectId: string, now: number): Promise<ProjectRow | null> {
    const row = this.projects.get(projectId);
    if (row === undefined) return Promise.resolve(null);
    if (row.status !== "deleting") {
      const marked: ProjectRow = { id: projectId, status: "deleting", deletingAt: now };
      this.projects.set(projectId, marked);
      return Promise.resolve(marked);
    }
    return Promise.resolve(row);
  }

  listDeleting(): Promise<readonly ProjectRow[]> {
    return Promise.resolve([...this.projects.values()].filter((row) => row.status === "deleting"));
  }

  purgeD1(projectId: string): Promise<number> {
    const count = this.satellites.get(projectId) ?? 0;
    this.satellites.delete(projectId);
    return Promise.resolve(count);
  }

  dropTombstone(projectId: string): Promise<boolean> {
    return Promise.resolve(this.projects.delete(projectId));
  }

  /** Test-only: total residue (satellite rows still present). */
  residue(): number {
    let total = 0;
    for (const n of this.satellites.values()) total += n;
    return total;
  }
}

/** R2 fake: keys by prefix, paginated. */
class FakeObjects implements ObjectStoreLike {
  readonly keys = new Set<string>(["projects/prj_alpha/a", "projects/prj_alpha/b"]);

  list(prefix: string, _cursor?: string | null) {
    const page = [...this.keys].filter((key) => key.startsWith(prefix));
    return Promise.resolve({ keys: page, cursor: null });
  }
  delete(keys: readonly string[]): Promise<number> {
    let n = 0;
    for (const key of keys) if (this.keys.delete(key)) n += 1;
    return Promise.resolve(n);
  }
}

/** DO registry fake: two DO ids for the project, idempotent destroy. */
class FakeRegistry implements DoRegistryLike {
  readonly live = new Set<string>(["do_1", "do_2"]);
  list(_projectId: string): Promise<readonly string[]> {
    return Promise.resolve([...this.live]);
  }
  destroy(doId: string): Promise<void> {
    this.live.delete(doId);
    return Promise.resolve();
  }
}

interface Harness {
  app: Hono;
  repo: FakeDeleteRepo;
  objects: FakeObjects;
  registry: FakeRegistry;
}

function harness(): Harness {
  const repo = new FakeDeleteRepo().seed(PROJECT, 3);
  const objects = new FakeObjects();
  const registry = new FakeRegistry();
  const deletes = new ProjectDeleteService(repo, objects, registry);
  const deps: ProjectDeleteRouteDeps = {
    deletes,
    membership: new MembershipService(new FakeProjectRepo()),
  };

  // Mirror production: the route is mounted at the admin path behind the shared
  // gate, which pins the principal and matches `:proj`.
  const admin = new Hono();
  admin.use("/:proj", resolveAdminProject(CREDENTIALS));
  admin.route("/", createProjectDeleteRoute({ ...deps }));
  const app = new Hono();
  app.route("/v1/admin/projects", admin);

  return { app, repo, objects, registry };
}

function bearer(session: string): Record<string, string> {
  return { authorization: `Bearer ${session}` };
}

// ---------------------------------------------------------------------------
// 1. Owner deletes — no orphans
// ---------------------------------------------------------------------------

describe("DELETE /v1/admin/projects/:proj — owner only, orphan-free", () => {
  it("the owner deletes the project and every store is emptied", async () => {
    const h = harness();
    const res = await h.app.request(`/v1/admin/projects/${PROJECT}`, {
      method: "DELETE",
      headers: bearer(SESSION_OWNER),
    });
    expect(res.status).toBe(200);
    // The route's own JSON contract (the value this repo's server produced).
    const body: { deleted: { tombstoneDropped: boolean; objectsDeleted: number } } =
      await res.json();
    expect(body.deleted.tombstoneDropped).toBe(true);
    expect(body.deleted.objectsDeleted).toBe(2);

    // No residue anywhere: D1 satellites gone, R2 prefix gone, DOs destroyed.
    expect(h.repo.residue()).toBe(0);
    expect(h.repo.projects.has(PROJECT)).toBe(false);
    expect(h.objects.keys.size).toBe(0);
    expect(h.registry.live.size).toBe(0);
  });

  it("an admin (not owner) is refused 403 and nothing is deleted", async () => {
    const h = harness();
    const res = await h.app.request(`/v1/admin/projects/${PROJECT}`, {
      method: "DELETE",
      headers: bearer(SESSION_ADMIN),
    });
    expect(res.status).toBe(403);
    const denial: { error: string } = await res.json();
    expect(denial.error).toBe("insufficient_scope");
    // Fail closed: the project is untouched.
    expect(h.repo.projects.get(PROJECT)?.status).toBe("active");
    expect(h.objects.keys.size).toBe(2);
  });

  it("a member is refused 403", async () => {
    const h = harness();
    const res = await h.app.request(`/v1/admin/projects/${PROJECT}`, {
      method: "DELETE",
      headers: bearer(SESSION_MEMBER),
    });
    expect(res.status).toBe(403);
    expect(h.repo.projects.get(PROJECT)?.status).toBe("active");
  });

  it("no session is 401 from the shared gate (mounted, not 404)", async () => {
    const h = harness();
    const res = await h.app.request(`/v1/admin/projects/${PROJECT}`, { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(404);
  });

  it("a second delete of a gone project is an idempotent 200 with zeroes (INV-M3)", async () => {
    const h = harness();
    const first = await h.app.request(`/v1/admin/projects/${PROJECT}`, {
      method: "DELETE",
      headers: bearer(SESSION_OWNER),
    });
    expect(first.status).toBe(200);

    const again = await h.app.request(`/v1/admin/projects/${PROJECT}`, {
      method: "DELETE",
      headers: bearer(SESSION_OWNER),
    });
    expect(again.status).toBe(200);
    const body: { deleted: { objectsDeleted: number; tombstoneDropped: boolean } } =
      await again.json();
    expect(body.deleted.objectsDeleted).toBe(0);
    expect(body.deleted.tombstoneDropped).toBe(false);
    expect(h.repo.residue()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gate is optional: the bare handler is a standalone seam
// ---------------------------------------------------------------------------

describe("createProjectDeleteHandler — the bare handler", () => {
  it("is a function over the same deps the router mounts", () => {
    const repo = new FakeDeleteRepo().seed(PROJECT);
    const deps: ProjectDeleteRouteDeps = {
      deletes: new ProjectDeleteService(repo, new FakeObjects(), new FakeRegistry()),
      membership: new MembershipService(new FakeProjectRepo()),
    };
    expect(typeof createProjectDeleteHandler(deps)).toBe("function");
    expect(DELETE_PERMISSION).toBe("project:delete");
  });
});
