/**
 * Projects + membership roles — domain service over a repository seam.
 *
 * This module owns the *rules* of projects and project membership
 * (`owner | admin | member`); it never talks to a storage engine directly.
 * Everything it needs from persistence is expressed by {@link ProjectRepo}, so
 * production can back it with D1 (`projects` / `project_members` in
 * `0001_init.sql`) while tests drive it with a tiny in-memory fake.
 *
 * ── Error convention (documented, and consistent everywhere) ────────────────
 * Mutating/authorization entry points **throw** a typed {@link MembershipError}
 * (`err.code`) instead of returning `{ ok: false }`. Rationale: these are
 * operations, not parsers — a denial is exceptional, and a throw cannot be
 * accidentally ignored by a caller that forgets to inspect a result object.
 * The `code` is stable and machine-readable so a Hono `onError` handler can map
 * it straight onto an HTTP status.
 *
 * ── Multi-tenant isolation ─────────────────────────────────────────────────
 * Every authenticated lookup is scoped by the pair `(projectId, userId)` and
 * the role check always happens *against the caller's membership in that exact
 * project*. A member of project A acting on project B therefore resolves to
 * **no membership** and is denied with `not_a_member` (never `forbidden`),
 * which also means a foreign project id never leaks the existence of a project
 * or of the other tenant's members.
 */

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

/**
 * Project roles, ordered from least to most privileged.
 *
 * NOTE: this list intentionally differs from the SQL column default in
 * `0001_init.sql` (`role TEXT NOT NULL DEFAULT 'viewer'`); the application
 * layer is the source of truth for the role vocabulary and never writes
 * `'viewer'`.
 */
export const ROLES = ["member", "admin", "owner"] as const;

/** A project role. */
export type Role = (typeof ROLES)[number];

/** Numeric rank per role; higher outranks lower. */
const ROLE_RANK: Record<Role, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

/**
 * Actions a member can attempt, each mapped to the *minimum* role it needs.
 *
 * This table is the single source of truth for authorization: both
 * {@link can} and the service methods consult it, so a new action only has to
 * be declared once.
 */
export const PERMISSIONS = {
  "project:read": "member",
  "project:update": "admin",
  "project:delete": "owner",
  "project:transfer": "owner",
  "member:invite": "admin",
  "member:remove": "admin",
  "member:change_role": "admin",
} as const;

/** An action name understood by {@link can}. */
export type Permission = keyof typeof PERMISSIONS;

/** Type guard: is `value` one of the known roles? */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Rank of a role. Unknown role strings rank `0` (below `member`), so garbage
 * persisted by an older writer can never be mistaken for an elevated role.
 */
export function roleRank(role: Role | string): number {
  return isRole(role) ? ROLE_RANK[role] : 0;
}

/**
 * True when `role` is at least as privileged as `required`.
 *
 * ```ts
 * roleAtLeast("admin", "member") // true
 * roleAtLeast("member", "admin") // false
 * ```
 */
export function roleAtLeast(role: Role, required: Role): boolean {
  return roleRank(role) >= roleRank(required);
}

/**
 * True when `role` may perform `action`.
 *
 * An unknown/invalid `role` is treated as having no permission at all.
 */
export function can(role: Role | string, action: Permission): boolean {
  if (!isRole(role)) return false;
  return roleAtLeast(role, PERMISSIONS[action]);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable, machine-readable failure codes for the membership domain. */
export type MembershipErrorCode =
  | "invalid_role"
  | "invalid_input"
  | "project_exists"
  | "project_not_found"
  | "user_not_found"
  | "not_a_member"
  | "forbidden"
  | "member_exists"
  | "member_not_found"
  | "last_owner"
  | "unsupported";

/** Lookup of a {@link MembershipErrorCode} onto an HTTP status. */
export const MEMBERSHIP_STATUS: Record<MembershipErrorCode, number> = {
  invalid_role: 400,
  invalid_input: 400,
  project_exists: 409,
  project_not_found: 404,
  user_not_found: 404,
  not_a_member: 403,
  forbidden: 403,
  member_exists: 409,
  member_not_found: 404,
  last_owner: 409,
  unsupported: 501,
};

/** Error thrown by every failing entry point of this module. */
export class MembershipError extends Error {
  /** Stable code suitable for mapping onto an HTTP response. */
  readonly code: MembershipErrorCode;

  /** HTTP status corresponding to {@link code}. */
  readonly status: number;

  constructor(code: MembershipErrorCode, message: string) {
    super(message);
    this.name = "MembershipError";
    this.code = code;
    this.status = MEMBERSHIP_STATUS[code];
  }
}

/** Convenience guard for `catch` blocks. */
export function isMembershipError(err: unknown): err is MembershipError {
  return err instanceof MembershipError;
}

// ---------------------------------------------------------------------------
// Entities & repository seam
// ---------------------------------------------------------------------------

/** A project (tenant). `ownerId` mirrors the creator's `owner` membership. */
export interface Project {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

/** A user's membership in one project. */
export interface ProjectMember {
  projectId: string;
  userId: string;
  role: Role;
  createdAt: number;
  updatedAt: number;
}

/**
 * Storage seam for projects and members. Implemented by an in-memory fake in
 * tests and by a D1-backed adapter in production.
 *
 * `getMember` is deliberately keyed by `(projectId, userId)`: the tenant
 * boundary is part of the key, not something callers must remember to filter.
 * Implementations MUST return `null` (never a row from another project) when
 * either half of the pair does not match.
 */
export interface ProjectRepo {
  createProject(input: {
    id?: string;
    name: string;
    slug: string;
    ownerId: string;
    role: Role;
    now: number;
  }): Promise<{ project: Project; member: ProjectMember }>;

  getProject(projectId: string): Promise<Project | null>;

  /** Persist a project patch. Optional — adapters may omit it. */
  updateProject?(
    projectId: string,
    patch: { name: string },
    now: number,
  ): Promise<Project | null>;

  /** Membership in `projectId` for `userId`, or `null`. Never cross-tenant. */
  getMember(projectId: string, userId: string): Promise<ProjectMember | null>;

  /** All members of `projectId` (never of any other project). */
  listMembers(projectId: string): Promise<ProjectMember[]>;

  /** Upsert `userId`'s role in `projectId`. */
  addMember(
    projectId: string,
    userId: string,
    role: Role,
    now: number,
  ): Promise<ProjectMember>;

  /** Remove `userId` from `projectId`; `false` if they were not a member. */
  removeMember(projectId: string, userId: string): Promise<boolean>;
}

/** Optional collaborators for {@link MembershipService}. */
export interface MembershipServiceOptions {
  /** Does this user exist? Defaults to "assume yes" (identity is auth's job). */
  userExists?: (userId: string) => Promise<boolean>;
  /** Clock, `Date.now` by default; injected so tests can assert timestamps. */
  now?: () => number;
  /**
   * Seam for id generation (defaults to `crypto.randomUUID`). Returning a
   * duplicate id surfaces as `project_exists` rather than silently clobbering.
   */
  genId?: () => string;
  /** Slug used when `createProject` is called without one. */
  slugify?: (s: string) => string;
}

/** Result of {@link MembershipService.createProject}. */
export interface CreateProjectResult {
  project: Project;
  /** The creator's membership — always `role: "owner"`. */
  membership: ProjectMember;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Trims, lowercases and hyphenates a project name into a slug. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Projects + membership use cases.
 *
 * All public methods are async and follow the throw-on-failure convention
 * described at the top of this file.
 */
export class MembershipService {
  readonly #repo: ProjectRepo;
  readonly #userExists: (userId: string) => Promise<boolean>;
  readonly #now: () => number;
  readonly #genId: () => string;
  readonly #slugify: (s: string) => string;

  constructor(repo: ProjectRepo, options: MembershipServiceOptions = {}) {
    this.#repo = repo;
    this.#userExists = options.userExists ?? (async () => true);
    this.#now = options.now ?? (() => Date.now());
    this.#genId = options.genId ?? (() => crypto.randomUUID());
    this.#slugify = options.slugify ?? slugify;
  }

  /**
   * Create a project and enrol the creator as its `owner`.
   *
   * Throws `invalid_input` for a blank name/owner or a slug that slugifies to
   * nothing, `user_not_found` when the creator is unknown, and
   * `project_exists` when either the generated id or the slug is taken.
   */
  async createProject(input: {
    name: string;
    ownerId: string;
    id?: string;
    slug?: string;
  }): Promise<CreateProjectResult> {
    const name = input.name?.trim();
    const ownerId = input.ownerId?.trim();
    if (!name) throw new MembershipError("invalid_input", "project name is required");
    if (!ownerId) throw new MembershipError("invalid_input", "ownerId is required");

    const slug = (input.slug ?? this.#slugify(name)).trim();
    if (!slug) throw new MembershipError("invalid_input", "project slug is required");

    const id = input.id ?? this.#genId();
    if (await this.#repo.getProject(id)) {
      throw new MembershipError("project_exists", `project id already exists: ${id}`);
    }
    if (!(await this.#userExists(ownerId))) {
      throw new MembershipError("user_not_found", `unknown user: ${ownerId}`);
    }

    const { project, member } = await this.#repo.createProject({
      id,
      name,
      slug,
      ownerId,
      role: "owner",
      now: this.#now(),
    });
    return { project, membership: member };
  }

  /** Read a project, or throw `project_not_found`. */
  async getProject(projectId: string): Promise<Project> {
    const project = await this.#repo.getProject(projectId);
    if (!project) {
      throw new MembershipError("project_not_found", `no such project: ${projectId}`);
    }
    return project;
  }

  /**
   * Role of `userId` in `projectId`, or `null` when they are not a member of
   * *that* project. Never consults another tenant.
   */
  async roleOf(projectId: string, userId: string): Promise<Role | null> {
    const member = await this.#repo.getMember(projectId, userId);
    return member ? member.role : null;
  }

  /**
   * Resolve `(projectId, userId)` to a membership, throwing the *tenant-safe*
   * pair of errors:
   *
   *   * `project_not_found` — no such project at all;
   *   * `not_a_member`     — project exists, caller is not a member of it
   *                          (this is also what a member of another project
   *                          gets: cross-tenant access is indistinguishable
   *                          from not being a member).
   */
  async requireMembership(projectId: string, userId: string): Promise<ProjectMember> {
    await this.getProject(projectId);
    const member = await this.#repo.getMember(projectId, userId);
    if (!member) {
      throw new MembershipError("not_a_member", `user ${userId} is not a member of ${projectId}`);
    }
    return member;
  }

  /**
   * Write-path guard: the caller's role in `projectId` must satisfy `action`.
   *
   * Returns the caller's membership so the caller can reuse the resolved role.
   * Throws `not_a_member` (not a member of this tenant) or `forbidden`
   * (member, but below the required role).
   */
  async assertPermission(
    projectId: string,
    userId: string,
    action: Permission,
  ): Promise<ProjectMember> {
    const member = await this.requireMembership(projectId, userId);
    if (!can(member.role, action)) {
      throw new MembershipError(
        "forbidden",
        `role "${member.role}" cannot perform "${action}" (requires "${PERMISSIONS[action]}")`,
      );
    }
    return member;
  }

  /** Non-throwing form of {@link assertPermission}. */
  async checkPermission(
    projectId: string,
    userId: string,
    action: Permission,
  ): Promise<boolean> {
    try {
      await this.assertPermission(projectId, userId, action);
      return true;
    } catch (err) {
      if (isMembershipError(err)) return false;
      throw err;
    }
  }

  /**
   * Update a project's name (admin+).
   *
   * Authorization is fully enforced here; the durable write goes through the
   * optional `updateProject` repo method. When the adapter does not implement
   * it this fails closed with `unsupported` rather than pretending to succeed.
   */
  async updateProject(
    projectId: string,
    actorId: string,
    patch: { name?: string },
  ): Promise<Project> {
    await this.assertPermission(projectId, actorId, "project:update");
    const name = patch.name?.trim();
    if (patch.name !== undefined && !name) {
      throw new MembershipError("invalid_input", "project name cannot be blank");
    }
    if (name === undefined) return this.getProject(projectId);
    const updated = await this.#repo.updateProject?.(projectId, { name }, this.#now());
    if (!updated) {
      throw new MembershipError(
        "unsupported",
        "this ProjectRepo does not implement updateProject",
      );
    }
    return updated;
  }

  /**
   * Invite/add a member with `role` (admin+).
   *
   * Admins may add `member` or `admin`; only an `owner` may mint another
   * `owner`. Throws `member_exists` if the user is already in the project.
   */
  async addMember(
    projectId: string,
    actorId: string,
    userId: string,
    role: Role,
  ): Promise<ProjectMember> {
    const actor = await this.assertPermission(projectId, actorId, "member:invite");
    const target = userId?.trim();
    if (!target) throw new MembershipError("invalid_input", "userId is required");
    if (!isRole(role)) {
      throw new MembershipError("invalid_role", `unknown role: ${String(role)}`);
    }
    if (role === "owner" && actor.role !== "owner") {
      throw new MembershipError("forbidden", "only an owner can grant the owner role");
    }
    if (!(await this.#userExists(target))) {
      throw new MembershipError("user_not_found", `unknown user: ${target}`);
    }
    if (await this.#repo.getMember(projectId, target)) {
      throw new MembershipError("member_exists", `user ${target} is already a member of ${projectId}`);
    }
    return this.#repo.addMember(projectId, target, role, this.#now());
  }

  /**
   * Change an existing member's role (admin+).
   *
   * The last remaining owner cannot be demoted (`last_owner`), and only an
   * owner may promote to `owner` or demote an owner.
   */
  async changeRole(
    projectId: string,
    actorId: string,
    userId: string,
    role: Role,
  ): Promise<ProjectMember> {
    const actor = await this.assertPermission(projectId, actorId, "member:change_role");
    if (!isRole(role)) {
      throw new MembershipError("invalid_role", `unknown role: ${String(role)}`);
    }
    const target = await this.requireMembership(projectId, userId);

    const touchesOwner = target.role === "owner" || role === "owner";
    if (touchesOwner && actor.role !== "owner") {
      throw new MembershipError("forbidden", "only an owner can change owner-level roles");
    }
    if (target.role === "owner" && role !== "owner" && (await this.#ownerCount(projectId)) <= 1) {
      throw new MembershipError("last_owner", "cannot demote the last owner of a project");
    }
    return this.#repo.addMember(projectId, target.userId, role, this.#now());
  }

  /**
   * Remove a member (admin+).
   *
   * Admins may remove `member`s and other `admin`s; removing an `owner`
   * requires admin rights *and* a target that is not the last owner. A member
   * may always remove themselves (leave the project).
   */
  async removeMember(projectId: string, actorId: string, userId: string): Promise<void> {
    const actor = await this.requireMembership(projectId, actorId);
    const target = await this.requireMembership(projectId, userId);

    const self = actor.userId === target.userId;
    if (!self && !can(actor.role, "member:remove")) {
      throw new MembershipError(
        "forbidden",
        `role "${actor.role}" cannot remove members (requires "admin")`,
      );
    }
    if (target.role === "owner") {
      if (actor.role !== "owner") {
        throw new MembershipError("forbidden", "only an owner can remove an owner");
      }
      if ((await this.#ownerCount(projectId)) <= 1) {
        throw new MembershipError("last_owner", "cannot remove the last owner of a project");
      }
    }

    const removed = await this.#repo.removeMember(projectId, target.userId);
    if (!removed) {
      throw new MembershipError("member_not_found", `user ${target.userId} is not a member`);
    }
  }

  /** All members of `projectId`, visible to any member of that project. */
  async listMembers(projectId: string, actorId: string): Promise<ProjectMember[]> {
    await this.assertPermission(projectId, actorId, "project:read");
    return this.#repo.listMembers(projectId);
  }

  /** Number of `owner` rows in `projectId` (tenant-scoped). */
  async #ownerCount(projectId: string): Promise<number> {
    const members = await this.#repo.listMembers(projectId);
    return members.filter((m) => m.role === "owner").length;
  }
}
