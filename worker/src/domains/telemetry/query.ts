/**
 * Telemetry **read** routes — the public query surface (A11).
 *
 * This is the read counterpart to the ingest route (`telemetry.ts`). It serves
 * two shapes and nothing else:
 *
 *   * `GET /v1/projects/:proj/state`
 *       -> `200 { "state": [ ... ] }`, the project's projection: the latest
 *          winning reading per `(device, variable)` stream, straight out of the
 *          ProjectDO (`latest_state`).
 *   * `GET /v1/projects/:proj/variables/:key/series?window=<ms>`
 *       -> `200 { "series": [ ... ] }`, the points of ONE variable inside a
 *          time window, read from each device's shard ring. The device's shard
 *          is located with {@link shardIndex} — the same deterministic map the
 *          write path uses — so a read never guesses which shard holds a device.
 *
 * ## Tenant isolation (INV-A1 / INV-A5)
 *
 * The tenant a request may read is derived **exclusively from the presented
 * credential**, never from the path. `:proj` is treated as a *claim*: when it
 * disagrees with the project the credential resolves to, the request is denied
 * fail-closed (`403`) before any read happens. Project A's token can therefore
 * never observe project B's state or series — the mismatch is rejected, not
 * filtered, so there is no window in which B's data is loaded at all.
 *
 * ## Strict credential parsing + read-capability gate
 *
 * The credential is parsed by the SHARED strict Bearer parser
 * ({@link readBearerToken} from `resolve-project.ts`), the same one the ingest
 * route uses: a bare or scheme-less header (`Authorization: pt_…` without
 * `Bearer`) is not a credential at all and is refused `401`, never silently
 * accepted. The resolved principal is additionally gated with the SHARED
 * `requireScope(c, "read")`, so a credential that authenticates but genuinely
 * lacks `read` (e.g. a `write`-only or otherwise unprivileged credential) is
 * refused `403` — one parser and one policy module across every route.
 *
 * The route-side `resolveCredentials` seam returns only a tenant id; the
 * principal it is turned into for the gate therefore carries **no explicit
 * `scopes`**, which the least-privilege default treats as `read`. That is the
 * *deliberate* read policy: this surface will only ever consume verifiers that
 * resolve a read-capable credential, and it can express no `write`.
 *
 * ## The seams
 *
 * Nothing here touches a Durable Object, D1 or a real binding. Three lookups are
 * injected through {@link QueryDeps}:
 *
 *   1. {@link CredentialResolver} — bearer token -> project id (or `null`).
 *   2. {@link ProjectLookup}      — project id -> its projection rows.
 *   3. {@link ShardLookup}        — shard id + device -> that device's ring.
 *
 * Production wires these onto the ProjectDO / ShardDO stubs and the D1 token
 * repo; tests drive in-memory fakes (see the fakes at the foot of this file).
 *
 * ## Missing variable — the documented choice
 *
 * A `:key` that has no points in the window is **not** an error: the route
 * answers `200 { "series": [] }`. An empty series and an unknown variable are
 * deliberately indistinguishable, so the surface is not an existence oracle for
 * variable names (a caller cannot learn which keys a project has, only what the
 * credential's own project reports). Callers detect "nothing yet" by an empty
 * array, never by a status code.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import {
  readBearerToken,
  requireScope,
  type Principal,
} from "../../platform/middleware/resolve-project";
import type { StateRow } from "../../platform/durable-objects/project-do";
import { shardIndex, type Sample } from "../../platform/durable-objects/shard-do";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Resolves a presented bearer token to the project it authenticates.
 *
 * Production wraps `verifyProjectToken` over the D1-backed token repo; tests
 * pass a stub. Returning `null` (or throwing) means "not usable" and the route
 * answers `401`. As in the ingest route, the two are deliberately
 * indistinguishable so a caller cannot probe *why* a token failed.
 *
 * The seam returns only the tenant. The read-capability gate is applied by the
 * route through the shared `requireScope(c, "read")`; the principal it gates is
 * built from this tenant with no explicit scopes, which the least-privilege
 * default reads as `read` (see the module docblock's read policy).
 */
export type CredentialResolver = (token: string) => Promise<{ projectId: string } | null>;

/**
 * The projection reader.
 *
 * `state` returns every projected row for a project — one per
 * `(device, variable)` stream, the same rows `ProjectDO.getState()` yields.
 * Reads are expected to be tenant-scoped by the implementation: the caller only
 * ever asks for the project its credential resolved to.
 */
export interface ProjectLookup {
  state(projectId: string): Promise<readonly StateRow[]>;
}

/**
 * The shard ring reader.
 *
 * The read path locates a device's shard with {@link shardIndex} and then asks
 * this seam for that device's ring rows. `ring` returns the samples of ONE
 * device on that shard, newest-or-oldest order unspecified by contract; the
 * route sorts by `(ts, seq)` itself so ordering is never delegated.
 */
export interface ShardLookup {
  ring(shardId: number, device: string): Promise<readonly Sample[]>;
}

/** Everything the read routes need, injectable end-to-end for tests. */
export interface QueryDeps {
  /** Verify the presented bearer token -> project, or `null` to refuse. */
  readonly credentials: CredentialResolver;
  /** The project projection (ProjectDO `latest_state`). */
  readonly projects: ProjectLookup;
  /** The shard ring (ShardDO `ring_buffer`), keyed by shard id + device. */
  readonly shards: ShardLookup;
  /**
   * Total shard count used to map a device to its shard, mirroring the write
   * path's fan-out. Defaults to {@link DEFAULT_TOTAL_SHARDS}.
   */
  readonly totalShards?: number;
  /** Clock seam; the ONLY source of "now" for a window with no upper bound. */
  readonly now?: Clock;
}

/** A clock returning Unix epoch milliseconds. */
export type Clock = () => number;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Header carrying the credential, mirroring the ingest route. */
export const AUTHORIZATION_HEADER = "authorization";

/** Total shards assumed when the caller does not pin one. */
export const DEFAULT_TOTAL_SHARDS = 1;

/**
 * Longest window accepted, in milliseconds (30 days). A larger window is a
 * client error (`400`) rather than a silent clamp, so a caller cannot ask for
 * "everything" and get an unbounded ring scan by accident.
 */
export const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Default window when the query string omits `window` (1 hour). */
export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/** Default wall clock: Unix epoch milliseconds. */
const defaultClock: Clock = () => Date.now();

// ---------------------------------------------------------------------------
// Public response shapes
// ---------------------------------------------------------------------------

/** One point of a series, as the read surface exposes it. */
export interface SeriesPoint {
  readonly device: string;
  readonly variable: string;
  readonly value: number | null;
  readonly ts: number;
  readonly seq: number;
}

/** Body of `GET /v1/projects/:proj/state`. */
export interface StateBody {
  readonly state: readonly StateRow[];
}

/** Body of `GET /v1/projects/:proj/variables/:key/series`. */
export interface SeriesBody {
  readonly series: readonly SeriesPoint[];
}

/** Error body shared by every rejection on this surface. */
export interface QueryErrorBody {
  readonly error: QueryErrorCode;
  readonly message: string;
}

/** Stable, machine-readable failure reasons. */
export type QueryErrorCode =
  | "unauthorized"
  | "project_mismatch"
  | "insufficient_scope"
  | "invalid_window";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal `Context` view exposing only the `Authorization` header.
 *
 * {@link readBearerToken} needs just `c.req.header("Authorization")`; this
 * adapter lets the pure `readBearer(header)` helper reuse that ONE parser
 * without a Hono request, so the read surface never carries a second Bearer
 * grammar that could drift from the middleware's.
 */
function bearerContext(header: string): Context {
  return { req: { header: () => header } } as unknown as Context;
}

/**
 * Extract the bearer credential from an `Authorization` header value.
 *
 * Delegates to the SHARED strict parser ({@link readBearerToken}) — the same
 * one the ingest route uses — so the read and write surfaces agree byte-for-byte
 * on what a credential is: only `Bearer <token>` yields a value, and a bare or
 * scheme-less header is NOT a credential.
 *
 * @returns the token, or `""` when the header is absent or malformed (a value
 *   no resolver accepts, so the route answers `401`).
 */
export function readBearer(header: string | undefined): string {
  return header === undefined ? "" : (readBearerToken(bearerContext(header)) ?? "");
}

/** Parse `window` from a query string; `null` when absent or blank. */
export function parseWindow(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : NaN;
}

/** JSON `401` body, used for both the missing-token and rejected-token paths. */
function unauthorized(c: Context): Response {
  const body: QueryErrorBody = {
    error: "unauthorized",
    message: "a valid project token is required",
  };
  return c.json(body, 401);
}

/** JSON `403` body for a credential that resolves to a different project. */
function projectMismatch(c: Context): Response {
  const body: QueryErrorBody = {
    error: "project_mismatch",
    message: "the credential does not grant access to the project named in the path",
  };
  return c.json(body, 403);
}

/**
 * JSON `403` body for an authenticated credential that lacks the `read`
 * capability this surface requires.
 *
 * The shape mirrors the shared `requireScope` denial (`insufficient_scope`) so
 * the read surface speaks the same authorization vocabulary as every other
 * route; only the transport is local.
 */
function insufficientScope(c: Context): Response {
  const body: QueryErrorBody = {
    error: "insufficient_scope",
    message: 'this credential lacks the "read" capability required here',
  };
  return c.json(body, 403);
}

/** JSON `400` body for a malformed or out-of-range window. */
function invalidWindow(c: Context, message: string): Response {
  const body: QueryErrorBody = { error: "invalid_window", message };
  return c.json(body, 400);
}

/** Sort points by `(ts, seq)` ascending — the stable series order. */
function byTimeThenSeq(a: SeriesPoint, b: SeriesPoint): number {
  return a.ts - b.ts || a.seq - b.seq;
}

/**
 * Is `proj` readable with this credential?
 *
 * Returns the resolved project id on success, or the exact refusal `Response`
 * to return otherwise. The order is deliberate and mirrors the ingest route:
 *
 *   1. **parse** with the shared strict `readBearerToken` — a bare or
 *      scheme-less Authorization is not a credential, so it is `401` and is
 *      never handed to the resolver;
 *   2. **resolve** through the injected seam (a throw is a refusal, not a 500);
 *   3. **authorize** with the shared `requireScope(c, "read")` — a credential
 *      that resolves but lacks `read` is `403 insufficient_scope`;
 *   4. **match** the `:proj` claim against the credential — a disagreeing claim
 *      is `403 project_mismatch` (authenticated, wrong tenant).
 *
 * A claim that disagrees with the credential is a `403`; anything unresolvable
 * is a `401`.
 */
async function authorise(
  c: Context,
  deps: QueryDeps,
): Promise<{ projectId: string } | Response> {
  const token = readBearer(c.req.header(AUTHORIZATION_HEADER));
  if (token === "") return unauthorized(c);

  let resolved: { projectId: string } | null;
  try {
    resolved = await deps.credentials(token);
  } catch {
    // A throwing resolver is a refusal, not a 500: fail closed.
    resolved = null;
  }
  if (resolved === null) return unauthorized(c);

  // READ-CAPABILITY GATE — the shared policy module, not a local check. The
  // principal is the resolved tenant with no explicit scopes, which the
  // least-privilege default treats as `read` (see the module docblock).
  const principal: Principal = { kind: "device", projectId: resolved.projectId };
  c.set("principal", principal);
  if (requireScope(c, "read") !== null) return insufficientScope(c);

  const claimed = c.req.param("proj");
  if (claimed !== undefined && claimed !== resolved.projectId) {
    return projectMismatch(c);
  }
  return { projectId: resolved.projectId };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** The handler shape, named so consumers can hold a reference. */
export type QueryHandler = (c: Context) => Promise<Response>;

/**
 * Build the `GET /:proj/state` handler.
 *
 * Reads the project's projection after tenant resolution and returns it as
 * `{ state: [...] }`. The projection already holds one winning row per stream,
 * so no further reduction is performed here — the array is the source of truth
 * handed through verbatim.
 */
export function createStateHandler(deps: QueryDeps): QueryHandler {
  return async function stateHandler(c: Context): Promise<Response> {
    const auth = await authorise(c, deps);
    if (auth instanceof Response) return auth;

    const rows = await deps.projects.state(auth.projectId);
    const body: StateBody = { state: rows };
    return c.json(body, 200);
  };
}

/**
 * Build the `GET /:proj/variables/:key/series` handler.
 *
 * Steps, in order:
 *   1. resolve the tenant (fail-closed on a credential/path disagreement);
 *   2. parse `window` (defaults to {@link DEFAULT_WINDOW_MS}, capped at
 *      {@link MAX_WINDOW_MS}) and derive `[from, to]` from the clock;
 *   3. discover every device reporting `:key` from the projection — the
 *      projection is the authoritative index of which devices exist, so no
 *      shard is brute-forced to find devices;
 *   4. for each device, locate its shard with {@link shardIndex} and read that
 *      device's ring;
 *   5. keep only `:key` points whose `ts` is inside the window, sorted by
 *      `(ts, seq)`.
 *
 * An unknown `:key` yields `200 { series: [] }` (see the module docblock), never
 * a `404` and never an error.
 */
export function createSeriesHandler(deps: QueryDeps): QueryHandler {
  const totalShards = deps.totalShards ?? DEFAULT_TOTAL_SHARDS;
  const now = deps.now ?? defaultClock;

  return async function seriesHandler(c: Context): Promise<Response> {
    const auth = await authorise(c, deps);
    if (auth instanceof Response) return auth;

    const key = c.req.param("key") ?? "";

    // --- window ---------------------------------------------------------
    const parsed = parseWindow(c.req.query("window"));
    let windowMs: number;
    if (parsed === null) {
      windowMs = DEFAULT_WINDOW_MS;
    } else if (!Number.isFinite(parsed) || parsed < 0) {
      return invalidWindow(c, "window must be a non-negative number of milliseconds");
    } else if (parsed > MAX_WINDOW_MS) {
      return invalidWindow(c, `window must not exceed ${MAX_WINDOW_MS} ms`);
    } else {
      windowMs = parsed;
    }

    const to = now();
    const from = to - windowMs;

    // --- devices reporting this variable (from the projection) -----------
    const projection = await deps.projects.state(auth.projectId);
    const devices = new Set<string>();
    for (const row of projection) {
      if (row.variable === key) devices.add(row.device);
    }

    // --- ring read, one shard lookup per device --------------------------
    const series: SeriesPoint[] = [];
    for (const device of devices) {
      const shardId = shardIndex(device, totalShards);
      const ring = await deps.shards.ring(shardId, device);
      for (const sample of ring) {
        if (sample.metric !== key) continue;
        if (sample.ts < from || sample.ts > to) continue;
        series.push({
          device: sample.device,
          variable: sample.metric,
          value: sample.value,
          ts: sample.ts,
          seq: sample.seq,
        });
      }
    }

    series.sort(byTimeThenSeq);
    const body: SeriesBody = { series };
    return c.json(body, 200);
  };
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

/**
 * Build a ready-to-mount Hono app exposing both read routes.
 *
 * Mount with `app.route("/v1/projects", createTelemetryQuery(deps))`.
 */
export function createTelemetryQuery(deps: QueryDeps): Hono {
  const app = new Hono();
  app.get("/:proj/state", createStateHandler(deps));
  app.get("/:proj/variables/:key/series", createSeriesHandler(deps));
  return app;
}

// ---------------------------------------------------------------------------
// In-memory fakes — honest implementations of the seams, for tests and dev
// ---------------------------------------------------------------------------

/**
 * In-memory credentials fake.
 *
 * Maps plaintext token -> project id. A missing entry resolves to `null` (the
 * `401` path), exactly as a D1 lookup by an unknown hash would. {@link resolver}
 * is the {@link CredentialResolver} this class stands in for, so a harness reads
 * `deps = { credentials: creds.resolver, ... }`.
 */
export class InMemoryCredentials {
  readonly #byToken = new Map<string, string>();

  /** The seam function backed by this fake's map, bound to the instance. */
  readonly resolver: CredentialResolver = (token) => {
    const projectId = this.#byToken.get(token);
    return Promise.resolve(projectId === undefined ? null : { projectId });
  };

  /** Register `token` as authenticating `projectId`. */
  add(token: string, projectId: string): this {
    this.#byToken.set(token, projectId);
    return this;
  }
}

/**
 * In-memory {@link ProjectLookup}.
 *
 * Backed by a plain `Map<projectId, StateRow[]>`; unset projects read as empty,
 * never as an error.
 */
export class InMemoryProjectLookup implements ProjectLookup {
  readonly #byProject = new Map<string, StateRow[]>();

  /** Replace the projection of `projectId` with `rows`. */
  set(projectId: string, rows: readonly StateRow[]): this {
    this.#byProject.set(projectId, [...rows]);
    return this;
  }

  /** Append one projected row to a project. */
  push(projectId: string, row: StateRow): this {
    const rows = this.#byProject.get(projectId) ?? [];
    rows.push(row);
    this.#byProject.set(projectId, rows);
    return this;
  }

  state(projectId: string): Promise<readonly StateRow[]> {
    return Promise.resolve(this.#byProject.get(projectId) ?? []);
  }
}

/**
 * In-memory {@link ShardLookup}.
 *
 * Models the sharded ring: samples are stored per `(shardId, device)` and read
 * back as a copy, so a caller cannot mutate what the "shard" holds. A shard has
 * no notion of the tenant — that is the read path's concern — which is exactly
 * why tenant isolation is asserted at the route, not here.
 */
export class InMemoryShards implements ShardLookup {
  readonly #rings = new Map<string, Sample[]>();
  /** Every `(shardId, device)` this fake was asked for (read-audit trail). */
  readonly reads: { shardId: number; device: string }[] = [];

  static #key(shardId: number, device: string): string {
    return `${shardId}\u0000${device}`;
  }

  /** Append a sample to the ring of `device` on `shardId`. */
  append(shardId: number, sample: Sample): this {
    const key = InMemoryShards.#key(shardId, sample.device);
    const rows = this.#rings.get(key) ?? [];
    rows.push({ ...sample });
    this.#rings.set(key, rows);
    return this;
  }

  ring(shardId: number, device: string): Promise<readonly Sample[]> {
    this.reads.push({ shardId, device });
    const rows = this.#rings.get(InMemoryShards.#key(shardId, device)) ?? [];
    return Promise.resolve(rows.map((row) => ({ ...row })));
  }
}

export default createTelemetryQuery;
