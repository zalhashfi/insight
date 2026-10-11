import { describe, expect, it } from "vitest";
import {
  MembershipError,
  MembershipService,
  PERMISSIONS,
  can,
  isMembershipError,
  roleAtLeast,
  slugify,
  type Project,
  type ProjectMember,
  type ProjectRepo,
  type Role,
} from "../../worker/src/domains/projects/membership";

/**
 * Spec tests for projects + membership roles.
 *
 * The domain talks to the {@link ProjectRepo} seam, so these tests drive a
 * tiny in-memory fake. The fake keys members by the *composite* string
 * `${projectId}\u0000${userId}`, which is what makes the multi-tenant
 * isolation assertions meaningful: a member of project A is simply not found
 * under project B's key, so no cross-tenant row can ever be returned.
 *
 * Denials are asserted through the module's documented convention: entry
 * points **throw** `MembershipError` with a stable `code` (never `{ok:false}`).
 */

// ---------------------------------------------------------------------------
// In-memory fake of the repository seam.
// ---------------------------------------------------------------------------

/** Owner-style ids derived from the project id, so cases read like tenants. */
function key(projectId: string, userId: string): string {
  return `${projectId}\u0000${userId}`;
}

class FakeProjectRepo implements ProjectRepo {
  readonly projects = new Map<string, Project>();

  /** Members keyed by `(projectId, userId)` — tenant id is part of the key. */
  readonly members = new Map<string, ProjectMember>();

  async createProject(input: {
    id?: string;
    name: string;
    slug: string;
    ownerId: string;
    role: Role;
    now: number;
  }): Promise<{ project: Project; member: ProjectMember }> {
    const id = input.id ?? `p_${this.projects.size + 1}`;
    const existing = this.projects.get(id);
    if (existing) return { project: existing, member: await this.#requireMember(id, input.ownerId) };

    const project: Project = {
      id,
      name: input.name,
      slug: input.slug,
      ownerId: input.ownerId,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.projects.set(id, project);
    const member: ProjectMember = {
      projectId: id,
      userId: input.ownerId,
      role: input.role,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.members.set(key(id, input.ownerId), member);
    return { project, member };
  }

  async getProject(projectId: string): Promise<Project | null> {
    return this.projects.get(projectId) ?? null;
  }

  async updateProject(
    projectId: string,
    patch: { name: string },
    now: number,
  ): Promise<Project | null> {
    const project = this.projects.get(projectId);
    if (!project) return null;
    const next: Project = { ...project, name: patch.name, updatedAt: now };
    this.projects.set(projectId, next);
    return next;
  }

  async getMember(projectId: string, userId: string): Promise<ProjectMember | null> {
    // Composite key: never falls back to a member of another project.
    return this.members.get(key(projectId, userId)) ?? null;
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    return [...this.members.entries()]
      .filter(([k]) => k.startsWith(`${projectId}\u0000`))
      .map(([, m]) => m);
  }

  async addMember(
    projectId: string,
    userId: string,
    role: Role,
    now: number,
  ): Promise<ProjectMember> {
    const k = key(projectId, userId);
    const prev = this.members.get(k);
    const member: ProjectMember = {
      projectId,
      userId,
      role,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.members.set(k, member);
    return member;
  }

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    return this.members.delete(key(projectId, userId));
  }

  async #requireMember(projectId: string, userId: string): Promise<ProjectMember> {
    const member = await this.getMember(projectId, userId);
    if (!member) throw new Error(`fixture invariant: ${userId} not in ${projectId}`);
    return member;
  }
}

/**
 * Build a service over a fresh fake with deterministic ids and clock, plus a
 * helper that creates project A and project B with the given members.
 */
function setup(options: { users?: string[] } = {}) {
  const repo = new FakeProjectRepo();
  let seq = 0;
  let clock = 1_000;
  const users = new Set(options.users ?? []);

  const service = new MembershipService(repo, {
    now: () => (clock += 1_000),
    genId: () => `p_${++seq}`,
    userExists: async (userId) => users.size === 0 || users.has(userId),
  });

  return { repo, service };
}

/** Assert that `fn` rejects with a MembershipError carrying `code`. */
async function expectDenied(fn: () => Promise<unknown>, code: string): Promise<MembershipError> {
  try {
    await fn();
  } catch (err) {
    expect(isMembershipError(err)).toBe(true);
    if (!isMembershipError(err)) throw err;
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`expected MembershipError("${code}") but call resolved`);
}

// ---------------------------------------------------------------------------
// Role lattice / permission table (pure)
// ---------------------------------------------------------------------------

describe("role lattice", () => {
  it("orders member < admin < owner", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "member")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast("member", "owner")).toBe(false);
    expect(roleAtLeast("admin", "owner")).toBe(false);
  });

  it("denies admin-only actions to member and allows them to admin/owner", () => {
    expect(can("member", "project:update")).toBe(false);
    expect(can("member", "member:invite")).toBe(false);
    expect(can("member", "member:remove")).toBe(false);
    expect(can("admin", "project:update")).toBe(true);
    expect(can("admin", "member:invite")).toBe(true);
    expect(can("owner", "project:delete")).toBe(true);
    expect(can("admin", "project:delete")).toBe(false);
  });

  it("treats an unknown role as fully unprivileged", () => {
    expect(can("viewer", "project:read")).toBe(false);
    expect(PERMISSIONS["member:invite"]).toBe("admin");
  });

  it("slugifies project names", () => {
    expect(slugify("  My Sensors  ")).toBe("my-sensors");
    expect(slugify("Edge/Gateway v2")).toBe("edge-gateway-v2");
  });
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe("createProject", () => {
  it("makes the creator the owner", async () => {
    const { service, repo } = setup();

    const { project, membership } = await service.createProject({
      name: "Acme Telemetry",
      ownerId: "u_alice",
    });

    expect(project.ownerId).toBe("u_alice");
    expect(project.slug).toBe("acme-telemetry");
    expect(membership.role).toBe("owner");
    expect(await service.roleOf(project.id, "u_alice")).toBe("owner");
    expect(await repo.listMembers(project.id)).toHaveLength(1);
  });

  it("never enrols the creator in any other project", async () => {
    const { service, repo } = setup();
    const a = await service.createProject({ name: "A", ownerId: "u_alice" });
    const b = await service.createProject({ name: "B", ownerId: "u_bob" });

    expect(await service.roleOf(a.project.id, "u_bob")).toBeNull();
    expect(await service.roleOf(b.project.id, "u_alice")).toBeNull();
    expect(repo.members.size).toBe(2);
  });

  it("rejects a blank name and an unknown creator", async () => {
    const { service } = setup({ users: ["u_alice"] });
    await expectDenied(
      () => service.createProject({ name: "   ", ownerId: "u_alice" }),
      "invalid_input",
    );
    await expectDenied(
      () => service.createProject({ name: "Ok", ownerId: "u_ghost" }),
      "user_not_found",
    );
  });
});

// ---------------------------------------------------------------------------
// Admin-only actions: member denied, admin/owner allowed
// ---------------------------------------------------------------------------

describe("admin-only actions", () => {
  async function threeTierProject() {
    const { service, repo } = setup();
    const { project } = await service.createProject({ name: "Team", ownerId: "u_owner" });
    const { project: _b } = await service.createProject({ name: "Other", ownerId: "u_owner" });
    await service.addMember(project.id, "u_owner", "u_admin", "admin");
    await service.addMember(project.id, "u_owner", "u_member", "member");
    return { service, repo, projectId: project.id };
  }

  it("member cannot add a member → denied (forbidden)", async () => {
    const { service, projectId } = await threeTierProject();
    const err = await expectDenied(
      () => service.addMember(projectId, "u_member", "u_newbie", "member"),
      "forbidden",
    );
    expect(err.status).toBe(403);
  });

  it("admin can add a member", async () => {
    const { service, projectId } = await threeTierProject();
    const added = await service.addMember(projectId, "u_admin", "u_newbie", "member");
    expect(added.role).toBe("member");
    expect(await service.roleOf(projectId, "u_newbie")).toBe("member");
  });

  it("member cannot change project settings → denied", async () => {
    const { service, projectId } = await threeTierProject();
    await expectDenied(
      () => service.updateProject(projectId, "u_member", { name: "Hacked" }),
      "forbidden",
    );
  });

  it("admin and owner can change project settings", async () => {
    const { service, projectId } = await threeTierProject();
    const byAdmin = await service.updateProject(projectId, "u_admin", { name: "Renamed by admin" });
    expect(byAdmin.name).toBe("Renamed by admin");
    const byOwner = await service.updateProject(projectId, "u_owner", { name: "Renamed by owner" });
    expect(byOwner.name).toBe("Renamed by owner");
  });

  it("member cannot remove another member; admin can", async () => {
    const { service, projectId } = await threeTierProject();
    await expectDenied(
      () => service.removeMember(projectId, "u_member", "u_admin"),
      "forbidden",
    );
    await expect(service.removeMember(projectId, "u_admin", "u_member")).resolves.toBeUndefined();
  });

  it("only an owner may mint another owner", async () => {
    const { service, projectId } = await threeTierProject();
    await expectDenied(
      () => service.addMember(projectId, "u_admin", "u_newbie", "owner"),
      "forbidden",
    );
    const promoted = await service.addMember(projectId, "u_owner", "u_newbie", "owner");
    expect(promoted.role).toBe("owner");
  });

  it("non-throwing checkPermission mirrors the throwing guard", async () => {
    const { service, projectId } = await threeTierProject();
    expect(await service.checkPermission(projectId, "u_member", "member:invite")).toBe(false);
    expect(await service.checkPermission(projectId, "u_admin", "member:invite")).toBe(true);
    expect(await service.checkPermission(projectId, "u_owner", "project:delete")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-tenant isolation
// ---------------------------------------------------------------------------

describe("multi-tenant isolation", () => {
  async function twoTenants() {
    const { service, repo } = setup();
    const a = await service.createProject({ name: "Alpha", ownerId: "u_alice" });
    const b = await service.createProject({ name: "Bravo", ownerId: "u_bob" });
    await service.addMember(a.project.id, "u_alice", "u_carol", "admin");
    return { service, repo, a: a.project, b: b.project };
  }

  it("a member of A acting on B is denied as not_a_member", async () => {
    const { service, a, b } = await twoTenants();
    const err = await expectDenied(
      () => service.addMember(b.id, "u_carol", "u_newbie", "admin"),
      "not_a_member",
    );
    // Cross-tenant denial is indistinct from "never had access here".
    expect(err.status).toBe(403);
    expect(await service.roleOf(b.id, "u_carol")).toBeNull();
  });

  it("does not leak B's member list or data to A's admin", async () => {
    const { service, a, b } = await twoTenants();
    const membersOfA = await service.listMembers(a.id, "u_alice");
    expect(membersOfA.map((m) => m.userId).sort()).toEqual(["u_alice", "u_carol"]);
    expect(membersOfA.some((m) => m.userId === "u_bob")).toBe(false);

    await expectDenied(() => service.listMembers(b.id, "u_carol"), "not_a_member");
    await expectDenied(() => service.listMembers(b.id, "u_alice"), "not_a_member");
  });

  it("same userId in two projects resolves to two independent roles", async () => {
    const { service, a, b } = await twoTenants();
    await service.addMember(b.id, "u_bob", "u_alice", "member");

    expect(await service.roleOf(a.id, "u_alice")).toBe("owner");
    expect(await service.roleOf(b.id, "u_alice")).toBe("member");
    // Being an owner of A grants nothing in B.
    await expectDenied(
      () => service.updateProject(b.id, "u_alice", { name: "Nope" }),
      "forbidden",
    );
  });

  it("an unknown project id is reported as project_not_found", async () => {
    const { service } = await twoTenants();
    await expectDenied(() => service.getProject("p_does_not_exist"), "project_not_found");
  });
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

describe("removing a member revokes access", () => {
  it("removed admin loses their powers and their membership row", async () => {
    const { service, repo } = setup();
    const { project } = await service.createProject({ name: "Team", ownerId: "u_owner" });
    await service.addMember(project.id, "u_owner", "u_admin", "admin");
    expect(await service.checkPermission(project.id, "u_admin", "member:invite")).toBe(true);

    await service.removeMember(project.id, "u_owner", "u_admin");

    expect(await service.roleOf(project.id, "u_admin")).toBeNull();
    expect((await repo.listMembers(project.id)).some((m) => m.userId === "u_admin")).toBe(false);
    await expectDenied(
      () => service.addMember(project.id, "u_admin", "u_newbie", "member"),
      "not_a_member",
    );
  });

  it("a member may leave on their own", async () => {
    const { service } = setup();
    const { project } = await service.createProject({ name: "Team", ownerId: "u_owner" });
    await service.addMember(project.id, "u_owner", "u_member", "member");

    // Not allowed to remove *others*…
    await expectDenied(
      () => service.removeMember(project.id, "u_member", "u_owner"),
      "forbidden",
    );
    // …but may remove themselves.
    await expect(service.removeMember(project.id, "u_member", "u_member")).resolves.toBeUndefined();
    expect(await service.roleOf(project.id, "u_member")).toBeNull();
  });

  it("the last owner cannot be removed or demoted", async () => {
    const { service } = setup();
    const { project } = await service.createProject({ name: "Team", ownerId: "u_owner" });
    await service.addMember(project.id, "u_owner", "u_admin", "admin");

    await expectDenied(
      () => service.removeMember(project.id, "u_owner", "u_owner"),
      "last_owner",
    );
    await expectDenied(
      () => service.changeRole(project.id, "u_owner", "u_owner", "member"),
      "last_owner",
    );
    expect(await service.roleOf(project.id, "u_owner")).toBe("owner");
  });

  it("re-adding a removed user starts from a clean slate", async () => {
    const { service } = setup();
    const { project } = await service.createProject({ name: "Team", ownerId: "u_owner" });
    await service.addMember(project.id, "u_owner", "u_admin", "admin");
    await service.removeMember(project.id, "u_owner", "u_admin");

    const readded = await service.addMember(project.id, "u_owner", "u_admin", "member");
    expect(readded.role).toBe("member");
    expect(await service.checkPermission(project.id, "u_admin", "member:invite")).toBe(false);
  });
});
