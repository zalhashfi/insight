import { describe, expect, it } from "vitest";
import { Hono } from "hono";

// --- the REAL seams, wired through their existing exported entry points ------
import {
  DEVICE_HEADER,
  createTelemetryIngest,
  type TelemetryDeps,
  type VerifyToken,
} from "../../worker/src/domains/telemetry/telemetry";
import {
  InMemoryShardStorage,
  ShardDO,
} from "../../worker/src/platform/durable-objects/shard-do";
import {
  InMemoryProjectStorage,
  ProjectDO,
  type StateRow,
} from "../../worker/src/platform/durable-objects/project-do";
import {
  DashboardDO,
  type DashboardClient,
  type MetricPoint,
  type ProjectionSource,
} from "../../worker/src/platform/durable-objects/dashboard-do";
import {
  InMemoryR2,
  flushShard,
  type FlushedPoint,
} from "../../worker/src/domains/telemetry/flush";
import { reconcileProjection } from "../../worker/src/domains/telemetry/reconcile";
import { parseSql, type SqlStatement } from "../../worker/src/platform/db/sql-split";

// --- the FROZEN cross-repo contract lock (the tripwire we assert against) -----
import {
  CONTRACT_HEADERS,
  DEFAULT_DEVICE_KEY,
  ERROR_BODY_FIELDS,
  METRIC_FIELDS,
  POST_TELEMETRY,
  STATUS,
  TELEMETRY_OK_BODY_FIELDS,
  TELEMETRY_REQUEST_SHAPES,
} from "../contracts/contract-lock";

/**
 * E02 — end-to-end M1 vertical-slice evidence (device → cloud → dashboard →
 * analytics store) plus the NFR-PERF-03 / INV-T5 D1 audit.
 *
 * This is an INTEGRATION test: it wires the *real* committed seams together
 * in-process and drives one reading all the way through. Nothing here
 * re-implements a production unit or mocks the code under test — every seam is
 * a genuine module entry point, and the only substitutions are the documented,
 * injectable edges (a fake `fetchImpl`, in-memory storage, a recording socket).
 *
 * The slice under test, in order:
 *
 *   1. an iot-sim-shaped `POST /v1/telemetry` body `{"metrics":{"temp":25.4}}`
 *      is built and its request shape asserted against the frozen contract lock;
 *   2. that exact request is handed to the REAL ingest handler via a fake
 *      `fetchImpl` transport (no socket, no CF runtime);
 *   3. the ingest sink records the metric into a ShardDO (the hot write path),
 *      which is mirrored into a ProjectDO projection (the hot read model);
 *   4. the projected latest `temp` on the device is 25.4;
 *   5. a DashboardDO snapshot includes that point live;
 *   6. a two-phase flush with a fake `R2Like` writes the point to R2 as NDJSON;
 *   7. a reconcile run leaves the projection converged with the shard.
 *
 * Finally, the D1 catalog is parsed and asserted to contain NO telemetry
 * data-point table (NFR-PERF-03 / INV-T5): the metadata store must never hold
 * per-reading rows.
 */

// ---------------------------------------------------------------------------
// The M1 demo scenario — one device, one temperature reading.
// ---------------------------------------------------------------------------

const PROJECT = "proj_m1_demo";
const TOKEN = "pt_m1_demo_token";
const DEVICE = "sim-01";
const VARIABLE = "temp";
const TEMP = 25.4;

/** iot-sim's seed for the M1 demo reading `{"temp":25.4}` (see seededReading). */
const SEED = 24;
/** The 1-based reading index at which that seed reports temp = 25.4. */
const READING_INDEX = 17;
/** iot-sim rounds a reading to 2 decimals; mirror that exactly. */
const READING_DIGITS = 2;

// ---------------------------------------------------------------------------
// iot-sim request shape (device side)
// ---------------------------------------------------------------------------

/**
 * A request exactly as `insight-internal`'s iot-sim `buildPublishRequest`
 * produces it: a flat JSON body, the token in `authorization`, the device key
 * in the `x-insight-device` header, and (per spec §6.1) **no** device-supplied
 * timestamp. Constructed here so the insight-side slice can drive the same wire
 * shape without a cross-repo dependency.
 */
interface SimPublishRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly payload: { readonly metrics: Record<string, number> };
}

/** Build the sim's `POST /v1/telemetry` request for one metrics map. */
function simPublishRequest(
  baseUrl: string,
  projectToken: string,
  deviceKey: string,
  metrics: Record<string, number>,
): SimPublishRequest {
  const payload = { metrics };
  return {
    url: `${baseUrl.replace(/\/+$/, "")}${POST_TELEMETRY.path}`,
    method: POST_TELEMETRY.method,
    headers: {
      "content-type": "application/json",
      [CONTRACT_HEADERS.authorization]: `Bearer ${projectToken}`,
      [CONTRACT_HEADERS.device]: deviceKey,
    },
    body: JSON.stringify(payload),
    payload,
  };
}

/** Reconstruct the payload the way the ingest handler reads it (text → JSON). */
function decodeMetricsMap(request: SimPublishRequest): Record<string, unknown> {
  const parsed = JSON.parse(request.body) as { metrics: Record<string, unknown> };
  return parsed.metrics;
}

// ---------------------------------------------------------------------------
// Transport seam — turns the sim request into a Response via the REAL handler
// ---------------------------------------------------------------------------

/**
 * A `fetchImpl`-shaped transport: it takes the sim's built request, re-presents
 * it to a Hono app in-process, and returns the real `Response`. No network, no
 * Cloudflare runtime — only the handler under test.
 */
function fetchThrough(app: Hono): (request: SimPublishRequest) => Promise<Response> {
  return (request) =>
    Promise.resolve(
      app.request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }),
    );
}

// ---------------------------------------------------------------------------
// Harness — build the whole slice over the real seams.
// ---------------------------------------------------------------------------

/** One live frame the recording dashboard client received. */
interface Frame {
  readonly type: "snapshot" | "update";
  readonly points?: readonly MetricPoint[];
  readonly cursor?: number;
  readonly point?: MetricPoint;
}

/** A socket-like dashboard client that records every frame it is sent. */
class RecordingClient implements DashboardClient {
  readonly frames: Frame[] = [];
  bufferedAmount = 0;
  readonly closes: { code?: number; reason?: string }[] = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Frame);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  snapshotPoints(): readonly MetricPoint[] {
    const snapshots = this.frames.filter((f) => f.type === "snapshot");
    expect(snapshots).toHaveLength(1);
    return snapshots[0].points ?? [];
  }
}

/**
 * A {@link ProjectionSource} over the live ProjectDO: a bounded snapshot (the
 * projection's own newest-first order) plus the monotonic cursor (highest
 * projected seq). This is the one adapter the dashboard needs — the DO itself
 * is untouched.
 */
function projectionSourceOf(project: ProjectDO): ProjectionSource {
  const points = (): MetricPoint[] => {
    const rows: StateRow[] = [...project.getState()];
    return rows
      .map((r) => ({
        device: r.device,
        variable: r.variable,
        value: r.value,
        ts: r.ts,
        seq: r.seq,
      }))
      .sort((a, b) => b.ts - a.ts || b.seq - a.seq);
  };
  return {
    snapshot: (limit: number) => Promise.resolve(points().slice(0, limit)),
    cursor: () => Promise.resolve(project.getState().reduce((max, r) => Math.max(max, r.seq), 0)),
  };
}

/** The whole wired slice, exposed for the assertions. */
interface Slice {
  /** iot-sim-shaped request builder bound to this harness. */
  simRequest: (metrics: Record<string, number>) => SimPublishRequest;
  /** Send a sim request through the transport into the real ingest handler. */
  send: (request: SimPublishRequest) => Promise<Response>;
  shard: ShardDO;
  /** Project the shard's latest into the read model (the live push path). */
  pushLatest: (device?: string) => Promise<number>;
  project: ProjectDO;
  dashboard: DashboardDO;
  r2: InMemoryR2;
}

/**
 * Build every seam and close the loop between shard and projection: after an
 * ingest, {@link Slice.pushLatest} replays the shard's authoritative latest into
 * the ProjectDO via `receivePush` — the same receipt a real shard→project push
 * uses, so the projection is live, not vacuous.
 */
async function buildSlice(now: () => number): Promise<Slice> {
  const shard = new ShardDO({ storage: new InMemoryShardStorage(), now });
  await shard.init();

  const project = new ProjectDO({ storage: new InMemoryProjectStorage(), now });
  await project.init();

  const dashboard = new DashboardDO({ source: projectionSourceOf(project), now });

  // --- ingest deps: the real handler, a real ShardDO sink, fixed clock ------
  const verifyToken: VerifyToken = async (token) =>
    token === TOKEN ? { projectId: PROJECT } : null;

  const deps: TelemetryDeps = {
    verifyToken,
    now,
    // The A09 write path, adapted onto the route's one-call-per-metric sink.
    sink: {
      record: async (projectId, device, metric, value, ts) => {
        if (projectId !== PROJECT) throw new Error(`unexpected project ${projectId}`);
        const result = await shard.ingest({ device, metric, value, ts });
        if (!result.accepted) {
          throw new Error(`shard rejected sample at ts=${ts}: ${result.reason}`);
        }
      },
    },
    // Device registry: the shard has already seen the device (its sample
    // landed), so registration is a no-op that only needs to be idempotent.
    devices: {
      has: (projectId, device) => projectId === PROJECT && shard.getState(device).length > 0,
      register: () => undefined,
    },
  };

  const app = new Hono();
  app.route(POST_TELEMETRY.path, createTelemetryIngest(deps));
  const send = fetchThrough(app);

  // Close the shard → projection loop through `receivePush` (INV-T2 ordering).
  const pushLatest = async (device = DEVICE): Promise<number> => {
    let pushed = 0;
    for (const state of shard.getState(device)) {
      const result = await project.receivePush({
        device: state.device,
        variable: state.metric,
        value: state.value,
        ts: state.ts,
        seq: state.seq,
      });
      if (result.accepted) pushed += 1;
    }
    return pushed;
  };

  return {
    simRequest: (metrics) => simPublishRequest("http://collector.local", TOKEN, DEVICE, metrics),
    send,
    shard,
    pushLatest,
    project,
    dashboard,
    r2: new InMemoryR2(),
  };
}

// ---------------------------------------------------------------------------
// Deterministic iot-sim temperature source (matches the internal simulator).
// ---------------------------------------------------------------------------

const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;

/**
 * The deterministic `sim-01` temperature reading at `seed`, computed with the
 * EXACT algorithm the iot-sim temperature sensor uses: a mean-reverting random
 * walk (`initial=mean=25`, `min=15`, `max=35`, `step=0.15`, `reversion=0.3`,
 * 2-decimal quantisation) over iot-sim's 32-bit LCG. Reimplemented here — not
 * imported — because the simulator lives in the sibling `insight-internal`
 * repo; this pins the wire body the insight slice consumes without a
 * cross-repo dependency.
 *
 * `index` is the 1-based reading to return, so the slice can consume the same
 * running-simulator sequence iot-sim would emit: at ({@link SEED},
 * {@link READING_INDEX}) this yields the M1 demo value `25.4`.
 */
function seededReading(seed: number, index: number): { metrics: Record<string, number> } {
  let state = seed >>> 0;
  const rng = (): number => {
    state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    return state / 4294967296;
  };

  // iot-sim's temperature sensor: a mean-reverting step from `initial = 25`.
  const mean = 25;
  const min = 15;
  const max = 35;
  const stepSize = 0.15;
  const reversion = 0.3;
  const scale = 10 ** READING_DIGITS;

  let current = mean;
  for (let i = 0; i < index; i += 1) {
    const magnitude = stepSize * (0.5 + rng());
    const direction = rng() < 0.5 ? -1 : 1;
    const drift = (mean - current) * reversion;
    let candidate = current + direction * magnitude + drift;
    if (candidate > max) candidate = max - (candidate - max);
    if (candidate < min) candidate = min + (min - candidate);
    const quantized = Math.round(candidate * scale) / scale;
    if (quantized > min && quantized < max) current = quantized;
  }

  return { metrics: { [VARIABLE]: current } };
}

// ===========================================================================
// 1. The full slice, end-to-end.
// ===========================================================================
describe("M1 vertical slice — device → cloud → dashboard → R2", () => {
  it("projects a receipted temp=25.4 and returns 204 No Content", async () => {
    const slice = await buildSlice(() => 1_700_000_000_123);

    // --- (1) iot-sim builds the request: `{"metrics":{"temp":25.4}}` ---------
    // The metrics map is the iot-sim sensor's deterministic output at the M1
    // demo seed/index, so the whole slice is driven by the simulator's own
    // reading rather than a hand-written literal.
    const readings = seededReading(SEED, READING_INDEX);
    expect(readings).toEqual({ metrics: { [VARIABLE]: TEMP } });
    const request = slice.simRequest(readings.metrics);

    // The request shape is asserted against the FROZEN contract lock: method,
    // path, the two required headers, and the `metrics` object shape. Editing
    // a value in `contract-lock.ts` makes this block disagree with the sim's
    // unchanged wire form and FAILS — the tripwire.
    expect(request.method).toBe(POST_TELEMETRY.method);
    expect(request.url.endsWith(POST_TELEMETRY.path)).toBe(true);
    expect(POST_TELEMETRY.implemented).toBe(true);
    expect(POST_TELEMETRY.headers).toContain(CONTRACT_HEADERS.authorization);
    expect(POST_TELEMETRY.headers).toContain(CONTRACT_HEADERS.device);
    expect(Object.keys(request.headers)).toEqual(
      expect.arrayContaining([CONTRACT_HEADERS.authorization, CONTRACT_HEADERS.device]),
    );
    expect(request.headers[CONTRACT_HEADERS.device]).toBe(DEVICE);

    // The sim's header name is the SAME one the ingest route reads (its
    // `DEVICE_HEADER`), so the device identity cannot drift between the two
    // sides of the wire; and the route's own default fallback is the contract's
    // frozen default key.
    expect(DEVICE_HEADER).toBe(CONTRACT_HEADERS.device);
    expect(DEFAULT_DEVICE_KEY).toBe("unknown");

    // Body shape: `{ metrics: { <key>: <value> } }` (the `metricsMap` shape).
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["metrics"]);
    const metrics = decodeMetricsMap(request);
    expect(metrics).toEqual({ [VARIABLE]: TEMP });
    // No device-supplied timestamp — the server stamps time (spec §6.1).
    expect(body).not.toHaveProperty("ts");

    // The `metricsMap` shape is a live, frozen request shape.
    expect(TELEMETRY_REQUEST_SHAPES.metricsMap.implemented).toBe(true);
    // A single accepted metric entry is `{key, value}`; the flat map is the
    // equivalent encoding of exactly that pair.
    expect(METRIC_FIELDS).toEqual(["key", "value"]);

    // --- (2) the REAL ingest handler consumes the sim request ---------------
    const response = await slice.send(request);

    // --- (3) success is 204 with NO body (frozen: no success body fields) ---
    expect(response.status).toBe(POST_TELEMETRY.success);
    expect(response.status).toBe(STATUS.noContent);
    expect(TELEMETRY_OK_BODY_FIELDS).toHaveLength(0);
    expect(await response.text()).toBe("");

    // --- (4) the hot write path recorded it (server-stamped ts) -------------
    const shardState = slice.shard.getState(DEVICE, VARIABLE);
    expect(shardState).toHaveLength(1);
    expect(shardState[0]).toMatchObject({ device: DEVICE, metric: VARIABLE, value: TEMP, ts: 1_700_000_000_123 });

    // --- (5) the projection carries the latest temp = 25.4 ------------------
    const pushed = await slice.pushLatest();
    expect(pushed).toBe(1);
    const row = slice.project.getState(DEVICE, VARIABLE)[0];
    expect(row).toMatchObject({ device: DEVICE, variable: VARIABLE, value: TEMP });

    // --- (6) the LIVE dashboard snapshot includes that point ----------------
    const client = new RecordingClient();
    await slice.dashboard.subscribe(client);
    const points = client.snapshotPoints();
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ device: DEVICE, variable: VARIABLE, value: TEMP });
    // The client is primed live and healthy: exactly one snapshot frame, no
    // update frame (nothing published after it), and it was never closed.
    expect(client.frames.filter((f) => f.type === "update")).toHaveLength(0);
    expect(client.closes).toHaveLength(0);

    // --- (7) flush writes the point to R2 as NDJSON -------------------------
    const flush = await flushShard(slice.shard, slice.r2, { device: DEVICE });
    expect(flush.flushed).toBe(1);
    expect(flush.key).not.toBeNull();

    // --- (8) reconcile keeps the projection converged -----------------------
    const report = await reconcileProjection({ shard: slice.shard, project: slice.project });
    expect(report.replayed).toBe(0); // already converged: nothing to repair
    expect(report.converged).toBe(1);

    // A second reconcile is idempotent — still converged, still nothing replayed.
    const second = await reconcileProjection({ shard: slice.shard, project: slice.project });
    expect(second).toEqual({ scanned: 1, replayed: 0, converged: 1 });
  });

  it("emits the M1 demo reading 25.4 from the iot-sim seed (deterministic)", () => {
    // Pins the exact body the slice drives, so the scenario is reproducible.
    expect(seededReading(SEED, READING_INDEX)).toEqual({ metrics: { [VARIABLE]: TEMP } });
  });

  it("ingest is device-safe: a rejected token is 401, nothing persisted", async () => {
    const slice = await buildSlice(() => 1_700_000_000_123);
    const request = simPublishRequest("http://collector.local", "pt_wrong", DEVICE, {
      [VARIABLE]: TEMP,
    });

    const response = await slice.send(request);

    expect(response.status).toBe(STATUS.unauthorized);
    const body = (await response.json()) as Record<string, unknown>;
    // The rejection body is exactly `{ error, message }` — the frozen fields.
    expect(Object.keys(body).sort()).toEqual([...ERROR_BODY_FIELDS].sort());
    expect(body.error).toBe("unauthorized");
    // Nothing reached the shard: auth is checked before the body is parsed.
    expect(slice.shard.getState()).toHaveLength(0);
  });
});

// ===========================================================================
// 2. The telemetry point is present in the flushed R2 object (parsed NDJSON).
// ===========================================================================
describe("M1 slice — the point lands in the R2 NDJSON object", () => {
  it("contains temp=25.4 in the flushed object, one point per line", async () => {
    const slice = await buildSlice(() => 1_700_000_000_123);
    const request = slice.simRequest({ [VARIABLE]: TEMP });
    await slice.send(request);

    const flush = await flushShard(slice.shard, slice.r2, { device: DEVICE, strategy: "cas" });
    expect(flush.flushed).toBe(1);
    expect(flush.alreadyDelivered).toBe(false);

    // The object body is NDJSON: parse every non-empty line independently.
    const stored = slice.r2.get(flush.key as string);
    expect(stored).toBeDefined();
    const lines = (stored?.body ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);

    const point = JSON.parse(lines[0]) as FlushedPoint;
    expect(point.device).toBe(DEVICE);
    expect(point.metric).toBe(VARIABLE);
    expect(point.value).toBe(TEMP);
    // The reader's view agrees — and finds exactly one such point.
    const matching = slice.r2.points().filter((p) => p.metric === VARIABLE && p.value === TEMP);
    expect(matching).toHaveLength(1);

    // The journal is drained: the point is delivered once, and cannot be re-emitted.
    expect(await slice.shard.pending(DEVICE)).toHaveLength(0);
  });

  it("the flushing device key used the contract's device identity", async () => {
    const slice = await buildSlice(() => 1_700_000_000_123);
    const request = slice.simRequest({ [VARIABLE]: TEMP });
    await slice.send(request);
    const flush = await flushShard(slice.shard, slice.r2, { device: DEVICE, strategy: "cas" });
    // Key is `<prefix>/<device>/<seq>.ndjson` — the device segment is the sim
    // identity, and under the CAS strategy the key is the deterministic window.
    expect(flush.key).toBe(`telemetry/${DEVICE}/0.ndjson`);
    expect(flush.key).toMatch(/\/0\.ndjson$/);
  });
});

// ===========================================================================
// 3. D1 audit — NFR-PERF-03 / INV-T5: NO telemetry data-point table.
// ===========================================================================

const SQL_PATH = new URL(
  "../../worker/src/platform/db/migrations/0001_init.sql",
  import.meta.url,
);

/**
 * Read a file in-process without Node type packages (the repo's `tsconfig`
 * pins `types` to Workers + vitest). Bun provides `Bun.file` at runtime; it is
 * reached through `globalThis` with a runtime guard so this file neither
 * redeclares the ambient `Bun` global (owned by `test/db/schema.test.ts`) nor
 * trusts an unchecked shape.
 */
async function readTextFile(path: URL): Promise<string> {
  const bun: unknown = (globalThis as Record<string, unknown>)["Bun"];
  if (
    bun !== null &&
    typeof bun === "object" &&
    "file" in bun &&
    typeof bun.file === "function"
  ) {
    const file = bun.file(path) as { text?: unknown };
    if (typeof file.text === "function") return (file.text as () => Promise<string>)();
  }
  throw new Error("Bun.file is required to read the D1 migration in-process");
}

/** Parse the migration's catalog: table names + the full `CREATE TABLE` body. */
function readCatalog(sql: string): {
  statements: SqlStatement[];
  tables: string[];
  bodyOf: (table: string) => string | undefined;
} {
  const statements = parseSql(sql);
  const tables: string[] = [];
  for (const stmt of statements) {
    if (stmt.keyword !== "CREATE") continue;
    const m =
      /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?/i.exec(
        stmt.sql,
      );
    if (m) {
      const name = m[1].toLowerCase();
      if (!tables.includes(name)) tables.push(name);
    }
  }
  const bodyOf = (table: string): string | undefined =>
    statements.find(
      (s) =>
        s.keyword === "CREATE" &&
        new RegExp(
          `^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`\\[]?${table}["'\`\\]]?\\b`,
          "i",
        ).test(s.sql),
    )?.sql;
  return { statements, tables, bodyOf };
}

// Read + parse the catalog once, at module scope (top-level await is legal in
// an ESM module body, unlike inside a `describe` callback).
const D1_SQL = await readTextFile(SQL_PATH);
const D1_CATALOG = readCatalog(D1_SQL);

describe("NFR-PERF-03 / INV-T5 — D1 is metadata only, no telemetry-point store", () => {
  const SQL = D1_SQL;
  const catalog = D1_CATALOG;

  /** Names that would betray a per-reading / telemetry-point store. */
  const POINT_STORE_NAMES = [
    /reading/i,
    /telemetry_point/i,
    /telemetry_/i,
    /samples?\b/i,
    /observations?/i,
    /measurements?/i,
    /datapoints?/i,
    /data_points?/i,
    /timeseries/i,
    /time_series/i,
    /metrics?$/i,
    /series\b/i,
    /events?\b/i,
  ];

  /** Columns a per-reading row would carry (a timestamped numeric reading). */
  const POINT_STORE_COLUMNS = [
    /^\s*value_num(eric)?\s/im,
    /^\s*value_float\s/im,
    /^\s*reading\s/im,
    /^\s*ts_ms\s/im,
    /^\s*timestamp_ms\s/im,
    /^\s*metric_value\s/im,
  ];

  it("parses a non-empty D1 catalog with the expected metadata tables", () => {
    expect(catalog.tables.length).toBeGreaterThan(0);
    // Every catalogued table is one of the known metadata tables — the shape
    // of the audit: we KNOW the catalog, and none of it is telemetry points.
    expect(catalog.tables).toEqual(
      expect.arrayContaining([
        "schema_version",
        "users",
        "accounts",
        "sessions",
        "verifications",
        "projects",
        "project_members",
        "project_tokens",
        "project_variables",
      ]),
    );
  });

  it("has NO table whose NAME is a telemetry data-point store", () => {
    for (const table of catalog.tables) {
      for (const pattern of POINT_STORE_NAMES) {
        expect(pattern.test(table), `D1 table "${table}" matches ${pattern}`).toBe(false);
      }
    }
  });

  it("has NO table whose COLUMNS form a per-reading point store", () => {
    for (const table of catalog.tables) {
      const body = catalog.bodyOf(table) ?? "";
      for (const pattern of POINT_STORE_COLUMNS) {
        expect(
          pattern.test(body),
          `D1 table "${table}" has a telemetry point-store column (${pattern})`,
        ).toBe(false);
      }
    }
  });

  it("never mentions a banned telemetry-point table anywhere in the file", () => {
    for (const banned of ["telemetry_points", "readings", "samples"]) {
      expect(new RegExp(`CREATE\\s+TABLE[^;]*${banned}`, "i").test(SQL)).toBe(false);
    }
  });

  it("documents the invariant in the migration header", () => {
    expect(SQL).toMatch(/D1\s+IS\s+METADATA\s+ONLY/i);
    expect(SQL).toMatch(/INV-T5/);
  });
});
