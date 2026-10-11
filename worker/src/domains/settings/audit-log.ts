/**
 * settings/audit-log — an append-only journal of *sensitive* project actions,
 * over an injected store seam.
 *
 * A settings screen is where a tenant changes the things that matter: it
 * deletes a resource, mints or revokes a token, edits configuration. Those are
 * exactly the operations a customer (or an incident reviewer) later needs to
 * answer "who did that, to what, and when?" for. This module is that journal.
 *
 * ## Over a seam (nothing here owns storage)
 *
 * The domain talks to {@link AuditStore}, never a storage engine. Production
 * backs it with D1 (`audit_log`, one append-only table); tests drive the
 * in-memory fake {@link InMemoryAuditStore}. The seam is deliberately tiny —
 * `append` + `listByProject` — because an audit log has a very small verb set:
 * you write to it, you read it back, and you never, ever mutate it.
 *
 * ## Append-only, by construction and by contract
 *
 * There is no `update`, no `delete`, and no `clear` in {@link AuditStore} — an
 * append-only log cannot be rewritten through an interface that offers no verb
 * for rewriting. Both operations the module exposes create a *new* immutable
 * {@link AuditRecord} and hand it to the store; neither ever touches a stored
 * one. This is what makes the trail trustworthy: an entry, once appended, is a
 * fact about the past.
 *
 * ## Sensitive, not exhaustive
 *
 * The log is intentionally narrow. {@link SENSITIVE_ACTIONS} names the closed
 * vocabulary of *recorded* actions — delete, token change, settings change —
 * each carrying a {@link AuditCategory}. Everything else
 * ({@link NON_SENSITIVE_ACTIONS}: a read, a list, an ordinary render) is
 * *refused* by {@link AuditLog.record}, which throws
 * {@link AuditError} `not_sensitive` rather than writing an entry.
 *
 * Why refuse instead of silently skipping? Because "not recorded" and "recorded
 * as a no-op" must never be confusable at the call site, and a silent skip in a
 * service method is indistinguishable from a bug. The rule is: the *caller*
 * filters to sensitive actions — {@link AuditLog.isSensitive} is that filter —
 * and the log holds the line that it will not fabricate a sensitive entry out
 * of an ordinary event. The motivating example is a dashboard auto-refresh: it
 * fires constantly and must never manufacture audit noise, so it simply never
 * calls in.
 *
 * ## The owner switch (documented)
 *
 * A project's owner may turn logging **off** — see
 * {@link AuditLog.setEnabled}. The guarantee when disabled is absolute and
 * easy to state: **nothing is recorded**. {@link AuditLog.record} returns
 * `null` and {@link AuditStore.append} is *never called*, so the disabled
 * state cannot be mistaken for "recorded then filtered out at read time" — a
 * test can assert the underlying store is untouched, which is the difference
 * between a privacy-preserving switch and a display toggle.
 *
 * The switch itself is an owner-class write. It is gated by the *same*
 * authorization seam the other admin actions use ({@link MembershipLookup} over
 * `projects/membership.ts`), so this module never mints a second role lattice:
 * a plain `member` attempting to disable (or re-enable) logging is refused
 * `403`. The current setting is cached in memory so the hot path (every
 * recorded action) needs no lookup; a fresh instance re-reads the project's
 * stored preference through {@link AuditStore.getEnabled}, so the *persisted*
 * default is the store's to own.
 *
 * ## Read
 *
 * {@link AuditLog.read} returns a project's entries **newest-first**. That is
 * the order the reader wants (the most recent thing is the thing you are
 * usually looking for) and it is imposed *here*, not by the store: the seam
 * may return entries in any order, and this module sorts a copy — newest stamp
 * first, insertion order as the tie-break — so two entries written in the same
 * millisecond still read back deterministically. Nothing is mutated in place.
 */

import { can, isRole, type Permission, type Role } from "../projects/membership";

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

/**
 * The *sensitive* actions this log records — the closed, sensitive-only
 * vocabulary. Each is pinned to the {@link AuditCategory} it belongs to, so a
 * new action cannot be added without deciding which kind of change it is.
 *
 * `delete` is any destructive removal (a device, a project's data, a member);
 * `token_create` / `token_revoke` are the credential lifecycle acts; the
 * `settings_*` trio is configuration change (enabling/disabling the log itself
 * is a settings change, recorded like any other).
 */
export const SENSITIVE_ACTIONS = {
  delete: "destructive",
  token_create: "token",
  token_revoke: "token",
  settings_change: "settings",
  settings_reset: "settings",
  audit_log_enable: "settings",
  audit_log_disable: "settings",
} as const;

/** A sensitive action name — one of the keys of {@link SENSITIVE_ACTIONS}. */
export type SensitiveAction = keyof typeof SENSITIVE_ACTIONS;

/**
 * The kind of change an action makes. Kept coarse on purpose: a reader filters
 * by *class* of change ("show me every destructive action"), not by one of a
 * hundred action names.
 */
export type AuditCategory = (typeof SENSITIVE_ACTIONS)[SensitiveAction];

/**
 * Actions that are deliberately **not** recorded — the mirror image of
 * {@link SENSITIVE_ACTIONS}, named so the exclusion is a documented decision
 * rather than an omission.
 *
 * A read, a listing, an ordinary render happens constantly (a dashboard
 * auto-refreshes) and would drown the trail in noise while telling a reviewer
 * nothing they care to know. {@link AuditLog.record} refuses them loudly with
 * `not_sensitive` so an accidental call is a bug report, not a silent write.
 */
export const NON_SENSITIVE_ACTIONS = [
  "read",
  "list",
  "render",
  "telemetry_ingest",
] as const;

/** An action this log refuses to record. */
export type NonSensitiveAction = (typeof NON_SENSITIVE_ACTIONS)[number];

/** Every action name this module knows about — sensitive or not. */
export type AuditAction = SensitiveAction | NonSensitiveAction;

/** Type guard: is `value` an action this log *records*? */
export function isSensitiveAction(value: unknown): value is SensitiveAction {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SENSITIVE_ACTIONS, value)
  );
}

/** Type guard: is `value` a known-not-recorded action? */
export function isNonSensitiveAction(value: unknown): value is NonSensitiveAction {
  return (
    typeof value === "string" &&
    (NON_SENSITIVE_ACTIONS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable, machine-readable failure codes for the audit-log domain. */
export type AuditErrorCode = "invalid_input" | "not_sensitive" | "not_a_member" | "forbidden";

/**
 * Lookup of an {@link AuditErrorCode} onto an HTTP status.
 *
 * Both authorization codes are `403`, matching the rest of the codebase: an
 * actor who may not flip the switch is authenticated but not permitted.
 * `not_sensitive` is a caller bug rather than a wire condition, so it maps onto
 * `400`. `invalid_input` is `400`.
 */
export const AUDIT_STATUS_CODE: Record<AuditErrorCode, number> = {
  invalid_input: 400,
  not_sensitive: 400,
  not_a_member: 403,
  forbidden: 403,
};

/**
 * Error thrown by every failing entry point of this module.
 *
 * `code` is stable and machine-readable; `status` is the HTTP status it maps
 * onto, so a Hono `onError` handler can translate it without a lookup table.
 */
export class AuditError extends Error {
  /** Stable code suitable for mapping onto an HTTP response. */
  readonly code: AuditErrorCode;

  /** HTTP status corresponding to {@link code}. */
  readonly status: number;

  constructor(code: AuditErrorCode, message: string) {
    super(message);
    this.name = "AuditError";
    this.code = code;
    this.status = AUDIT_STATUS_CODE[code];
  }
}

/** Convenience guard for `catch` blocks. */
export function isAuditError(err: unknown): err is AuditError {
  return err instanceof AuditError;
}

// ---------------------------------------------------------------------------
// Entities & repository seam
// ---------------------------------------------------------------------------

/**
 * A recorded sensitive action: *what* happened, to *which* target, by *whom*,
 * and *when*.
 *
 * The record is immutable (`readonly` throughout) because an audit entry is a
 * statement about the past — rewriting one would defeat the purpose of keeping
 * it. `actorId` answers "who", `target` answers "what" (a device id, a
 * project id, a token id, `"settings"` for a configuration change), and
 * `at` answers "when" (epoch ms, the store's clock, never the caller's).
 */
export interface AuditRecord {
  /** Stable id for this entry (the store's concern, not the caller's). */
  readonly id: string;
  /** The tenant the entry belongs to; every read is scoped by it. */
  readonly projectId: string;
  /** The sensitive action that occurred — see {@link SENSITIVE_ACTIONS}. */
  readonly action: SensitiveAction;
  /** The class of change {@link action} belongs to. */
  readonly category: AuditCategory;
  /** Who performed it (a resolved user id); never blank. */
  readonly actorId: string;
  /** What it was performed on (a device/token/project id, or a label). */
  readonly target: string;
  /** When it was recorded, epoch ms — the store's clock, not the caller's. */
  readonly at: number;
}

/**
 * The caller-supplied half of an entry. The `id` and the `at` stamp are the
 * store's to assign, so a caller can never backdate an entry or choose its
 * identity — the trail's "when" and "which" have exactly one author.
 */
export interface NewAuditRecord {
  readonly projectId: string;
  readonly action: SensitiveAction;
  readonly category: AuditCategory;
  readonly actorId: string;
  readonly target: string;
}

/**
 * Storage seam for the audit log. Implemented by a D1-backed adapter in
 * production and by the in-memory fake {@link InMemoryAuditStore} in tests.
 *
 * **Append-only.** There is deliberately no `update` and no `delete`: a store
 * that cannot rewrite an entry cannot be asked to. `append` is the only writer
 * and returns the stored entry (with its assigned id + stamp); `listByProject`
 * is the only reader and may return entries in any order (`AuditLog.read`
 * imposes newest-first). `getEnabled` / `setEnabled` carry the project's
 * owner switch, which is a property *of the tenant*, so it lives with the
 * tenant's rows.
 */
export interface AuditStore {
  /** Append one entry, assigning it an id and an `at` stamp. */
  append(entry: NewAuditRecord): Promise<AuditRecord>;

  /** Every entry of `projectId`, in unspecified order. */
  listByProject(projectId: string): Promise<readonly AuditRecord[]>;

  /** Whether logging is on for `projectId`; `false` when never set. */
  getEnabled(projectId: string): Promise<boolean>;

  /** Persist the owner switch for `projectId`. */
  setEnabled(projectId: string, enabled: boolean): Promise<void>;
}

/**
 * Membership seam: does `userId` hold a role in `projectId` that permits
 * `action`? Expressed as a single question — exactly the shape used by
 * `devices/metadata.ts` — so this module never needs a second copy of the
 * role lattice, which stays in `projects/membership.ts`.
 *
 * Implementations MUST scope by `projectId`: a member of project A acting on
 * project B must answer `false`, and the service surfaces that as
 * `not_a_member`, never a silent pass.
 */
export interface MembershipLookup {
  /** May `userId` perform `action` in `projectId`? */
  can(userId: string, projectId: string, action: Permission): Promise<boolean> | boolean;

  /** `userId`'s role in `projectId`, or `null` when they are not a member. */
  roleOf?(userId: string, projectId: string): Promise<Role | null> | Role | null;
}

/**
 * Options accepted by {@link AuditLog}.
 *
 * `membership` is required because the owner switch is gated; without it the
 * module could not tell an owner from a stranger, and "the owner can disable
 * logging" (the documented policy) would be unenforceable.
 */
export interface AuditLogOptions {
  /** Membership seam used to authorize flipping the switch. Required. */
  readonly membership: MembershipLookup;
  /** Id seam; defaults to `crypto.randomUUID`. */
  readonly genId?: () => string;
  /** Clock, `Date.now` by default; injected so tests can pin `at`. */
  readonly now?: () => number;
}

/** Input accepted by {@link AuditLog.record}. */
export interface RecordInput {
  readonly projectId: string;
  readonly action: AuditAction;
  /** Who performed the action; never blank. */
  readonly actorId: string;
  /** What was acted upon; never blank. */
  readonly target: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Order two entries newest-first.
 *
 * The stamp is the primary key; `id` is the tie-break so two entries written in
 * the same millisecond still come back in a deterministic order rather than
 * whichever order the store happened to return. Sorting by id descending is a
 * deliberate, documented choice: ids are opaque, but any *stable* rule turns
 * an ambiguous tie into a defined answer.
 */
export function byNewestFirst(a: AuditRecord, b: AuditRecord): number {
  if (a.at !== b.at) return b.at - a.at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** The permission an audit-log setting change requires (owner). */
export const AUDIT_SETTINGS_PERMISSION: Permission = "project:delete";

/**
 * The audit log's use cases: record a sensitive action, read a project's trail,
 * and let the owner switch logging on or off.
 *
 * All public methods are async and throw a typed {@link AuditError} on failure,
 * following the codebase-wide convention (see `projects/membership.ts`).
 */
export class AuditLog {
  readonly #store: AuditStore;
  readonly #membership: MembershipLookup;
  readonly #genId: () => string;
  readonly #now: () => number;

  /**
   * In-memory mirror of each project's switch. Memoised on first touch so the
   * hot path ({@link record}) never awaits a preference read; the *persisted*
   * value is still the store's, and a fresh instance re-reads it.
   */
  readonly #enabled = new Map<string, boolean>();

  constructor(store: AuditStore, options: AuditLogOptions) {
    this.#store = store;
    this.#membership = options.membership;
    this.#genId = options.genId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Record a sensitive action and return the stored entry, or `null` when
   * logging is disabled for the project.
   *
   * Throws `invalid_input` for a blank project/actor/target, and
   * `not_sensitive` for an action outside {@link SENSITIVE_ACTIONS} — a
   * non-sensitive action is **never** written (see {@link NON_SENSITIVE_ACTIONS}
   * for the documented rationale). When disabled the store is not touched at
   * all, so "disabled" is observable as an untouched store, not merely an
   * empty read.
   */
  async record(input: RecordInput): Promise<AuditRecord | null> {
    const projectId = input.projectId?.trim();
    if (!projectId) throw new AuditError("invalid_input", "projectId is required");

    const actorId = input.actorId?.trim();
    if (!actorId) throw new AuditError("invalid_input", "actorId is required");

    const target = input.target?.trim();
    if (!target) throw new AuditError("invalid_input", "target is required");

    if (!isSensitiveAction(input.action)) {
      throw new AuditError(
        "not_sensitive",
        `action "${String(input.action)}" is not sensitive and is not recorded`,
      );
    }

    // The owner switch, checked *before* any write: disabled means nothing is
    // recorded, and the store is provably untouched.
    if (!(await this.isEnabled(projectId))) return null;

    return this.#store.append({
      projectId,
      action: input.action,
      category: SENSITIVE_ACTIONS[input.action],
      actorId,
      target,
    });
  }

  /**
   * Read `projectId`'s trail, **newest-first**.
   *
   * A copy is sorted, never the store's array, and the store may return any
   * order — this method is the single place the read order is decided.
   */
  async read(projectId: string): Promise<readonly AuditRecord[]> {
    const id = projectId?.trim();
    if (!id) throw new AuditError("invalid_input", "projectId is required");

    const entries = await this.#store.listByProject(id);
    return [...entries].sort(byNewestFirst);
  }

  /** Whether logging is on for `projectId`; `false` when never set. */
  async isEnabled(projectId: string): Promise<boolean> {
    const id = projectId?.trim();
    if (!id) throw new AuditError("invalid_input", "projectId is required");

    const cached = this.#enabled.get(id);
    if (cached !== undefined) return cached;

    // Not cached yet: read the persisted preference, defaulting to ON. An audit
    // log that is off unless someone remembers to switch it on records nothing
    // by default; logging is the safe default and disabling is the deliberate
    // act, so `false` is never inferred from a missing row.
    const stored = await this.#store.getEnabled(id);
    const enabled = stored === true;
    this.#enabled.set(id, enabled);
    return enabled;
  }

  /**
   * Turn logging on or off for `projectId` — the owner-only switch.
   *
   * Authorization: **owner** — a plain `member` (or `admin`) is refused `403`
   * (`not_a_member` when not in the tenant at all, `forbidden` when present but
   * too junior). The change is persisted through {@link AuditStore.setEnabled},
   * cached, and then *itself* recorded as a sensitive settings change — turning
   * logging off is the most audit-worthy action there is, so the last thing a
   * trail shows when the switch is flipped off is that someone flipped it.
   *
   * The recorded entry is written directly (not through {@link record}), which
   * is what lets disabling produce a record while also proving the switch took
   * effect: after `setEnabled(id, false)` returns, an ordinary `record` writes
   * nothing.
   */
  async setEnabled(projectId: string, enabled: boolean, actorId: string): Promise<boolean> {
    const id = projectId?.trim();
    if (!id) throw new AuditError("invalid_input", "projectId is required");

    const actor = actorId?.trim();
    if (!actor) throw new AuditError("invalid_input", "actorId is required");

    await this.#authorizeOwner(id, actor);
    await this.#store.setEnabled(id, enabled);
    this.#enabled.set(id, enabled);

    // The switch itself is a settings change; record it whichever way it went.
    // Written directly so the entry exists even when `enabled` just became
    // `false` (a plain `record` call would now be dropped by the switch).
    await this.#store.append({
      projectId: id,
      action: enabled ? "audit_log_enable" : "audit_log_disable",
      category: SENSITIVE_ACTIONS[enabled ? "audit_log_enable" : "audit_log_disable"],
      actorId: actor,
      target: "audit_log",
    });

    return enabled;
  }

  /**
   * The static form of the sensitive filter: should `action` be recorded?
   *
   * Provided as a module-level predicate because the *caller* is the filter —
   * a route checks this before invoking {@link record}, so a non-sensitive
   * action never reaches the log in the first place. {@link record} re-checks
   * anyway, so the rule holds even for a caller that forgot.
   */
  isSensitive(action: unknown): action is SensitiveAction {
    return isSensitiveAction(action);
  }

  /**
   * Enforce the owner gate on the switch: the actor must hold
   * `AUDIT_SETTINGS_PERMISSION` (owner) in THIS project.
   *
   * A non-member is `not_a_member`; a member below owner is `forbidden`. Both
   * are `403` on the wire, but the distinct codes let a caller tell "you are
   * not in this tenant" from "you are in it, but not the owner".
   */
  async #authorizeOwner(projectId: string, actorId: string): Promise<void> {
    if (await this.#membership.can(actorId, projectId, AUDIT_SETTINGS_PERMISSION)) {
      return;
    }

    const role = this.#membership.roleOf
      ? await this.#membership.roleOf(actorId, projectId)
      : null;
    if (role === null || !isRole(role)) {
      throw new AuditError("not_a_member", `user ${actorId} is not a member of ${projectId}`);
    }
    throw new AuditError(
      "forbidden",
      `role "${role}" may not change audit-log settings (requires "${AUDIT_SETTINGS_PERMISSION}")`,
    );
  }
}

/**
 * Module-level sensitive filter — the function form of
 * {@link AuditLog.isSensitive}, for a caller (a route, a dispatcher) that wants
 * to decide *before* constructing a log call.
 */
export function isSensitive(action: unknown): action is SensitiveAction {
  return isSensitiveAction(action);
}

// ---------------------------------------------------------------------------
// In-memory fakes — honest implementations of the seams, for tests & local dev
// ---------------------------------------------------------------------------

/** Options for {@link InMemoryAuditStore}. */
export interface InMemoryAuditStoreOptions {
  /** Id generator, defaults to a zero-padded sequence (`a_1`, `a_2`, …). */
  readonly genId?: () => string;
  /** Clock, defaults to `Date.now`; injected so tests pin `at`. */
  readonly now?: () => number;
}

/**
 * In-memory {@link AuditStore} — an append-only journal plus the per-project
 * switch, suitable for tests and local development.
 *
 * Entries are kept in a plain array and are **never** removed or rewritten;
 * {@link InMemoryAuditStore.appended} exposes a raw count so a test can prove
 * that a disabled log left the store untouched (a stronger claim than an empty
 * read, which a read-time filter would also satisfy).
 */
export class InMemoryAuditStore implements AuditStore {
  /** Every appended entry, in insertion (oldest-first) order. */
  readonly entries: AuditRecord[] = [];

  readonly #genId: () => string;
  readonly #now: () => number;
  readonly #enabled = new Map<string, boolean>();
  /** Whether `getEnabled` has ever been consulted for a project. */
  readonly #enabledAsked = new Set<string>();

  constructor(options: InMemoryAuditStoreOptions = {}) {
    let seq = 0;
    this.#genId =
      options.genId ?? (() => `a_${++seq}`);
    this.#now = options.now ?? (() => Date.now());
  }

  /** How many entries have been appended — the raw write count. */
  appended(): number {
    return this.entries.length;
  }

  /** Whether `getEnabled` was consulted for `projectId` (a read-probe count). */
  wasEnabledAsked(projectId: string): boolean {
    return this.#enabledAsked.has(projectId);
  }

  async append(entry: NewAuditRecord): Promise<AuditRecord> {
    const record: AuditRecord = {
      id: this.#genId(),
      projectId: entry.projectId,
      action: entry.action,
      category: entry.category,
      actorId: entry.actorId,
      target: entry.target,
      at: this.#now(),
    };
    this.entries.push(record);
    return record;
  }

  async listByProject(projectId: string): Promise<readonly AuditRecord[]> {
    return this.entries.filter((entry) => entry.projectId === projectId);
  }

  async getEnabled(projectId: string): Promise<boolean> {
    this.#enabledAsked.add(projectId);
    // Default ON: a project that never touched the switch logs.
    return this.#enabled.get(projectId) ?? true;
  }

  async setEnabled(projectId: string, enabled: boolean): Promise<void> {
    this.#enabled.set(projectId, enabled);
  }
}

/**
 * In-memory {@link MembershipLookup} for tests and local dev.
 *
 * Keyed by `(projectId, userId)`, so the tenant is part of the key and a member
 * of project A is simply not found under B — the isolation the real adapter
 * must provide. Mirrors `devices/metadata.ts`'s fake so the two cannot diverge
 * in behaviour.
 */
export class InMemoryMembershipLookup implements MembershipLookup {
  /** `projectId\u0000userId` -> granted role, plus optional explicit perms. */
  readonly #grants = new Map<string, { role: Role; permissions?: readonly Permission[] }>();

  /** Grant `userId` the `role` in `projectId` (optionally with explicit perms). */
  grant(projectId: string, userId: string, role: Role, permissions?: readonly Permission[]): this {
    this.#grants.set(InMemoryMembershipLookup.#key(projectId, userId), { role, permissions });
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
