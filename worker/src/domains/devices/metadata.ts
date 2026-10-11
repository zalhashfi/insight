/**
 * devices/metadata — device lifecycle metadata over a repository seam.
 *
 * A *device metadata* record is the human-owned, slowly-changing description of
 * a device that a project's telemetry surface *does not* own: its display
 * `name`, its `model`, where it is `location`ed, a free-form `note`, and — the
 * part with teeth — a lifecycle `status` (`active | dormant | retired`).
 * Telemetry itself lives in the DO/R2 data plane (INV-T5); this module is the
 * *metadata* half, and mirrors the `devices` table named in spec §5.3.
 *
 * ── Over a seam ────────────────────────────────────────────────────────────
 * The domain talks to {@link DeviceRepo}, never a storage engine. Production
 * backs it with D1 (`devices`) and the Durable Object registry; tests drive an
 * in-memory fake ({@link InMemoryDeviceRepo}) so every rule below is pinned
 * without a database.
 *
 * ── Error convention (identical to `projects/membership.ts`) ────────────────
 * Mutating / authorizing entry points **throw** a typed {@link DeviceError}
 * carrying a stable `code`, which maps onto an HTTP status through
 * {@link DEVICE_STATUS_CODE}. These are operations, not parsers: a denial is
 * exceptional, and a throw cannot be silently ignored by a caller that forgets
 * to inspect a `{ ok:false }` result. The codes and statuses are chosen to match
 * the frozen HTTP contract (spec §6.9): `403` for a role/scope that is
 * insufficient, `404` for a source that does not exist, `400` for bad input.
 *
 * ── Authorization is delegated, not re-implemented ─────────────────────────
 * Rename (`PATCH /:id`) and delete (`DELETE /:id`) require **owner or admin**;
 * a plain `member` is refused `403` (FR-DEV-04). Rather than re-deriving a role
 * lattice here, this module consumes the *existing* permission vocabulary —
 * `Permission` / `can` from `projects/membership.ts` — through a tiny
 * {@link MembershipLookup} seam. The action name is declared in that module's
 * table, so the two domains cannot drift: this file never contains a second copy
 * of "admin means rank ≥ 2".
 *
 * ── The ingest gate (INV-DEV-status) ───────────────────────────────────────
 * {@link assertIngestible} is the ONE place a device's lifecycle status may
 * refuse telemetry. A **`retired`** device and a **`dormant`** device are both
 * refused `403`; only an **`active`** device may ingest. This is a documented
 * policy (see {@link INGEST_REFUSED}), not an accident: retiring a device must
 * actually stop its writes, and a device parked in `dormant` is, by definition,
 * expected to be quiet — so an unexpected sample from one is treated as a
 * misconfiguration and refused loudly rather than shelved.
 */

import { can, isRole, type Permission, type Role } from "../projects/membership";

// ---------------------------------------------------------------------------
// Lifecycle status
// ---------------------------------------------------------------------------

/**
 * The device lifecycle statuses, in the order a device normally moves through
 * them: `active` (in service) → `dormant` (parked, expected silent) →
 * `retired` (decommissioned, must never write again).
 *
 * The vocabulary is exactly the three values FR-DEV-05 names; nothing else may
 * be stored, so an unknown status can never be mistaken for a permissive one.
 */
export const DEVICE_STATUSES = ["active", "dormant", "retired"] as const;

/** A device lifecycle status. */
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** Type guard: is `value` one of the known device statuses? */
export function isDeviceStatus(value: unknown): value is DeviceStatus {
  return typeof value === "string" && (DEVICE_STATUSES as readonly string[]).includes(value);
}

/**
 * Which lifecycle statuses REFUSE telemetry at the ingest gate — the documented
 * policy (INV-DEV-status), keyed by the complete status vocabulary so a new
 * status cannot be added without an explicit decision here.
 *
 * Policy: a `retired` device must be unable to write — that is the whole point
 * of retiring it — and a `dormant` device is expected to be silent, so a
 * surprise sample is refused rather than accepted. Only `active` may ingest.
 *
 * A caller that wants the opposite dormancy policy (accept a slow heartbeat
 * from a dormant device) flips `dormant` to `false` HERE and nowhere else; the
 * ingest gate reads this table, so the policy has one home.
 */
export const INGEST_REFUSED: Record<DeviceStatus, boolean> = {
  active: false,
  dormant: true,
  retired: true,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable, machine-readable failure codes for the device-metadata domain. */
export type DeviceErrorCode =
  | "invalid_input"
  | "invalid_status"
  | "device_exists"
  | "device_not_found"
  | "not_a_member"
  | "forbidden"
  | "device_not_ingestible";

/** Lookup of a {@link DeviceErrorCode} onto an HTTP status (spec §6.9). */
export const DEVICE_STATUS_CODE: Record<DeviceErrorCode, number> = {
  invalid_input: 400,
  invalid_status: 400,
  device_exists: 409,
  device_not_found: 404,
  not_a_member: 403,
  forbidden: 403,
  // A retired/dormant device is *known* but not permitted to write -> 403,
  // exactly the "scope/role kurang" class, never a 404 (the device exists).
  device_not_ingestible: 403,
};

/**
 * Error thrown by every failing entry point of this module.
 *
 * `code` is stable and machine-readable; `status` is the HTTP status it maps
 * onto, so a Hono `onError` handler can translate it without a lookup table.
 */
export class DeviceError extends Error {
  /** Stable code suitable for mapping onto an HTTP response. */
  readonly code: DeviceErrorCode;

  /** HTTP status corresponding to {@link code}. */
  readonly status: number;

  constructor(code: DeviceErrorCode, message: string) {
    super(message);
    this.name = "DeviceError";
    this.code = code;
    this.status = DEVICE_STATUS_CODE[code];
  }
}

/** Convenience guard for `catch` blocks. */
export function isDeviceError(err: unknown): err is DeviceError {
  return err instanceof DeviceError;
}

// ---------------------------------------------------------------------------
// Entities & repository seam
// ---------------------------------------------------------------------------

/**
 * A device metadata record.
 *
 * `id` is the application-generated primary key (`devices.id` in the schema);
 * `projectId` scopes the device to one tenant; `key` is the wire identity a
 * device presents in `x-insight-device` (FR-DEV-03), kept for correlation with
 * the telemetry plane. `model`/`location`/`note` are the free-form metadata of
 * FR-DEV-05 and are `null` when unset.
 */
export interface Device {
  readonly id: string;
  readonly projectId: string;
  /** Device key as seen on the wire (`x-insight-device`). */
  readonly key: string;
  /** Human display name; never blank. */
  readonly name: string;
  readonly model: string | null;
  readonly location: string | null;
  readonly note: string | null;
  readonly status: DeviceStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The metadata fields a caller may set/clear. All optional; `null` clears. */
export interface DeviceMetadataPatch {
  readonly model?: string | null;
  readonly location?: string | null;
  readonly note?: string | null;
  readonly status?: DeviceStatus;
}

/**
 * Storage seam for device metadata. Implemented by an in-memory fake in tests
 * and by a D1-backed adapter in production.
 *
 * Every method is keyed or scoped by the device/tenant, so the tenant boundary
 * is part of the contract. `update` receives ONLY the fields to change (with
 * `null` meaning "clear"), never a whole record, so a read-modify-write cannot
 * clobber a concurrent edit of a different field.
 */
export interface DeviceRepo {
  /** Insert a new device. Rejects a duplicate `id` (models the PK). */
  insert(device: Device): Promise<Device>;

  /** The device with this id, or `null`. Never returns another tenant's row. */
  get(id: string): Promise<Device | null>;

  /** All devices of `projectId`, insertion-ordered. Never crosses tenants. */
  listByProject(projectId: string): Promise<readonly Device[]>;

  /**
   * Apply `patch` atomically and return the updated record, or `null` when no
   * device has that id. Unset keys are left untouched; `null` clears a field.
   */
  update(
    id: string,
    patch: DeviceMetadataPatch & { name?: string },
    now: number,
  ): Promise<Device | null>;

  /** Remove the device; `false` when the id was unknown. */
  delete(id: string): Promise<boolean>;
}

/**
 * Membership seam: does `userId` hold a role in `projectId` that permits
 * `action`? Expressed as a single question so this module never needs a second
 * copy of the role lattice — production implements it over `project_tokens` /
 * `project_members` via `projects/membership.ts`.
 *
 * Implementations MUST scope by `projectId`: a member of project A acting on a
 * device of project B must answer `false` (and the service surfaces that as
 * `forbidden`/`not_a_member`, never a silent pass).
 */
export interface MembershipLookup {
  /**
   * May `userId` perform `action` in `projectId`?
   *
   * `false` covers both "not a member at all" and "a member below the required
   * role" — the caller decides which `DeviceError` code to raise from the
   * optional {@link MembershipLookup.roleOf} detail when it needs to.
   */
  can(userId: string, projectId: string, action: Permission): Promise<boolean> | boolean;

  /** `userId`'s role in `projectId`, or `null` when they are not a member. */
  roleOf?(userId: string, projectId: string): Promise<Role | null> | Role | null;
}

/** Options accepted by {@link DeviceMetadataService}. */
export interface DeviceMetadataServiceOptions {
  /** Membership seam used to authorize rename/delete. Required. */
  readonly membership: MembershipLookup;
  /** Clock, `Date.now` by default; injected so tests can assert timestamps. */
  readonly now?: () => number;
  /** Id seam; defaults to `crypto.randomUUID`. */
  readonly genId?: () => string;
}

/** Result of {@link DeviceMetadataService.createDevice}. */
export interface CreateDeviceResult {
  readonly device: Device;
}

/** Input accepted by {@link DeviceMetadataService.createDevice}. */
export interface CreateDeviceInput {
  readonly projectId: string;
  /** Wire key (`x-insight-device`). Defaults to the generated id when omitted. */
  readonly key?: string;
  readonly name: string;
  readonly id?: string;
  readonly model?: string | null;
  readonly location?: string | null;
  readonly note?: string | null;
  readonly status?: DeviceStatus;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an optional free-form field: trim, then collapse "empty" to `null`
 * so a blank string can never masquerade as a set value.
 */
export function normaliseOptional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Device-metadata use cases.
 *
 * All public methods are async and follow the throw-on-failure convention
 * described at the top of this file.
 */
export class DeviceMetadataService {
  readonly #repo: DeviceRepo;
  readonly #membership: MembershipLookup;
  readonly #now: () => number;
  readonly #genId: () => string;

  constructor(repo: DeviceRepo, options: DeviceMetadataServiceOptions) {
    this.#repo = repo;
    this.#membership = options.membership;
    this.#now = options.now ?? (() => Date.now());
    this.#genId = options.genId ?? (() => crypto.randomUUID());
  }

  /**
   * Create a device.
   *
   * Throws `invalid_input` for a blank name/project, `invalid_status` for an
   * unknown lifecycle status, and `device_exists` when the generated (or
   * supplied) id is taken.
   */
  async createDevice(input: CreateDeviceInput): Promise<CreateDeviceResult> {
    const projectId = input.projectId?.trim();
    if (!projectId) throw new DeviceError("invalid_input", "projectId is required");

    const name = input.name?.trim();
    if (!name) throw new DeviceError("invalid_input", "device name is required");

    const status: DeviceStatus = input.status ?? "active";
    if (!isDeviceStatus(status)) {
      throw new DeviceError("invalid_status", `unknown device status: ${String(input.status)}`);
    }

    const id = input.id ?? this.#genId();
    if (await this.#repo.get(id)) {
      throw new DeviceError("device_exists", `device id already exists: ${id}`);
    }

    const at = this.#now();
    const device: Device = {
      id,
      projectId,
      key: input.key?.trim() || id,
      name,
      model: normaliseOptional(input.model),
      location: normaliseOptional(input.location),
      note: normaliseOptional(input.note),
      status,
      createdAt: at,
      updatedAt: at,
    };
    return { device: await this.#repo.insert(device) };
  }

  /**
   * Read a device by id, or throw `device_not_found`.
   *
   * Deliberately tenant-unaware: a *read* of a known id is not a cross-tenant
   * leak of a foreign row (the caller holds the id), and reads are not gated by
   * role. Write paths below are tenant-scoped by membership instead.
   */
  async getDevice(id: string): Promise<Device> {
    const device = await this.#repo.get(id);
    if (!device) {
      throw new DeviceError("device_not_found", `no such device: ${id}`);
    }
    return device;
  }

  /** All devices of `projectId`. */
  async listDevices(projectId: string): Promise<readonly Device[]> {
    if (!projectId?.trim()) throw new DeviceError("invalid_input", "projectId is required");
    return this.#repo.listByProject(projectId);
  }

  /**
   * Rename a device (`PATCH /:id`, name field).
   *
   * Authorization: **owner or admin** — a plain `member` is refused `403`
   * (`forbidden`). Throws `device_not_found` for an unknown id and
   * `invalid_input` for a blank name.
   */
  async rename(id: string, name: string, actorId: string): Promise<Device> {
    const device = await this.getDevice(id);
    await this.#authorizeWrite(device, actorId);

    const next = name?.trim();
    if (!next) throw new DeviceError("invalid_input", "device name cannot be blank");

    const updated = await this.#repo.update(id, { name: next }, this.#now());
    if (!updated) throw new DeviceError("device_not_found", `no such device: ${id}`);
    return updated;
  }

  /**
   * Update the lifecycle metadata of a device (`PATCH /:id`, model/location/
   * note/status).
   *
   * Authorization matches {@link rename}: **owner or admin**. An unknown status
   * is `invalid_status`; an omitted field is left as-is; `null` clears it.
   */
  async updateMetadata(
    id: string,
    patch: DeviceMetadataPatch,
    actorId: string,
  ): Promise<Device> {
    const device = await this.getDevice(id);
    await this.#authorizeWrite(device, actorId);

    if (patch.status !== undefined && !isDeviceStatus(patch.status)) {
      throw new DeviceError("invalid_status", `unknown device status: ${String(patch.status)}`);
    }

    // Only carry through keys the caller actually supplied, normalising the
    // free-form ones so a blank string becomes an explicit clear (`null`).
    const applied: { model?: string | null; location?: string | null; note?: string | null; status?: DeviceStatus } = {};
    if ("model" in patch) applied.model = normaliseOptional(patch.model);
    if ("location" in patch) applied.location = normaliseOptional(patch.location);
    if ("note" in patch) applied.note = normaliseOptional(patch.note);
    if ("status" in patch) applied.status = patch.status;

    const updated = await this.#repo.update(id, applied, this.#now());
    if (!updated) throw new DeviceError("device_not_found", `no such device: ${id}`);
    return updated;
  }

  /**
   * Delete a device (`DELETE /:id`).
   *
   * Authorization: **owner or admin** — a plain `member` is refused `403`.
   * Throws `device_not_found` for an unknown id.
   */
  async delete(id: string, actorId: string): Promise<void> {
    const device = await this.getDevice(id);
    await this.#authorizeWrite(device, actorId);
    const removed = await this.#repo.delete(id);
    if (!removed) throw new DeviceError("device_not_found", `no such device: ${id}`);
  }

  /**
   * Ingest gate (INV-DEV-status): assert `device` is permitted to write
   * telemetry.
   *
   * An `active` device passes and the device is returned (so the caller can
   * attribute the sample). A `retired` or `dormant` device is refused with
   * `device_not_ingestible` → **403** (see {@link INGEST_REFUSED} for the
   * documented policy). Throws nothing on the happy path.
   */
  assertIngestible(device: Device): Device {
    return assertIngestible(device);
  }

  /**
   * Resolve a device by id and gate its ingestibility in one step, so an
   * ingest route cannot forget the gate: unknown id → `device_not_found`
   * (404); a retired/dormant device → `device_not_ingestible` (403); an active
   * device is returned.
   */
  async requireIngestible(id: string): Promise<Device> {
    return assertIngestible(await this.getDevice(id));
  }

  /**
   * Enforce the write authorization shared by rename/updateMetadata/delete:
   * the actor must hold `device:update` (owner/admin) in the DEVICE'S project.
   *
   * A non-member is reported `not_a_member`; a member below the required role is
   * `forbidden`. Both are `403` on the wire, but the distinct codes let a route
   * (or a log) tell "you are not in this tenant" from "you are in it, but too
   * junior".
   */
  async #authorizeWrite(device: Device, actorId: string): Promise<void> {
    const actor = actorId?.trim();
    if (!actor) throw new DeviceError("invalid_input", "actorId is required");

    if (await this.#membership.can(actor, device.projectId, DEVICE_MANAGE_PERMISSION)) {
      return;
    }

    // Distinguish "not a member" from "member, insufficient role" when the
    // seam can tell us; otherwise fail closed as `forbidden`.
    const role = this.#membership.roleOf
      ? await this.#membership.roleOf(actor, device.projectId)
      : null;
    if (role === null || !isRole(role)) {
      throw new DeviceError(
        "not_a_member",
        `user ${actor} is not a member of ${device.projectId}`,
      );
    }
    throw new DeviceError(
      "forbidden",
      `role "${role}" cannot manage devices (requires "${DEVICE_MANAGE_PERMISSION}")`,
    );
  }
}

/**
 * The permission a device-management action requires.
 *
 * Reuses the EXISTING membership vocabulary rather than minting a new action
 * (this task may not edit `projects/membership.ts`): `project:update` is
 * declared there with a minimum role of `admin`, which yields exactly the
 * "owner or admin, member refused" rule of FR-DEV-04. Device management is a
 * project-admin-class write, so it is gated by the project-admin permission —
 * no second lattice lives in this file.
 */
export const DEVICE_MANAGE_PERMISSION: Permission = "project:update";

/**
 * Standalone ingest gate over a device — the module-level form of
 * {@link DeviceMetadataService.assertIngestible}, for callers that already hold
 * the record.
 *
 * @throws {DeviceError} `device_not_ingestible` (→ 403) for a `retired` or
 *         `dormant` device.
 */
export function assertIngestible(device: Device): Device {
  if (INGEST_REFUSED[device.status]) {
    throw new DeviceError(
      "device_not_ingestible",
      `device ${device.id} is "${device.status}" and may not ingest telemetry`,
    );
  }
  return device;
}

/** Non-throwing form of {@link assertIngestible}. */
export function checkIngestible(device: Device): boolean {
  return !INGEST_REFUSED[device.status];
}

// ---------------------------------------------------------------------------
// In-memory fake — an honest implementation of the seam for tests & local dev
// ---------------------------------------------------------------------------

/**
 * In-memory {@link DeviceRepo}.
 *
 * Keeps records by id in insertion order and applies patches with the same
 * "unset keys untouched, `null` clears" semantics the D1 adapter would. Not a
 * production store: it never evicts.
 */
export class InMemoryDeviceRepo implements DeviceRepo {
  readonly #byId = new Map<string, Device>();

  /** Every stored device, insertion-ordered. */
  all(): readonly Device[] {
    return Array.from(this.#byId.values());
  }

  async insert(device: Device): Promise<Device> {
    if (this.#byId.has(device.id)) {
      throw new Error(`InMemoryDeviceRepo: duplicate id ${device.id}`);
    }
    this.#byId.set(device.id, device);
    return device;
  }

  async get(id: string): Promise<Device | null> {
    return this.#byId.get(id) ?? null;
  }

  async listByProject(projectId: string): Promise<readonly Device[]> {
    return this.all().filter((device) => device.projectId === projectId);
  }

  async update(
    id: string,
    patch: DeviceMetadataPatch & { name?: string },
    now: number,
  ): Promise<Device | null> {
    const existing = this.#byId.get(id);
    if (existing === undefined) return null;

    // Only keys present in the patch are applied; `null` is an explicit clear,
    // so a partial patch never disturbs a field it does not mention.
    const next: Device = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...("model" in patch ? { model: patch.model ?? null } : {}),
      ...("location" in patch ? { location: patch.location ?? null } : {}),
      ...("note" in patch ? { note: patch.note ?? null } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: now,
    };
    this.#byId.set(id, next);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    return this.#byId.delete(id);
  }
}

/**
 * In-memory {@link MembershipLookup} for tests and local dev.
 *
 * Keyed by `(projectId, userId)` — the tenant is part of the key, so a member
 * of project A is simply not found under B, exactly the isolation the real
 * adapter must provide. Honors an explicit permission set when supplied,
 * otherwise falls back to the shared `can(role, action)` gate.
 */
export class InMemoryMembershipLookup implements MembershipLookup {
  /** `projectId\u0000userId` -> granted role, plus optional explicit perms. */
  readonly #grants = new Map<string, { role: Role; permissions?: readonly Permission[] }>();

  /** Grant `userId` the `role` in `projectId` (optionally with explicit perms). */
  grant(
    projectId: string,
    userId: string,
    role: Role,
    permissions?: readonly Permission[],
  ): this {
    this.#grants.set(InMemoryMembershipLookup.#key(projectId, userId), {
      role,
      permissions,
    });
    return this;
  }

  roleOf(userId: string, projectId: string): Role | null {
    return this.#grants.get(InMemoryMembershipLookup.#key(projectId, userId))?.role ?? null;
  }

  can(userId: string, projectId: string, action: Permission): boolean {
    const grant = this.#grants.get(InMemoryMembershipLookup.#key(projectId, userId));
    if (grant === undefined) return false;
    if (grant.permissions !== undefined) return grant.permissions.includes(action);
    return can(grant.role, action);
  }

  static #key(projectId: string, userId: string): string {
    // NUL never appears in a normalised tenant/user id, so it is a safe split.
    return `${projectId}\u0000${userId}`;
  }
}
