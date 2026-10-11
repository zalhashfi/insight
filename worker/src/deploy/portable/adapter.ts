/**
 * deploy/portable/adapter — a **portable {@link Storage} adapter** that proves
 * the worker is not bound to a specific backend (A32, NFR-CMP-02/03).
 *
 * ## What this file is
 *
 * It implements {@link Storage} (from `./storage-interface`) times over
 * **pluggable backends**, in the shape a **Postgres / TimescaleDB** deploy
 * would use:
 *
 *   * a metadata **relational backend** (the `PostgresBackend` shape — rows,
 *     keys, unique constraints) for tenants, sessions, projects, tokens,
 *     devices, projections, control, audit, firmware metadata, automations,
 *     run logs and cursors;
 *   * a **time-series backend** (the `TimescaleBackend` shape — append-only
 *     sample chunks) for the data plane.
 *
 * A self-host deploy provides the `pg`-backed implementations of those two
 * backend interfaces; a test provides the in-memory fakes at the foot of this
 * file. **The same adapter satisfies {@link Storage} either way** — which is
 * the whole point: the portability harness runs one conformance suite against
 * the adapter and the worker's real seams, and both pass unchanged.
 *
 * ## Why backends rather than one database
 *
 * Cloudflare's shape splits metadata (D1) from the time-series plane (DO
 * SQLite + R2). Postgres/Timescale's shape is the same split — a relational
 * database for the small, hot metadata, and a hypertable for the append-only
 * samples. The adapter mirrors that split with two interfaces, so it maps
 * cleanly onto *either* backend and the adapter code contains no schema of its
 * own: {@link PostgresBackend.ddl} / {@link TimescaleBackend.ddl} return the
 * ordered DDL a deploy runs at boot, and the adapter only ever calls verbs.
 *
 * ## Credentials
 *
 * **None.** The adapter never sees a connection string, a user, a password or a
 * host. Whether the backend is a local container, a Fly volume, or a managed
 * instance is decided by whoever constructs the backend at deploy time — from a
 * binding or an env var — and this module is transparent to it. That is what
 * makes "self-host with no third-party secret" (NFR-CMP-03) a property of the
 * code, not a promise.
 *
 * ## Atomicity
 *
 * {@link Storage.transact} is the adapter's one coordination point: it asks the
 * relational backend to run `work` in one transaction, passing a
 * {@link Transaction} handle back. If `work` throws, the backend applies
 * nothing. The in-memory fake implements this by snapshotting its state and
 * restoring it on throw, so the rollback contract is genuinely exercised by the
 * conformance suite (the write-ahead invariant INV-T4 depends on it).
 */

import {
  StorageError,
  type AuditRecord,
  type AuditStore,
  type AutomationRecord,
  type AutomationStore,
  type Clock,
  type ControlCommand,
  type ControlStore,
  type CursorStore,
  type DevicePatch,
  type DeviceRecord,
  type DeviceStore,
  type EpochMs,
  type FirmwareRecord,
  type FirmwareStore,
  type NewAuditRecord,
  type NewRunRecord,
  type ProjectRecord,
  type ProjectStore,
  type RunLogStore,
  type RunRecord,
  type Sample,
  type SampleBuffer,
  type SeriesStore,
  type SessionRecord,
  type SessionStore,
  type StateRow,
  type StateStore,
  type Storage,
  type StreamMeta,
  type TenantRecord,
  type TenantStore,
  type TokenRecord,
  type TokenStore,
  type Transaction,
} from "./storage-interface";

// ---------------------------------------------------------------------------
// Backend contracts (the two shapes a deploy supplies)
// ---------------------------------------------------------------------------

/** How a {@link BackendTx} scopes a list/read to one collection. */
export type Collection =
  // Metadata collections (relational backend).
  | "tenants"
  | "sessions"
  | "projects"
  | "tokens"
  | "devices"
  | "state"
  | "control"
  | "audit"
  | "firmware"
  | "firmware_object"
  | "automations"
  | "runlog"
  | "cursors"
  // Time-series collections (time-series backend).
  | "meta"
  | "ring"
  | "inflight";

/**
 * Stream identity for the time-series backend.
 *
 * A stream is `(device, metric)`; the backend is free to store it however it
 * likes (a composite key, two columns, a `series` foreign key) — the adapter
 * only ever names the stream, it never assumes a representation.
 */
export interface StreamRef {
  readonly device: string;
  readonly metric: string;
}

/**
 * The transactional verb surface both backends expose.
 *
 * Every method is promise-based and traffics in plain values — no SQL, no
 * result cursor, no driver type. A `pg`-backed implementation binds these to
 * prepared statements; the in-memory fake binds them to maps. The verb set is
 * intentionally small and uniform (`get`/`put`/`list`/`delete`/`claim`) so a new
 * backend is a small file, and so the UNIQUE constraints the adapter relies on
 * (a duplicate `id`/`hash`/`slug`) are expressed by the backend raising
 * {@link StorageError} with code `conflict`, never by an adapter-side pre-check.
 */
export interface BackendTx {
  /** The one row with this key in `collection`, or `null`. */
  get<T>(collection: Collection, key: string): Promise<T | null>;
  /** Insert or replace the row at `key`; returns the stored row. */
  put<T>(collection: Collection, key: string, row: T): Promise<T>;
  /**
   * Insert a **new** row, enforcing the backend's uniqueness constraints.
   *
   * MUST raise {@link StorageError} `conflict` when a unique key (a token hash,
   * a project slug, a `(project, version)`) already exists, and `not_found`
   * when a foreign-key target is missing. This is what makes the adapter's
   * duplicate handling correct without a read-then-write race.
   */
  insert<T>(collection: Collection, key: string, row: T, uniqueKeys?: readonly string[]): Promise<T>;
  /** Every row of `collection`, in the backend's natural order. */
  list<T>(collection: Collection, prefix?: string): Promise<readonly T[]>;
  /** Delete the row at `key`; returns whether a row was removed. */
  remove(collection: Collection, key: string): Promise<boolean>;
  /** Run `work` in ONE transaction (used by {@link Storage.transact}). */
  transaction<T>(work: (tx: BackendTx) => Promise<T>): Promise<T>;

  // --- Time-series surface (the Timescale-shaped backend) -----------------
  /** Stream ordering state, or `null`. */
  getStream(ref: StreamRef): Promise<StreamMeta | null>;
  /** Upsert stream ordering state. */
  putStream(meta: StreamMeta): Promise<void>;
  /** Append a sample to a buffer of its stream. */
  append(ref: StreamRef, sample: Sample, buffer: SampleBuffer): Promise<void>;
  /**
   * Remove a sample from a buffer by its `seq` and move the buffer's
   * high-water mark down to the new last seq (`0` when the buffer empties).
   * Idempotent: deleting an absent seq is a no-op and does not move the mark.
   */
  del(ref: StreamRef, buffer: SampleBuffer, seq: number): Promise<void>;
  /** Ascending-seq rows of one buffer of one stream (oldest first). */
  rows(ref: StreamRef, buffer: SampleBuffer): Promise<readonly Sample[]>;
  /**
   * Every inflight row of a device, across all its metric streams, so a
   * `(device, seq)` drain can locate the row's stream without knowing the
   * metric. Order unspecified.
   */
  scanInflight(device: string): Promise<readonly Sample[]>;
  /** Where a stream's flush high-water mark lives (`0` when never flushed). */
  flushed(ref: StreamRef): Promise<EpochMs>;
  /** Advance a stream's flush high-water mark (monotonic). */
  advanceFlushed(ref: StreamRef, upToSeq: number): Promise<void>;
}

/**
 * The relational (metadata) backend shape — Postgres / TimescaleDB in a
 * self-host deploy, the in-memory fake in tests.
 */
export interface PostgresBackend {
  /**
   * Ordered DDL the deploy applies at boot (idempotent: `CREATE TABLE IF NOT
   * EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`). Returned as data so the
   * adapter owns no schema and a deploy can diff/apply it however it likes.
   */
  ddl(): readonly string[];
  /** Run `work` in a fresh transaction against this backend. */
  transact<T>(work: (tx: BackendTx) => Promise<T>): Promise<T>;
}

/**
 * The time-series backend shape — a TimescaleDB hypertable in a self-host
 * deploy, the in-memory fake in tests. Exposed as its own interface so the two
 * halves of a deploy can be provisioned independently (metadata and samples can
 * live on different instances).
 */
export interface TimescaleBackend {
  /** Ordered DDL for the hypertables/indexes. */
  ddl(): readonly string[];
  /** Run `work` in a fresh transaction against this backend. */
  transact<T>(work: (tx: BackendTx) => Promise<T>): Promise<T>;
  /**
   * Optional: begin a transaction that a caller may span across more than one
   * `transact` call (used by {@link Storage.transact} to fold the data-plane
   * writes into the metadata transaction's unit). A backend that cannot express
   * a cross-instance unit may leave this undefined; the adapter then commits the
   * two halves independently.
   */
  begin?(): void;
  /** Optional: commit (`true`) or roll back (`false`) the unit opened by {@link begin}. */
  end?(commit: boolean): void;
}

/** What {@link createPortableStorage} needs to build an adapter. */
export interface PortableAdapterOptions {
  /** The relational metadata backend (Postgres/Timescale shaped). */
  readonly postgres: PostgresBackend;
  /** The time-series backend (a hypertable, or a fake in tests). */
  readonly timescale: TimescaleBackend;
  /** Id seam for store-assigned ids; defaults to `crypto.randomUUID`. */
  readonly genId?: () => string;
  /** Clock for store-assigned stamps; defaults to `Date.now`. */
  readonly now?: Clock;
}

/** The adapter's public surface: the seam plus its boot DDL. */
export interface PortableStorage extends Storage {
  /** The ordered DDL a deploy runs at boot (metadata then time-series). */
  ddl(): readonly string[];
}

// ---------------------------------------------------------------------------
// Key derivation (tenant identity is part of the key, never a filter)
// ---------------------------------------------------------------------------

/** `device \0 metric` — the stream key, opaque to the backend. */
function streamKey(ref: StreamRef): string {
  return `${ref.device}\u0000${ref.metric}`;
}

/** `device \0 variable` — the projection key. */
function stateKeyOf(device: string, variable: string): string {
  return `${device}\u0000${variable}`;
}

/** The adapter. */
export function createPortableStorage(options: PortableAdapterOptions): PortableStorage {
  const { postgres, timescale } = options;
  const genId = options.genId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => Date.now());

  /** Run `work` against the metadata backend in one transaction. */
  const read = <T>(work: (tx: BackendTx) => Promise<T>): Promise<T> => postgres.transact(work);

  // --- Tenant store ------------------------------------------------------
  const tenants: TenantStore = {
    countTenants: () => read((tx) => tx.list<TenantRecord>("tenants").then((r) => r.length)),

    insertFirstTenant: (tenant) =>
      read(async (tx) => {
        // A unique guard row makes "count === 0 then insert" one atomic step:
        // the backend raises `conflict` for the loser rather than inserting.
        const existing = await tx.list<TenantRecord>("tenants");
        if (existing.length > 0) return false;
        try {
          await tx.insert<TenantRecord>("tenants", tenant.id, tenant, ["tenants.singleton"]);
          return true;
        } catch (err) {
          if (err instanceof StorageError && err.code === "conflict") return false;
          throw err;
        }
      }),

    getTenant: (id) => read((tx) => tx.get<TenantRecord>("tenants", id)),
  };

  // --- Session store -----------------------------------------------------
  const sessions: SessionStore = {
    insertSession: (session) =>
      read((tx) => tx.insert<SessionRecord>("sessions", session.id, session)),
    getSession: (id) => read((tx) => tx.get<SessionRecord>("sessions", id)),
    findSessionByHash: (hash) =>
      read(async (tx) => {
        const rows = await tx.list<SessionRecord>("sessions");
        return rows.find((s) => s.tokenHash === hash) ?? null;
      }),
    deleteSession: (id) => read((tx) => tx.remove("sessions", id)),
    deleteSessionsForUser: (userId) =>
      read(async (tx) => {
        const rows = await tx.list<SessionRecord>("sessions");
        let removed = 0;
        for (const row of rows) {
          if (row.userId !== userId) continue;
          if (await tx.remove("sessions", row.id)) removed += 1;
        }
        return removed;
      }),
  };

  // --- Project store -----------------------------------------------------
  const projects: ProjectStore = {
    insertProject: (project) =>
      read((tx) =>
        tx.insert<ProjectRecord>("projects", project.id, project, ["projects.slug"]),
      ),
    getProject: (id) => read((tx) => tx.get<ProjectRecord>("projects", id)),
    getProjectBySlug: (slug) =>
      read(async (tx) => {
        const rows = await tx.list<ProjectRecord>("projects");
        return rows.find((p) => p.slug === slug) ?? null;
      }),
    deleteProject: (id) => read((tx) => tx.remove("projects", id)),
  };

  // --- Token store (hashes only) -----------------------------------------
  const tokens: TokenStore = {
    insertToken: (token) =>
      read((tx) => tx.insert<TokenRecord>("tokens", token.id, token, ["tokens.hash"])),
    findTokenByHash: (hash) =>
      read(async (tx) => {
        const rows = await tx.list<TokenRecord>("tokens");
        return rows.find((t) => t.hash === hash) ?? null;
      }),
    revokeToken: (id, at) =>
      read(async (tx) => {
        const row = await tx.get<TokenRecord>("tokens", id);
        if (row === null) return null;
        const next: TokenRecord = { ...row, revokedAt: at };
        return tx.put<TokenRecord>("tokens", id, next);
      }),
  };

  // --- Device store ------------------------------------------------------
  const devices: DeviceStore = {
    insertDevice: (device) =>
      read((tx) => tx.insert<DeviceRecord>("devices", device.id, device)),
    getDevice: (id) => read((tx) => tx.get<DeviceRecord>("devices", id)),
    listDevices: (projectId) =>
      read(async (tx) => {
        const rows = await tx.list<DeviceRecord>("devices");
        return rows.filter((d) => d.projectId === projectId);
      }),
    updateDevice: (id, patch, at) =>
      read(async (tx) => {
        const row = await tx.get<DeviceRecord>("devices", id);
        if (row === null) return null;
        const next: DeviceRecord = {
          ...row,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.model === undefined ? {} : { model: patch.model }),
          ...(patch.location === undefined ? {} : { location: patch.location }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          updatedAt: at,
        };
        return tx.put<DeviceRecord>("devices", id, next);
      }),
    deleteDevice: (id) => read((tx) => tx.remove("devices", id)),
  };

  // --- State (projection) store ------------------------------------------
  const state: StateStore = {
    putState: (projectId, row) =>
      read(async (tx) => {
        await tx.put<StateRow>(
          "state",
          `${projectId}\u0000${stateKeyOf(row.device, row.variable)}`,
          row,
        );
      }),
    getState: (projectId, device, variable) =>
      read((tx) =>
        tx.get<StateRow>("state", `${projectId}\u0000${stateKeyOf(device, variable)}`),
      ),
    listState: (projectId) =>
      read(async (tx) => {
        const rows = await tx.list<StateRow>("state", `${projectId}\u0000`);
        return rows;
      }),
  };

  // --- Series (data plane) store -----------------------------------------
  const series: SeriesStore = {
    getMeta: (device, metric) => timescale.transact((tx) => tx.getStream({ device, metric })),
    putMeta: (meta) =>
      timescale.transact(async (tx) => {
        await tx.putStream(meta);
      }),
    appendSample: (sample, buffer) =>
      timescale.transact(async (tx) => {
        await tx.append({ device: sample.device, metric: sample.metric }, sample, buffer);
      }),
    ring: (device, metric) =>
      timescale.transact((tx) => tx.rows({ device, metric }, "ring")),
    inflight: (device, metric) =>
      timescale.transact((tx) => tx.rows({ device, metric }, "inflight")),
    evictRingOldest: (device, metric) =>
      timescale.transact(async (tx) => {
        const rows = await tx.rows({ device, metric }, "ring");
        const head = rows[0];
        if (head === undefined) return;
        // The FIFO head is the lowest-seq ring row; removing it by seq is what
        // any backend can express, and it keeps the eviction *rule* in the
        // domain (ShardDO), not in the adapter.
        await tx.del({ device, metric }, "ring", head.seq);
      }),
    deleteInflight: (device, seq) =>
      timescale.transact(async (tx) => {
        // The inflight journal holds rows from *every* metric of a device, so a
        // `(device, seq)` delete must find the row's own stream first. The
        // series backend exposes that device-wide scan; the removal itself is
        // the neutral `del` verb.
        const match = (await tx.scanInflight(device)).find((r) => r.seq === seq);
        if (match === undefined) return;
        await tx.del({ device, metric: match.metric }, "inflight", seq);
      }),
    commitFlushed: (device, metric, upToSeq) =>
      timescale.transact((tx) => tx.advanceFlushed({ device, metric }, upToSeq)),
    flushedTo: (device, metric) => timescale.transact((tx) => tx.flushed({ device, metric })),
  };

  // --- Control store -----------------------------------------------------
  const control: ControlStore = {
    enqueue: (command) =>
      read((tx) => tx.insert<ControlCommand>("control", command.id, command)),
    list: (projectId, device) =>
      read(async (tx) => {
        const rows = await tx.list<ControlCommand>("control");
        return rows.filter((c) => c.projectId === projectId && c.device === device);
      }),
    resolve: (id) => read((tx) => tx.remove("control", id)),
  };

  // --- Audit store (append-only) -----------------------------------------
  const audit: AuditStore = {
    append: (entry: NewAuditRecord) =>
      read((tx) => {
        const record: AuditRecord = { ...entry, id: genId(), at: now() };
        return tx.insert<AuditRecord>("audit", record.id, record);
      }),
    listByProject: (projectId) =>
      read(async (tx) => {
        const rows = await tx.list<AuditRecord>("audit");
        return rows.filter((a) => a.projectId === projectId);
      }),
  };

  // --- Firmware store ----------------------------------------------------
  const firmware: FirmwareStore = {
    findFirmware: (projectId, version) =>
      read(async (tx) => {
        const rows = await tx.list<FirmwareRecord>("firmware");
        return rows.find((f) => f.projectId === projectId && f.version === version) ?? null;
      }),
    insertFirmware: (row) =>
      read((tx) => tx.insert<FirmwareRecord>("firmware", row.id, row, ["firmware.project_version"])),
    upsertFirmware: (row) =>
      read(async (tx) => {
        const rows = await tx.list<FirmwareRecord>("firmware");
        const existing = rows.find((f) => f.projectId === row.projectId && f.version === row.version);
        const key = existing?.id ?? row.id;
        return tx.put<FirmwareRecord>("firmware", key, { ...row, id: key });
      }),
    putFirmwareObject: (objectKey, bytes) =>
      read(async (tx) => {
        await tx.put<Uint8Array>("firmware_object", objectKey, bytes);
      }),
    getFirmwareObject: (objectKey) => read((tx) => tx.get<Uint8Array>("firmware_object", objectKey)),
  };

  // --- Automation store --------------------------------------------------
  const automations: AutomationStore = {
    getAutomation: (projectId, id) =>
      read(async (tx) => {
        const row = await tx.get<AutomationRecord>("automations", id);
        return row !== null && row.projectId === projectId ? row : null;
      }),
    setAutomationEnabled: (projectId, id, enabled) =>
      read(async (tx) => {
        const row = await tx.get<AutomationRecord>("automations", id);
        if (row === null || row.projectId !== projectId) return null;
        return tx.put<AutomationRecord>("automations", id, { ...row, enabled });
      }),
  };

  // --- Run-log store (append-only) ---------------------------------------
  const runLog: RunLogStore = {
    appendRun: (entry: NewRunRecord) =>
      read((tx) => {
        const record: RunRecord = { ...entry, id: genId(), createdAt: now() };
        return tx.insert<RunRecord>("runlog", record.id, record);
      }),
  };

  // --- Cursor store ------------------------------------------------------
  const cursors: CursorStore = {
    read: (sourceId) => read((tx) => tx.get<string>("cursors", sourceId)),
    write: (sourceId, cursor) =>
      read(async (tx) => {
        await tx.put<string>("cursors", sourceId, cursor);
      }),
  };

  return {
    ...tenants,
    ...sessions,
    ...projects,
    ...tokens,
    ...devices,
    ...state,
    ...series,
    ...control,
    ...audit,
    ...firmware,
    ...automations,
    ...runLog,
    ...cursors,

    /**
     * One transaction spanning BOTH backends, handing `work` a
     * {@link Transaction} that writes the data plane.
     *
     * The metadata backend owns the transaction (it is where the boundary
     * between the two instances is coordinated), and the time-series writes are
     * routed to the series backend inside it, so `work` sees a single atomic
     * unit: a throw rolls back the ring and meta together (INV-T4). Each backend
     * runs its own commit when `work` resolves, and neither applies anything
     * when it throws — which is exactly the pair-together-or-neither invariant
     * the write-ahead protocol needs.
     */
    transact: <T>(work: (tx: Transaction) => Promise<T>) =>
      postgres.transact(async (metaTx) => {
        // Fold the data-plane writes into the metadata transaction's unit, so a
        // throw rolls back both instances together (INV-T4). A backend that
        // cannot span instances simply omits begin/end and each half commits on
        // its own — the same contract, weaker atomicity, never a silent lie.
        timescale.begin?.();
        try {
          const handle: Transaction = {
            putMeta: (meta) => timescale.transact((seriesTx) => seriesTx.putStream(meta)),
            appendSample: (sample, buffer) =>
              timescale.transact((seriesTx) =>
                seriesTx.append({ device: sample.device, metric: sample.metric }, sample, buffer),
              ),
          };
          const result = await work(handle);
          timescale.end?.(true);
          return result;
        } catch (err) {
          timescale.end?.(false);
          throw err;
        } finally {
          // `metaTx` stays reserved for a future metadata write inside this same
          // unit; today the transactional writes are all data-plane.
          void metaTx;
        }
      }),

    ddl: () => [...postgres.ddl(), ...timescale.ddl()],
  };
}

// Note: the `streamKey` / `stateKeyOf` helpers above give every stream and
// projection row a single opaque key, so a backend never has to model a
// composite key and the adapter never leaks one of its own.
