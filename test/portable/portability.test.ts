/**
 * test/portable/portability.test.ts — the **portability harness** (A32,
 * NFR-CMP-02/03).
 *
 * ## What this suite proves
 *
 * The worker is written against the seam in
 * `worker/src/deploy/portable/storage-interface.ts`. This harness runs **one
 * conformance suite** against that seam over a **portable adapter**
 * (`worker/src/deploy/portable/adapter.ts`) built from in-memory fakes shaped
 * like a Postgres/Timescale self-host deploy. Pass it and the worker is not
 * bound to a specific backend — which is the whole claim of NFR-CMP-02.
 *
 * The fakes are *two independent backends* on purpose, mirroring the two halves
 * of a real self-host deploy (a relational metadata instance + a time-series
 * instance):
 *
 *   * {@link FakePostgresBackend} — the metadata half: maps with keys, the
 *     UNIQUE constraints the adapter relies on (a token hash, a project slug, a
 *     `(project, version)` pair, the single-tenant guard), and a real
 *     **snapshot/restore** transaction so rollback is genuinely exercised;
 *   * {@link FakeTimescaleBackend} — the data-plane half: append-only sample
 *     buffers with per-buffer sequence ordering and a monotonic flush
 *     high-water mark. It defers to an enclosing metadata unit when one is open,
 *     so {@link Storage.transact} is atomic across both fakes.
 *
 * The same adapter serves every case below, so the harness is testing the
 * *contract*, not one implementation's quirks.
 *
 * ## The credential scan
 *
 * A self-host deploy must run with **no third-party secret** (NFR-CMP-03). The
 * final `describe` reuses the A35 scanner (`scanForHardcodedSecrets`, the same
 * guard that protects the whole tree) over the two new files, with a planted
 * marker as a positive control so a green scan cannot be vacuous.
 */

import { describe, expect, it } from "vitest";
import {
  StorageError,
  type AuditRecord,
  type AutomationRecord,
  type DeviceRecord,
  type FirmwareRecord,
  type ProjectRecord,
  type RunRecord,
  type Sample,
  type SampleBuffer,
  type SessionRecord,
  type StateRow,
  type Storage,
  type StreamMeta,
  type TenantRecord,
  type TokenRecord,
} from "../../worker/src/deploy/portable/storage-interface";
import {
  createPortableStorage,
  type BackendTx,
  type Collection,
  type PostgresBackend,
  type PortableStorage,
  type StreamRef,
  type TimescaleBackend,
} from "../../worker/src/deploy/portable/adapter";
import { scanForHardcodedSecrets, type ScannableFile } from "../../worker/src/platform/config/secrets";
import { dirOf, filePathFromUrl, joinPath, readTextFileSync } from "../config/node-fs";

// ---------------------------------------------------------------------------
// A predictable id / clock seam (no `crypto`, no wall clock in assertions).
// ---------------------------------------------------------------------------

/** Sequential ids: `id-1`, `id-2`, … so store-assigned ids are assertable. */
function counterIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n}`;
  };
}

/** A frozen, strictly-increasing clock (1_000, 1_001, …). */
function steppingClock(): () => number {
  let t = 1_000;
  return () => {
    t += 1;
    return t;
  };
}

// ---------------------------------------------------------------------------
// Metadata backend fake (Postgres/Timescale shaped)
// ---------------------------------------------------------------------------

/** The unique value(s) a row contributes, as `kind:value` strings. */
function uniqueValuesOf(collection: Collection, row: unknown): string[] {
  switch (collection) {
    case "projects":
      return [`slug:${(row as ProjectRecord).slug}`];
    case "tokens":
      return [`hash:${(row as TokenRecord).hash}`];
    case "firmware": {
      const f = row as FirmwareRecord;
      return [`pv:${f.projectId}\u0000${f.version}`];
    }
    default:
      return [];
  }
}

/** Every `kind:value` unique token currently occupied in a collection. */
function occupiedUniqueValues(
  collection: Collection,
  rows: Iterable<unknown>,
): Set<string> {
  const occupied = new Set<string>();
  for (const row of rows) for (const value of uniqueValuesOf(collection, row)) occupied.add(value);
  return occupied;
}

/**
 * In-memory metadata backend: a `Map<collection, Map<key, row>>` with the
 * unique constraints above and a snapshot-based transaction.
 *
 * `work` runs against a {@link Snapshot} copy of the maps; on success the copy
 * becomes the live state, on throw the live state is untouched. That is a real
 * rollback — a caller that appends a sample then throws observes neither write.
 */
class FakePostgresBackend implements PostgresBackend {
  /** Live state: one map per collection. */
  readonly #data = new Map<Collection, Map<string, unknown>>();

  /**
   * Serializes transactions so concurrent callers interleave honestly: each
   * `transact` awaits a microtask turn *before* taking the write lock, exactly
   * like a real pool handing out one connection.
   */
  #lock: Promise<unknown> = Promise.resolve();

  ddl(): readonly string[] {
    return [
      "CREATE TABLE IF NOT EXISTS tenants (id text PRIMARY KEY, email text NOT NULL)",
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_slug ON projects (slug)",
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_tokens_hash ON tokens (hash)",
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_firmware_project_version ON firmware (project_id, version)",
    ];
  }

  async transact<T>(work: (tx: BackendTx) => Promise<T>): Promise<T> {
    // Yield before acquiring the lock so N concurrent calls really interleave.
    await Promise.resolve();
    const run = this.#lock.then(() => this.#runTransaction(work));
    this.#lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #runTransaction<T>(work: (tx: BackendTx) => Promise<T>): Promise<T> {
    const snapshot = new Snapshot(this.#data);
    const result = await work(snapshot);
    // Commit: the snapshot's maps become live only now.
    this.#data.clear();
    for (const [collection, rows] of snapshot.data) this.#data.set(collection, rows);
    return result;
  }

  /**
   * Test-only seam: seed an automation row directly.
   *
   * A deploy writes automations through its own admin API, not through
   * {@link Storage} (which only *reads* them back), so the fake exposes this
   * one helper rather than widening the conformance seam.
   */
  async seedAutomation(row: AutomationRecord): Promise<void> {
    await this.transact(async (tx) => {
      await tx.insert("automations", row.id, row);
    });
  }
}

/** A transactional view over a copy of the backend's state. */
class Snapshot implements BackendTx {
  readonly data: Map<Collection, Map<string, unknown>>;

  constructor(source: Map<Collection, Map<string, unknown>>) {
    this.data = new Map();
    for (const [collection, rows] of source) this.data.set(collection, new Map(rows));
  }

  #rows(collection: Collection): Map<string, unknown> {
    let rows = this.data.get(collection);
    if (rows === undefined) {
      rows = new Map();
      this.data.set(collection, rows);
    }
    return rows;
  }

  /** A globally-unique key per collection, so `id` values may repeat across tables. */
  #key(collection: Collection, key: string): string {
    return `${collection}\u0000${key}`;
  }

  async get<T>(collection: Collection, key: string): Promise<T | null> {
    const row = this.#rows(collection).get(this.#key(collection, key));
    return row === undefined ? null : (row as T);
  }

  async put<T>(collection: Collection, key: string, row: T): Promise<T> {
    this.#rows(collection).set(this.#key(collection, key), row);
    return row;
  }

  async insert<T>(
    collection: Collection,
    key: string,
    row: T,
    uniqueKeys: readonly string[] = [],
  ): Promise<T> {
    if (this.#rows(collection).has(this.#key(collection, key))) {
      throw new StorageError("conflict", `${collection}: duplicate key ${key}`);
    }
    // The single-tenant guard: the adapter names it explicitly, and the guard is
    // global (one tenant for the whole instance), so it is checked separately.
    if (uniqueKeys.includes("tenants.singleton") && this.#rows(collection).size > 0) {
      throw new StorageError("conflict", `${collection}: instance already claimed`);
    }
    // Enforce the collection's declared unique indexes (token hash, project
    // slug, `(project, version)`), exactly as the schema's UNIQUE constraints
    // would — a read-then-write race is what the contract forbids.
    const occupied = occupiedUniqueValues(collection, this.#rows(collection).values());
    for (const value of uniqueValuesOf(collection, row)) {
      if (occupied.has(value)) {
        throw new StorageError("conflict", `${collection}: duplicate ${value}`);
      }
    }
    this.#rows(collection).set(this.#key(collection, key), row);
    return row;
  }

  async list<T>(collection: Collection, prefix = ""): Promise<readonly T[]> {
    const rows: T[] = [];
    const namespaced = this.#key(collection, prefix);
    for (const [key, row] of this.#rows(collection)) {
      if (key.startsWith(namespaced)) rows.push(row as T);
    }
    return rows;
  }

  async remove(collection: Collection, key: string): Promise<boolean> {
    return this.#rows(collection).delete(this.#key(collection, key));
  }

  async transaction<T>(work: (tx: BackendTx) => Promise<T>): Promise<T> {
    // A nested transaction reuses this snapshot (savepoints keep it atomic).
    return work(this);
  }

  // --- Time-series surface (unused by the metadata half) ------------------
  async getStream(): Promise<StreamMeta | null> {
    return null;
  }
  async putStream(): Promise<void> {}
  async append(): Promise<void> {}
  async del(): Promise<void> {}
  async rows(): Promise<readonly Sample[]> {
    return [];
  }
  async scanInflight(): Promise<readonly Sample[]> {
    return [];
  }
  async flushed(): Promise<number> {
    return 0;
  }
  async advanceFlushed(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Time-series backend fake (Timescale shaped)
// ---------------------------------------------------------------------------

/** One stream's append-only buffers plus its flush high-water mark. */
interface StreamState {
  meta: StreamMeta | null;
  ring: Map<number, Sample>;
  inflight: Map<number, Sample>;
  flushed: number;
}

/**
 * In-memory time-series backend: per-stream append-only buffers keyed by `seq`
 * with ascending iteration, plus a monotonic flush mark. The transaction is a
 * deep snapshot so a rolled-back append leaves the ring exactly as it was.
 *
 * When this backend is entered *from inside* a metadata transaction
 * ({@link Storage.transact}), the outer unit owns the commit: {@link #ambient}
 * carries the open snapshot down so the inner call writes into it, and the ring
 * is committed or rolled back together with the metadata half. That is how a
 * fake with two independent instances still models one cross-backend unit.
 */
class FakeTimescaleBackend implements TimescaleBackend {
  readonly #streams = new Map<string, StreamState>();
  #lock: Promise<unknown> = Promise.resolve();
  /** The snapshot of an enclosing metadata transaction, when one is open. */
  #ambient: SeriesSnapshot | null = null;

  ddl(): readonly string[] {
    return [
      "CREATE TABLE IF NOT EXISTS samples (device text, metric text, ts bigint, seq bigint, value double precision, recorded_at bigint)",
      "SELECT create_hypertable('samples', 'ts', if_not_exists => TRUE)",
      "CREATE INDEX IF NOT EXISTS idx_samples_stream ON samples (device, metric, seq)",
    ];
  }

  /** Begin the outer unit: subsequent `transact` calls fold into it. */
  begin(): void {
    if (this.#ambient === null) this.#ambient = new SeriesSnapshot(this.#streams);
  }

  /** Commit or roll back the unit opened by {@link begin}. */
  end(commit: boolean): void {
    const ambient = this.#ambient;
    this.#ambient = null;
    if (ambient === null || !commit) return;
    this.#streams.clear();
    for (const [key, state] of ambient.streams) this.#streams.set(key, state);
  }

  async transact<T>(work: (tx: BackendTx) => Promise<T>): Promise<T> {
    // Inside an enclosing unit, the same snapshot is reused (not committed yet).
    if (this.#ambient !== null) return work(this.#ambient);

    await Promise.resolve();
    const run = this.#lock.then(() => this.#run(work));
    this.#lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #run<T>(work: (tx: BackendTx) => Promise<T>): Promise<T> {
    const snapshot = new SeriesSnapshot(this.#streams);
    const result = await work(snapshot);
    this.#streams.clear();
    for (const [key, state] of snapshot.streams) this.#streams.set(key, state);
    return result;
  }
}

/** A transactional view over a deep copy of the series state. */
class SeriesSnapshot implements BackendTx {
  readonly streams = new Map<string, StreamState>();

  constructor(source: Map<string, StreamState>) {
    for (const [key, state] of source) {
      this.streams.set(key, {
        meta: state.meta,
        ring: new Map(state.ring),
        inflight: new Map(state.inflight),
        flushed: state.flushed,
      });
    }
  }
  #stream(ref: StreamRef): StreamState {
    const key = `${ref.device}\u0000${ref.metric}`;
    let state = this.streams.get(key);
    if (state === undefined) {
      state = { meta: null, ring: new Map(), inflight: new Map(), flushed: 0 };
      this.streams.set(key, state);
    }
    return state;
  }

  async getStream(ref: StreamRef): Promise<StreamMeta | null> {
    return this.#stream(ref).meta;
  }

  async putStream(meta: StreamMeta): Promise<void> {
    this.#stream({ device: meta.device, metric: meta.metric }).meta = meta;
  }

  async append(ref: StreamRef, sample: Sample, buffer: SampleBuffer): Promise<void> {
    this.#stream(ref)[buffer].set(sample.seq, sample);
  }

  async del(ref: StreamRef, buffer: SampleBuffer, seq: number): Promise<void> {
    this.#stream(ref)[buffer].delete(seq);
  }

  async rows(ref: StreamRef, buffer: SampleBuffer): Promise<readonly Sample[]> {
    return [...this.#stream(ref)[buffer].values()].sort((a, b) => a.seq - b.seq);
  }

  async scanInflight(device: string): Promise<readonly Sample[]> {
    const rows: Sample[] = [];
    for (const [key, state] of this.streams) {
      if (!key.startsWith(`${device}\u0000`)) continue;
      rows.push(...state.inflight.values());
    }
    return rows;
  }

  async flushed(ref: StreamRef): Promise<number> {
    return this.#stream(ref).flushed;
  }

  async advanceFlushed(ref: StreamRef, upToSeq: number): Promise<void> {
    const state = this.#stream(ref);
    if (upToSeq > state.flushed) state.flushed = upToSeq;
  }

  // --- Metadata surface (unused by the series half) -----------------------
  async get<T>(): Promise<T | null> {
    return null;
  }
  async put<T>(_c: Collection, _k: string, row: T): Promise<T> {
    return row;
  }
  async insert<T>(_c: Collection, _k: string, row: T): Promise<T> {
    return row;
  }
  async list<T>(): Promise<readonly T[]> {
    return [];
  }
  async remove(): Promise<boolean> {
    return false;
  }
  async transaction<T>(work: (tx: BackendTx) => Promise<T>): Promise<T> {
    return work(this);
  }
}

// ---------------------------------------------------------------------------
// The adapter under test — ONE construction for every conformance case.
// ---------------------------------------------------------------------------

/**
 * Build the portable adapter over fresh fake backends.
 *
 * Returns the backend too, so a test can seed the one collection the seam only
 * *reads* (automations) without widening {@link Storage}.
 */
function newStorage(): { storage: PortableStorage; postgres: FakePostgresBackend } {
  const postgres = new FakePostgresBackend();
  const storage = createPortableStorage({
    postgres,
    timescale: new FakeTimescaleBackend(),
    genId: counterIds(),
    now: steppingClock(),
  });
  return { storage, postgres };
}

// ---------------------------------------------------------------------------
// Fixtures (deterministic, tenant-scoped)
// ---------------------------------------------------------------------------

const NOW = 5_000;

function tenant(id: string, email: string): TenantRecord {
  return { id, email, name: email.split("@")[0], createdAt: NOW };
}

function session(id: string, userId: string, hash: string, expiresAt = NOW + 60_000): SessionRecord {
  return { id, userId, tokenHash: hash, expiresAt, createdAt: NOW };
}

function project(id: string, slug: string, ownerId: string): ProjectRecord {
  return { id, name: slug, slug, ownerId, createdAt: NOW, updatedAt: NOW };
}

function token(id: string, ownerId: string, hash: string): TokenRecord {
  return {
    id,
    kind: "project",
    ownerId,
    hash,
    prefix: "pt_00",
    scopes: "read write",
    expiresAt: null,
    revokedAt: null,
    createdAt: NOW,
  };
}

function device(id: string, projectId: string, key: string): DeviceRecord {
  return {
    id,
    projectId,
    key,
    name: key,
    model: null,
    location: null,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function stateRow(deviceId: string, variable: string, value: number, seq: number): StateRow {
  return { device: deviceId, variable, value, ts: NOW, seq };
}

function sample(deviceId: string, metric: string, seq: number, value: number) {
  return { device: deviceId, metric, value, ts: NOW + seq, seq, recordedAt: NOW };
}

function firmware(id: string, projectId: string, version: string): FirmwareRecord {
  return {
    id,
    projectId,
    version,
    size: 3,
    sha256: "a".repeat(64),
    objectKey: `firmware/${projectId}/${version}.bin`,
    createdAt: NOW,
  };
}

// ---------------------------------------------------------------------------
// The conformance suite — every case runs against the SAME seam type.
// ---------------------------------------------------------------------------

describe("portable storage conformance — the seam is backend-independent", () => {
  it("bootstraps exactly one tenant under concurrency (atomic single-writer)", async () => {
    const { storage: seam } = newStorage();
    const storage: Storage = seam;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        storage.insertFirstTenant(tenant(`t${i}`, `owner${i}@example.com`)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await storage.countTenants()).toBe(1);
  });

  it("stores tenants, projects, sessions and tokens (hash-only reads)", async () => {
    const { storage } = newStorage();
    expect(await storage.insertFirstTenant(tenant("t1", "owner@example.com"))).toBe(true);
    await storage.insertProject(project("p1", "greenhouse", "t1"));
    await storage.insertSession(session("s1", "t1", "sha256:session-a"));
    await storage.insertToken(token("tok1", "p1", "sha256:token-a"));

    expect((await storage.getTenant("t1"))?.email).toBe("owner@example.com");
    expect((await storage.getProjectBySlug("greenhouse"))?.id).toBe("p1");
    expect((await storage.findSessionByHash("sha256:session-a"))?.id).toBe("s1");
    expect((await storage.findTokenByHash("sha256:token-a"))?.id).toBe("tok1");
  });

  it("refuses a duplicate token hash with a neutral `conflict`", async () => {
    const { storage } = newStorage();
    await storage.insertToken(token("tok1", "p1", "sha256:dup"));
    const clash = storage.insertToken(token("tok2", "p1", "sha256:dup"));
    await expect(clash).rejects.toBeInstanceOf(StorageError);
  });

  it("revokes a token durably and idempotently", async () => {
    const { storage } = newStorage();
    await storage.insertToken(token("tok1", "p1", "sha256:r"));
    const first = await storage.revokeToken("tok1", NOW + 10);
    expect(first?.revokedAt).toBe(NOW + 10);
    const second = await storage.revokeToken("tok1", NOW + 20);
    expect(second?.revokedAt).toBe(NOW + 20);
    expect(await storage.revokeToken("missing", NOW)).toBeNull();
  });

  it("scopes device listings to their tenant (never crosses projects)", async () => {
    const { storage } = newStorage();
    await storage.insertDevice(device("d1", "p1", "north"));
    await storage.insertDevice(device("d2", "p1", "south"));
    await storage.insertDevice(device("d3", "p2", "east"));

    expect((await storage.listDevices("p1")).map((d) => d.key)).toEqual(["north", "south"]);
    expect((await storage.listDevices("p2")).map((d) => d.key)).toEqual(["east"]);
    expect(await storage.getDevice("d3")).not.toBeNull();
  });

  it("applies a device patch atomically and stamps updatedAt from the caller", async () => {
    const { storage } = newStorage();
    await storage.insertDevice(device("d1", "p1", "north"));
    const patched = await storage.updateDevice("d1", { status: "retired", location: "roof" }, NOW + 5);
    expect(patched).toMatchObject({ status: "retired", location: "roof", updatedAt: NOW + 5 });
    expect(await storage.updateDevice("missing", { status: "active" }, NOW)).toBeNull();
  });

  it("round-trips the projection store, keyed by (project, device, variable)", async () => {
    const { storage } = newStorage();
    await storage.putState("p1", stateRow("d1", "temp", 21.5, 3));
    await storage.putState("p1", stateRow("d1", "humidity", 40, 1));
    await storage.putState("p2", stateRow("d1", "temp", -1, 9));

    expect(await storage.getState("p1", "d1", "temp")).toMatchObject({ value: 21.5, seq: 3 });
    expect(await storage.getState("p2", "d1", "temp")).toMatchObject({ value: -1, seq: 9 });
    expect(await storage.getState("p1", "d9", "temp")).toBeNull();
    expect((await storage.listState("p1")).map((r) => r.variable).sort()).toEqual([
      "humidity",
      "temp",
    ]);
  });

  it("keeps one stream's ring and inflight ordered by ascending seq", async () => {
    const { storage } = newStorage();
    await storage.appendSample(sample("d1", "temp", 2, 22), "ring");
    await storage.appendSample(sample("d1", "temp", 1, 21), "ring");
    await storage.appendSample(sample("d1", "temp", 1, 21), "inflight");

    expect((await storage.ring("d1", "temp")).map((s) => s.seq)).toEqual([1, 2]);
    expect((await storage.inflight("d1", "temp")).map((s) => s.seq)).toEqual([1]);
  });

  it("evicts the FIFO head and drains inflight rows (idempotent delete)", async () => {
    const { storage } = newStorage();
    await storage.appendSample(sample("d1", "temp", 1, 21), "ring");
    await storage.appendSample(sample("d1", "temp", 2, 22), "ring");
    await storage.evictRingOldest("d1", "temp");
    expect((await storage.ring("d1", "temp")).map((s) => s.seq)).toEqual([2]);

    await storage.appendSample(sample("d1", "temp", 1, 21), "inflight");
    await storage.appendSample(sample("d1", "temp", 2, 22), "inflight");
    await storage.deleteInflight("d1", 1);
    await storage.deleteInflight("d1", 1); // idempotent
    expect((await storage.inflight("d1", "temp")).map((s) => s.seq)).toEqual([2]);
  });

  it("advances the flush high-water mark monotonically and never backwards", async () => {
    const { storage } = newStorage();
    expect(await storage.flushedTo("d1", "temp")).toBe(0);
    await storage.commitFlushed("d1", "temp", 5);
    await storage.commitFlushed("d1", "temp", 3); // stale retry → ignored
    expect(await storage.flushedTo("d1", "temp")).toBe(5);
    await storage.commitFlushed("d1", "temp", 9);
    expect(await storage.flushedTo("d1", "temp")).toBe(9);
  });

  it("queues control commands per device and resolves them once", async () => {
    const { storage } = newStorage();
    await storage.enqueue({
      id: "c1",
      projectId: "p1",
      device: "d1",
      variable: "pump",
      value: 1,
      ttl: NOW + 100,
      createdAt: NOW,
    });
    await storage.enqueue({
      id: "c2",
      projectId: "p1",
      device: "d2",
      variable: "pump",
      value: 0,
      ttl: NOW + 100,
      createdAt: NOW,
    });
    expect((await storage.list("p1", "d1")).map((c) => c.id)).toEqual(["c1"]);
    expect(await storage.resolve("c1")).toBe(true);
    expect(await storage.resolve("c1")).toBe(false);
    expect(await storage.list("p1", "d1")).toHaveLength(0);
  });

  it("appends audit entries with store-assigned id + stamp, scoped by project", async () => {
    const { storage } = newStorage();
    const a = await storage.append({
      projectId: "p1",
      action: "token.created",
      category: "token",
      actorId: "u1",
      target: "tok1",
    });
    const b = await storage.append({
      projectId: "p2",
      action: "project.deleted",
      category: "settings",
      actorId: "u1",
      target: "p2",
    });
    expect(a.id).toBe("id-1");
    expect(b.id).toBe("id-2");
    expect(a.at).toBeLessThan(b.at); // stepping clock
    expect((await storage.listByProject("p1")).map((r: AuditRecord) => r.action)).toEqual([
      "token.created",
    ]);
  });

  it("stores firmware metadata and object bytes under a deterministic key", async () => {
    const { storage } = newStorage();
    const row = firmware("f1", "p1", "1.2.3");
    await storage.insertFirmware(row);
    await storage.putFirmwareObject(row.objectKey, new Uint8Array([1, 2, 3]));

    expect(await storage.findFirmware("p1", "1.2.3")).toMatchObject({ id: "f1", size: 3 });
    expect(Array.from((await storage.getFirmwareObject(row.objectKey)) ?? [])).toEqual([1, 2, 3]);
    expect(await storage.getFirmwareObject("firmware/nope.bin")).toBeNull();
    // A duplicate (project, version) is a `conflict`, not a silent overwrite.
    await expect(
      storage.insertFirmware(firmware("f2", "p1", "1.2.3")),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it("upserts a re-uploaded firmware version in place", async () => {
    const { storage } = newStorage();
    await storage.insertFirmware(firmware("f1", "p1", "1.2.3"));
    const replaced = await storage.upsertFirmware({ ...firmware("f9", "p1", "1.2.3"), size: 9 });
    expect(replaced.id).toBe("f1"); // same row, updated in place
    expect((await storage.findFirmware("p1", "1.2.3"))?.size).toBe(9);
  });

  it("reads automations only within their tenant and toggles the owner switch", async () => {
    const { storage, postgres } = newStorage();
    const rule: AutomationRecord = { id: "a1", projectId: "p1", rule: { cooldownMs: 0 }, enabled: true };
    await postgres.seedAutomation(rule);

    // Same id, wrong tenant → `null` (the tenant is part of the key, not a filter).
    expect(await storage.getAutomation("p2", "a1")).toBeNull();
    expect(await storage.getAutomation("p1", "a1")).toMatchObject({ enabled: true });

    const disabled = await storage.setAutomationEnabled("p1", "a1", false);
    expect(disabled).toMatchObject({ id: "a1", enabled: false });
    // A cross-tenant toggle changes nothing.
    expect(await storage.setAutomationEnabled("p2", "a1", true)).toBeNull();
    expect((await storage.getAutomation("p1", "a1"))?.enabled).toBe(false);
    expect(await storage.setAutomationEnabled("p1", "missing", false)).toBeNull();
  });

  it("appends run records with store-assigned id + stamp (append-only)", async () => {
    const { storage } = newStorage();
    const run = await storage.appendRun({
      projectId: "p1",
      automationId: "a1",
      actorId: "u1",
      trigger: "manual",
      report: { ok: true },
    });
    expect(run.id).toBe("id-1");
    expect(run.createdAt).toBeGreaterThan(0);
    expect((run as RunRecord).trigger).toBe("manual");
  });

  it("round-trips external-source cursors (last write wins)", async () => {
    const { storage } = newStorage();
    expect(await storage.read("src-1")).toBeNull();
    await storage.write("src-1", "1700000000");
    await storage.write("src-1", "1700003600");
    expect(await storage.read("src-1")).toBe("1700003600");
    expect(await storage.read("src-2")).toBeNull();
  });

  it("commits a transaction and rolls back both halves on throw (INV-T4)", async () => {
    const { storage } = newStorage();

    // A committed transaction writes the ring + meta together.
    await storage.transact(async (tx) => {
      await tx.putMeta({
        device: "d1",
        metric: "temp",
        latestTs: NOW,
        latestValue: 21,
        latestSeq: 1,
        nextSeq: 2,
        dropped: 0,
      });
      await tx.appendSample(sample("d1", "temp", 1, 21), "ring");
    });
    expect((await storage.ring("d1", "temp")).map((s) => s.seq)).toEqual([1]);
    expect((await storage.getMeta("d1", "temp"))?.nextSeq).toBe(2);

    // A transaction that throws must apply NOTHING — not even the sample that
    // was appended before the throw.
    await expect(
      storage.transact(async (tx) => {
        await tx.appendSample(sample("d1", "temp", 2, 22), "ring");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await storage.ring("d1", "temp")).map((s) => s.seq)).toEqual([1]);
  });

  it("exposes one ordered DDL for the whole deploy", async () => {
    const { storage } = newStorage();
    const ddl = storage.ddl();
    expect(ddl.length).toBeGreaterThan(0);
    expect(ddl.some((s) => /create_hypertable/i.test(s))).toBe(true);
    expect(ddl.some((s) => /create unique index/i.test(s))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Credential scan (NFR-CMP-03) — no hardcoded secret in the new files.
// ---------------------------------------------------------------------------

/**
 * The portable deploy adds exactly two source files; a self-host build must run
 * with no third-party secret in either (NFR-CMP-03). This reuses the A35 scanner
 * (`scanForHardcodedSecrets`, the same guard that protects the whole tree) over
 * just these two files, so the portability proof carries its own
 * no-credential check rather than relying on the tree-wide one being widened.
 */
const PORTABLE_FILES = [
  "worker/src/deploy/portable/storage-interface.ts",
  "worker/src/deploy/portable/adapter.ts",
] as const;

describe("the portable deploy files carry no hardcoded credential", () => {
  const here = dirOf(filePathFromUrl(import.meta.url)); // …/insight/test/portable
  const repoRoot = joinPath(here, "..", "..");

  it("scans clean and the scanner really can fire (self-check)", () => {
    const files: ScannableFile[] = PORTABLE_FILES.map((relative) => ({
      path: relative,
      content: readTextFileSync(joinPath(repoRoot, relative), "utf8"),
    }));

    // Guard against a silently-empty scan: both files must be non-trivial.
    expect(files.length).toBe(PORTABLE_FILES.length);
    for (const file of files) {
      expect(file.content.length).toBeGreaterThan(1_000);
    }

    // The scanner's own positive control: a planted well-known-format credential
    // (in an isolated pseudo-file, never the tree) MUST be found — otherwise a
    // green scan below would prove nothing.
    const control = scanForHardcodedSecrets([
      { path: "<planted>/leak.ts", content: 'const k = "@@PLANTED_STRIPE_CONTROL@@";\n' },
    ]);
    expect(control.length).toBeGreaterThan(0);

    const report = scanForHardcodedSecrets(files)
      .map((f) => `${f.path}:${f.line} [${f.rule}] ${f.preview}`)
      .join("\n");
    expect(report).toBe("");
  });
});
