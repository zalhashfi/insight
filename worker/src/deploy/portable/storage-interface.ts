/**
 * deploy/portable/storage-interface — the **backend-neutral storage seam** the
 * worker is written against (A32, NFR-CMP-02/03).
 *
 * ## Why this file exists
 *
 * Insight's first deploy target is Cloudflare (D1 + Durable Objects + R2), but
 * the product must be **self-hostable** without any third-party credential
 * (spec §NFR-CMP-03: "deploy self-host tanpa rahasia pihak ketiga"). The way to
 * make that true *provably* — rather than by asserting it — is to name the
 * operations the worker actually needs and to make every storage engine
 * implement those operations and nothing more.
 *
 * This interface is that list. It is a **distilled, aggregate view of the seams
 * the worker already runs on**, not a new abstraction layered on top of them:
 *
 *   | group      | verb shape                                       | today's seam (unchanged)                        |
 *   |------------|--------------------------------------------------|-------------------------------------------------|
 *   | `tenants`  | `count()` / atomic `insertFirst(owner)`          | `identity/bootstrap.ts` `UserRepo`               |
 *   | `sessions` | `insert` / `findById` / `delete` / `deleteByUser`| `sessions` table (migration `0001`)              |
 *   | `projects` | `insert` / `get` / `getBySlug`                   | `projects` table                                 |
 *   | `tokens`   | hash-only `insert` / `findByHash`                | `identity/tokens.ts` / `user-tokens.ts`          |
 *   | `devices`  | `insert` / `get` / `listByProject` / `delete`    | `devices/metadata.ts` `DeviceRepo`               |
 *   | `state`    | `putState` / `getState` / `listState`            | `durable-objects/project-do.ts` `ProjectStorage` |
 *   | `series`   | `appendSample` / `ring` / `transact`             | `durable-objects/shard-do.ts` `ShardStorage`     |
 *   | `control`  | `enqueue` / `list` / `resolve`                   | ProjectDO `pending_control` control plane        |
 *   | `audit`    | append-only `append` / `listByProject`           | `settings/audit-log.ts` `AuditStore`             |
 *   | `firmware` | `find` / `insert` / `upsert` / object `put`/`get`| `firmware/upload.ts` `FirmwareRepo`/`ImageStore` |
 *   | `automations` | `get` / `setEnabled`                          | `engine/manual-run.ts` `AutomationRepo`          |
 *   | `runLog`   | append-only `append`                             | `engine/manual-run.ts` `RunLog`                  |
 *   | `cursors`  | `read` / `write`                                 | `external/poll.ts` `CursorStore`                 |
 *
 * **Every one of those seams stays exactly as it is.** This interface does not
 * replace them and nothing in the worker is rewired onto it — the domain
 * modules keep injecting their own narrow seams (that is what keeps the worker
 * testable). What this file adds is the *portability proof*: a single named
 * contract, wide enough to cover what the worker needs, that a Postgres/
 * Timescale adapter satisfies. If a backend can implement `Storage` and the
 * conformance suite passes on it, the worker is not bound to any specific
 * backend — which is precisely what the portability harness demonstrates.
 *
 * ## Shape rules (why it looks the way it does)
 *
 *   * **No SQL, no driver, no dialect leaks.** No method takes or returns a
 *     prepared statement, a result-set cursor, or a backend exception. The
 *     contract is plain values + promises, so a `pg` adapter, a D1 adapter and
 *     an in-memory fake satisfy it identically. Nothing here mentions D1, R2,
 *     Durable Objects or any vendor token.
 *   * **Hashes only, never plaintext.** {@link TokenKind} records carry a
 *     {@link TokenRecord.hash}, so an implementation can never be handed, or
 *     asked to return, a secret. This is a type-level guarantee, not a
 *     convention.
 *   * **Tenant identity is part of the key**, never a filter a caller must
 *     remember: `getState(project, device, variable)`,
 *     `getFirmware(project, version)`, `listDevices(project)`. A cross-tenant
 *     read is therefore impossible to *express*, which is the strongest form of
 *     tenant isolation.
 *   * **Cross-store atomicity is expressed once**, as {@link Storage.transact},
 *     because the write path genuinely needs it: a sample must be appended to
 *     the ring and its inflight journal row in ONE transaction (INV-T4), and a
 *     device retirement must flip the metadata row and its ingest gate together
 *     (INV-DEV-status). Modelling that as an explicit `transact(fn)` — the
 *     function's work is committed or rolled back as a unit — is the honest
 *     description, and a fake can implement it trivially by snapshotting.
 *   * **Append-only stores stay append-only** (audit, run log): their group
 *     offers no update and no delete, so a rewritable history cannot be
 *     expressed through this contract.
 *
 * ## Credentials
 *
 * There are **none** here. The interface carries no connection string, no user,
 * no password, no host, no token. Those are a *deploy concern*: an adapter is
 * constructed from whatever the environment supplies at deploy time (a binding,
 * an env var, a mounted secret) and the storage seam never sees them. Keeping
 * the seam credential-free is what lets the same worker binary run against a
 * local container, a Fly volume-backed Postgres, or a managed instance with
 * nothing in the source tree changing.
 *
 * ## Timestamps & clocks
 *
 * Every time value is **Unix epoch milliseconds, UTC** (the repo-wide
 * convention), and is always *supplied by the caller* — the store owns no
 * clock. That keeps every write deterministic and lets a test pin "now".
 */

// ---------------------------------------------------------------------------
// Shared scalar types
// ---------------------------------------------------------------------------

/** Unix epoch milliseconds (UTC) — the repo-wide time unit. */
export type EpochMs = number;

/** A caller-supplied "now" seam. The store never reaches for a wall clock. */
export type Clock = () => EpochMs;

/**
 * A backend-neutral, comparable timestamp as it is handed to the store.
 *
 * Kept structurally identical to {@link EpochMs} so an adapter can map it onto
 * any native type (a Postgres `timestamptz`, a Timescale hypertable column, a
 * SQLite integer) without the seam committing to one. ms-precision epoch is the
 * common denominator every candidate backend can represent.
 */
export type Timestamp = EpochMs;

/** A page of rows plus the cursor a caller passes back to fetch the next one. */
export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque continuation token; `null` when this page is the last. */
  readonly next: string | null;
}

// ---------------------------------------------------------------------------
// Tenants (accounts) — the founding-owner claim
// ---------------------------------------------------------------------------

/** A stored account (tenant owner). Mirrors the `users` row, no secret field. */
export interface TenantRecord {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly createdAt: EpochMs;
}

/**
 * Tenant store. Deliberately two methods.
 *
 * `insertFirstTenant` is the **atomic single-writer claim** the invite-only
 * bootstrap rests on: it inserts `tenant` iff no tenant exists yet and reports
 * whether this caller created it. Of N concurrent callers exactly one observes
 * `true`; implementations MUST make the emptiness check and the insert one
 * atomic step (a unique guard row, an `INSERT … WHERE NOT EXISTS`, a
 * serialized section) — a read-then-write is the race the contract forbids.
 */
export interface TenantStore {
  /** Number of tenants currently stored (`0` means still bootstrappable). */
  countTenants(): Promise<number>;

  /**
   * Insert `tenant` only if the store is empty; `true` iff this call created it.
   */
  insertFirstTenant(tenant: TenantRecord): Promise<boolean>;

  /** The tenant with this id, or `null`. */
  getTenant(id: string): Promise<TenantRecord | null>;
}

// ---------------------------------------------------------------------------
// Sessions (human logins)
// ---------------------------------------------------------------------------

/** A stored login session. The token is held as a hash, never plaintext. */
export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: EpochMs;
  readonly createdAt: EpochMs;
}

/** Session store. Active sessions are resolved by hash; expiry is the caller's policy. */
export interface SessionStore {
  /** Insert a new session (rejects a duplicate `id`). */
  insertSession(session: SessionRecord): Promise<SessionRecord>;
  /** The session with this id, or `null`. */
  getSession(id: string): Promise<SessionRecord | null>;
  /** The session carrying this token hash, or `null`. */
  findSessionByHash(tokenHash: string): Promise<SessionRecord | null>;
  /** Remove a session (`false` when the id was unknown) — logout/revoke. */
  deleteSession(id: string): Promise<boolean>;
  /** Remove every session of a user; returns how many were removed. */
  deleteSessionsForUser(userId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Projects (tenants' namespaces)
// ---------------------------------------------------------------------------

/** A stored project. */
export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerId: string;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
}

/** Project store. */
export interface ProjectStore {
  /** Insert a new project (rejects a duplicate `id` or `slug`). */
  insertProject(project: ProjectRecord): Promise<ProjectRecord>;
  /** The project with this id, or `null`. */
  getProject(id: string): Promise<ProjectRecord | null>;
  /** The project with this slug, or `null` (slugs are unique). */
  getProjectBySlug(slug: string): Promise<ProjectRecord | null>;
  /** Remove a project (`false` when the id was unknown). */
  deleteProject(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Tokens (device project tokens + user tokens) — hashes only
// ---------------------------------------------------------------------------

/** Which family a stored token belongs to. */
export type TokenKind = "project" | "user";

/**
 * A stored token. **There is deliberately no plaintext field** — an adapter can
 * never be handed, nor asked to return, a secret. Every credential satisfies
 * this shape: a project token and a user token differ only in {@link kind} and
 * {@link ownerId} (a project id vs a user id).
 */
export interface TokenRecord {
  readonly id: string;
  readonly kind: TokenKind;
  /** Owning project id (`project` tokens) or user id (`user` tokens). */
  readonly ownerId: string;
  /** SHA-256 hex digest of the plaintext; the only credential material kept. */
  readonly hash: string;
  /** Optional display prefix (`pt_AbC1`), never the full secret. */
  readonly prefix?: string;
  /** Space-separated capability list; `undefined` means least privilege. */
  readonly scopes?: string;
  readonly expiresAt: EpochMs | null;
  /** Epoch ms of revocation, or `null` while usable. */
  readonly revokedAt: EpochMs | null;
  readonly createdAt: EpochMs;
}

/** Token store. Reads are by hash; revocation is a durable stamp. */
export interface TokenStore {
  /** Insert a new token (rejects a duplicate hash — the unique index). */
  insertToken(token: TokenRecord): Promise<TokenRecord>;
  /** The (at most one) token with this hash, revoked or not. */
  findTokenByHash(hash: string): Promise<TokenRecord | null>;
  /**
   * Stamp `revokedAt` on the token; returns the updated row, or `null` when the
   * id is unknown. Revoking an already-revoked token is idempotent.
   */
  revokeToken(id: string, at: EpochMs): Promise<TokenRecord | null>;
}

// ---------------------------------------------------------------------------
// Devices (lifecycle metadata + registry)
// ---------------------------------------------------------------------------

/** A device's lifecycle status. A `retired`/`dormant` device may not ingest. */
export type DeviceStatus = "active" | "dormant" | "retired";

/** A stored device (the slowly-changing metadata half — telemetry lives in series). */
export interface DeviceRecord {
  readonly id: string;
  readonly projectId: string;
  /** Device key as seen on the wire (`x-insight-device`). */
  readonly key: string;
  readonly name: string;
  readonly model: string | null;
  readonly location: string | null;
  readonly status: DeviceStatus;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
}

/** The fields a caller may change; unset keys are left untouched. */
export interface DevicePatch {
  readonly name?: string;
  readonly model?: string | null;
  readonly location?: string | null;
  readonly status?: DeviceStatus;
}

/** Device store. Every method is keyed/scoped by device or tenant. */
export interface DeviceStore {
  /** Insert a new device (rejects a duplicate `id`). */
  insertDevice(device: DeviceRecord): Promise<DeviceRecord>;
  /** The device with this id, or `null`. Never another tenant's row. */
  getDevice(id: string): Promise<DeviceRecord | null>;
  /** All devices of `projectId`, insertion-ordered. Never crosses tenants. */
  listDevices(projectId: string): Promise<readonly DeviceRecord[]>;
  /** Apply `patch` atomically; `null` when no device has that id. */
  updateDevice(id: string, patch: DevicePatch, at: EpochMs): Promise<DeviceRecord | null>;
  /** Remove the device (`false` when the id was unknown). */
  deleteDevice(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// State (projected "latest winning reading" per stream)
// ---------------------------------------------------------------------------

/** One projected stream: the latest winning reading for `(device, variable)`. */
export interface StateRow {
  readonly device: string;
  readonly variable: string;
  /** `null` is a valid reading, distinct from "absent". */
  readonly value: number | null;
  readonly ts: EpochMs;
  readonly seq: number;
}

/**
 * Projection store. Upsert-one, read-one, list-all — the exact verb set the
 * projection needs; the ordering rule (ts then seq) stays in `ProjectDO`.
 */
export interface StateStore {
  /** Upsert the winning row for one `(device, variable)` stream. */
  putState(projectId: string, row: StateRow): Promise<void>;
  /** The stored row for one stream, or `null`. */
  getState(projectId: string, device: string, variable: string): Promise<StateRow | null>;
  /** Every projected row of `projectId`. */
  listState(projectId: string): Promise<readonly StateRow[]>;
}

// ---------------------------------------------------------------------------
// Series (the time-series data plane) + atomicity
// ---------------------------------------------------------------------------

/** One raw sample, the shape both the ring buffer and inflight journal store. */
export interface Sample {
  readonly device: string;
  readonly metric: string;
  readonly value: number | null;
  readonly ts: EpochMs;
  readonly seq: number;
  readonly recordedAt: EpochMs;
}

/** Ordering/projection state for one `(device, metric)` stream. */
export interface StreamMeta {
  readonly device: string;
  readonly metric: string;
  readonly latestTs: EpochMs | null;
  readonly latestValue: number | null;
  readonly latestSeq: number;
  readonly nextSeq: number;
  readonly dropped: number;
}

/** Which physical buffer a {@link Sample} is written to. */
export type SampleBuffer = "ring" | "inflight";

/**
 * A transaction handle: the operations that must commit or roll back as a unit.
 *
 * The write-ahead protocol has one hard invariant — a sample is appended to the
 * **ring and the inflight journal together**, or to neither (INV-T4) — and no
 * two-call sequence can express "together". {@link Storage.transact} supplies
 * the only correct expression: the handle is the same append/meta surface as
 * {@link SeriesStore}, but every write through it is part of one commit.
 */
export interface Transaction {
  /** Update a stream's ordering state. */
  putMeta(meta: StreamMeta): Promise<void>;
  /** Append a sample to a buffer (ring or inflight) of its stream. */
  appendSample(sample: Sample, buffer: SampleBuffer): Promise<void>;
}

/**
 * Time-series store — the analytics data plane (a `ring_buffer` + `inflight`
 * pair in the Cloudflare shape, a hypertable in the Timescale shape).
 *
 * All writes emit **ascending-seq** order for a stream; `appendSample` does not
 * enforce it (the ordering gate lives in `ShardDO`), it only persists.
 */
export interface SeriesStore {
  /** Stream ordering state, or `null` when the stream has never been seen. */
  getMeta(device: string, metric: string): Promise<StreamMeta | null>;
  /** Upsert stream ordering state (non-transactional convenience). */
  putMeta(meta: StreamMeta): Promise<void>;
  /** Append a sample to a buffer of its stream. */
  appendSample(sample: Sample, buffer: SampleBuffer): Promise<void>;
  /** Ascending-seq ring rows of one stream (oldest first). */
  ring(device: string, metric: string): Promise<readonly Sample[]>;
  /** Ascending-seq inflight rows of one stream (oldest first). */
  inflight(device: string, metric: string): Promise<readonly Sample[]>;
  /** Remove one ring row by stream + seq (the FIFO head). */
  evictRingOldest(device: string, metric: string): Promise<void>;
  /** Remove a delivered inflight row by `(device, seq)`; idempotent. */
  deleteInflight(device: string, seq: number): Promise<void>;
  /**
   * Advance a stream's flush high-water mark to `upToSeq`. Monotonic: a value
   * below the stored mark is ignored, so a retried drain never rolls back.
   */
  commitFlushed(device: string, metric: string, upToSeq: number): Promise<void>;
  /** The stream's durable flush high-water mark (`0` when never flushed). */
  flushedTo(device: string, metric: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Control (pending device commands)
// ---------------------------------------------------------------------------

/** A pending outbound control command for a device. */
export interface ControlCommand {
  readonly id: string;
  readonly projectId: string;
  readonly device: string;
  readonly variable: string;
  readonly value: number | null;
  /** Epoch ms after which the command is stale. */
  readonly ttl: EpochMs;
  readonly createdAt: EpochMs;
}

/** Control store — the two-way control plane's durable queue. */
export interface ControlStore {
  /** Enqueue a command for delivery to a device. */
  enqueue(command: ControlCommand): Promise<ControlCommand>;
  /** Pending, unexpired commands of a device, oldest first. */
  list(projectId: string, device: string): Promise<readonly ControlCommand[]>;
  /** Mark a command acknowledged; `false` when the id was unknown. */
  resolve(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Audit log (append-only)
// ---------------------------------------------------------------------------

/** A sensitive action recorded in the audit trail. */
export interface AuditRecord {
  readonly id: string;
  readonly projectId: string;
  readonly action: string;
  readonly category: string;
  readonly actorId: string;
  readonly target: string;
  readonly at: EpochMs;
}

/** The caller-supplied half of an audit entry (`id`/`at` are the store's). */
export interface NewAuditRecord {
  readonly projectId: string;
  readonly action: string;
  readonly category: string;
  readonly actorId: string;
  readonly target: string;
}

/**
 * Audit store. **Append-only by construction**: no update, no delete, and no
 * clear exist, so a rewritable trail cannot be expressed.
 */
export interface AuditStore {
  /** Append one entry, assigning its id and `at` stamp. */
  append(entry: NewAuditRecord): Promise<AuditRecord>;
  /** Every entry of `projectId` (order unspecified). */
  listByProject(projectId: string): Promise<readonly AuditRecord[]>;
}

// ---------------------------------------------------------------------------
// Firmware (metadata row + object bytes)
// ---------------------------------------------------------------------------

/** One uploaded firmware image (metadata). */
export interface FirmwareRecord {
  readonly id: string;
  readonly projectId: string;
  readonly version: string;
  readonly size: number;
  readonly sha256: string;
  /** Object key the image bytes are stored under. */
  readonly objectKey: string;
  readonly createdAt: EpochMs;
}

/** Firmware store: the `(project, version)` row plus its object put/get. */
export interface FirmwareStore {
  /** The `(projectId, version)` row, or `null`. */
  findFirmware(projectId: string, version: string): Promise<FirmwareRecord | null>;
  /** Insert a new row (rejects a duplicate `(projectId, version)`). */
  insertFirmware(firmware: FirmwareRecord): Promise<FirmwareRecord>;
  /** Upsert in place — the replace policy of a re-upload. */
  upsertFirmware(firmware: FirmwareRecord): Promise<FirmwareRecord>;
  /** Store the raw image bytes under `objectKey` (an overwrite, not a new object). */
  putFirmwareObject(objectKey: string, bytes: Uint8Array): Promise<void>;
  /** The stored bytes under `objectKey`, or `null`. */
  getFirmwareObject(objectKey: string): Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------------------
// Automations + run log
// ---------------------------------------------------------------------------

/** A stored automation, scoped to its project. */
export interface AutomationRecord {
  readonly id: string;
  readonly projectId: string;
  /** The trigger → condition → action graph, stored opaquely by the seam. */
  readonly rule: unknown;
  /** Whether the automation is enabled (the owner switch). */
  readonly enabled: boolean;
}

/** Automation store — keyed by the pair `(projectId, id)`, never a bare id. */
export interface AutomationStore {
  /** The automation, or `null`. An id of another project resolves to `null`. */
  getAutomation(projectId: string, id: string): Promise<AutomationRecord | null>;
  /** Persist the enabled flag; `null` when the id is unknown. */
  setAutomationEnabled(
    projectId: string,
    id: string,
    enabled: boolean,
  ): Promise<AutomationRecord | null>;
}

/** One recorded automation run (`id`/`createdAt` are the log's). */
export interface RunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly automationId: string;
  readonly actorId: string;
  readonly trigger: string;
  readonly report: unknown;
  readonly createdAt: EpochMs;
}

/** The caller-supplied half of a run record. */
export interface NewRunRecord {
  readonly projectId: string;
  readonly automationId: string;
  readonly actorId: string;
  readonly trigger: string;
  readonly report: unknown;
}

/** Run-log store. **Append-only**: `append` is the only writer. */
export interface RunLogStore {
  /** Append a run record, assigning its id and `createdAt` stamp. */
  appendRun(entry: NewRunRecord): Promise<RunRecord>;
}

// ---------------------------------------------------------------------------
// Cursors (external-source watermarks)
// ---------------------------------------------------------------------------

/** Cursor store — one opaque watermark string per source. */
export interface CursorStore {
  /** The stored watermark for a source, or `null`. */
  read(sourceId: string): Promise<string | null>;
  /** Persist a new watermark for a source, replacing any previous value. */
  write(sourceId: string, cursor: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// The composite seam
// ---------------------------------------------------------------------------

/**
 * The portable storage seam: every group above, behind one object.
 *
 * `transact` is the one non-store member: it runs `work` inside a single
 * transaction and commits it atomically (rolling back — applying nothing — if
 * `work` throws). It exists because some invariants span operations: a sample's
 * ring and inflight rows must land together (INV-T4), and a device's status flip
 * and its ingest gate must move as one (INV-DEV-status).
 *
 * An implementation MUST be constructive with **no ambient configuration**: an
 * adapter is built from whatever the deploy supplies (a binding, an env var, a
 * mounted secret) and the seam itself carries none. See the module docs.
 */
export interface Storage
  extends TenantStore,
    SessionStore,
    ProjectStore,
    TokenStore,
    DeviceStore,
    StateStore,
    SeriesStore,
    ControlStore,
    AuditStore,
    FirmwareStore,
    AutomationStore,
    RunLogStore,
    CursorStore {
  /**
   * Run `work` in one transaction; commit atomically, apply nothing on throw.
   * @returns whatever `work` returns, once committed.
   */
  transact<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Errors — one neutral vocabulary every backend maps onto
// ---------------------------------------------------------------------------

/** Stable, backend-neutral failure codes a store may raise. */
export type StorageErrorCode =
  /** A uniqueness constraint was violated (duplicate id/hash/slug/`(project,version)`). */
  | "conflict"
  /** A referenced row does not exist (e.g. a foreign key target). */
  | "not_found"
  /** The caller's input was invalid (a shape the store refuses). */
  | "invalid"
  /** The backend is unreachable / the transaction could not be started. */
  | "unavailable";

/**
 * The single error type a store raises. It carries a stable {@link code} rather
 * than a backend exception, so a domain module can branch on `err.code` the same
 * way against a fake, a Postgres adapter or any other backend — no driver string
 * ever reaches the caller.
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

/** Guard for `catch` blocks: is `err` a {@link StorageError}? */
export function isStorageError(err: unknown): err is StorageError {
  return err instanceof StorageError;
}
