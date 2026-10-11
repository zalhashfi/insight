/**
 * app — the M1 deployable Worker, expressed as a **pure factory over seams**.
 *
 * `createApp(deps)` composes the whole HTTP surface out of the domain modules
 * that already exist; it re-implements none of them. The return value is a
 * ready-to-serve Hono app that also exposes `fetch`, so the Cloudflare runtime
 * can `export default app` and tests can drive it in-process with
 * `app.request(path)` — no `wrangler`, no bindings, no network.
 *
 * ## What this module is (and is not)
 *
 * It is *wiring*: one middleware, four routes, two routers, all mounted in the
 * order the invariants require. Every piece of behaviour — header hardening,
 * fail-closed tenant resolution, ingest validation/persistence, projection and
 * series reads — belongs to the module that owns it and is consumed here
 * verbatim:
 *
 *   | surface                          | seam injected through           |
 *   |----------------------------------|---------------------------------|
 *   | `GET  /healthz`                  | — (constant)                    |
 *   | `GET  /v1/version`               | {@link AppDeps.version}         |
 *   | `POST /v1/telemetry`             | {@link AppDeps.ingest}          |
 *   | `GET  /v1/projects/:proj/state`  | {@link AppDeps.query}           |
 *   | `GET  /v1/projects/:proj/variables/:key/series` | {@link AppDeps.query} |
 *
 * ## Dependencies are injected, never faked
 *
 * A Durable Object namespace, a D1 database, an R2 bucket and the server clock
 * are real bindings. This module deliberately has **no default for any of
 * them**: it builds no app unless it is handed every one. It never reaches for
 * `env` and never substitutes a silent in-memory stand-in for a missing
 * binding — a Worker whose DO or D1 binding is absent must fail to compose
 * (loudly, at the edge) rather than accept writes into a store that evaporates
 * on eviction. {@link createApp} therefore *builds the seams it needs and hands
 * them to the domain routers*, which remain the single source of truth for the
 * wire contract.
 *
 * The two routers are consumed through their existing entry points and their
 * own mount conventions, unchanged:
 *   * `createTelemetryIngest(deps)` is a self-contained router mounted at
 *     `/v1/telemetry` — it authorizes itself through the injected `verifyToken`
 *     (the contract lock's "401 with no token" is its behaviour, not the
 *     project middleware's);
 *   * `createTelemetryQuery(deps)` is a self-contained router mounted at
 *     `/v1/projects`, mapping `:proj` to the credential's project.
 *
 * ## Why `/v1/telemetry` sits behind the project middleware
 *
 * The ingest route authenticates itself: `createTelemetryIngest` refuses an
 * absent credential with `401 { error: "unauthorized" }` *before* it reads the
 * body — the frozen contract the smoke test pins (`POST_TELEMETRY.errors` names
 * `unauthorized`, not the middleware's `missing_credential`). So the gate is
 * mounted on the ingest paths **without taking over that `401`**:
 *
 *   * on the base path `/v1/telemetry`, the gate runs only when a credential is
 *     actually presented. With no credential the request falls through to the
 *     route, which answers it as the contract demands; with one, the gate
 *     resolves and pins the tenant first, and the route independently
 *     re-verifies and enforces the `write` scope.
 *   * on the `:proj` claim form `/v1/telemetry/:proj`, the gate is fully
 *     fail-closed — no credential is `401`, and a claim contradicting the
 *     credential is `403` — matching the read surface.
 *
 * Either way the credential is verified twice with the same injected seam, so
 * the fold can only ever be *more* strict, never permissive.
 */

import { Hono } from "hono";
import {
  createTelemetryIngest,
  type DeviceRegistry,
  type TelemetrySink,
  type VerifyToken,
} from "./domains/telemetry/telemetry";
import type { TelemetryLimits } from "./shared/validation";
import {
  createTelemetryQuery,
  type CredentialResolver,
  type ProjectLookup,
  type ShardLookup,
} from "./domains/telemetry/query";
import { securityHeaders } from "./platform/middleware/security-headers";
import {
  readBearerToken,
  resolveDeviceProject,
  type DeviceTokenResolver,
  type ResolveProjectVariables,
  type SessionResolver,
} from "./platform/middleware/resolve-project";

// ---------------------------------------------------------------------------
// Version surface
// ---------------------------------------------------------------------------

/** The `GET /v1/version` response body (spec: `{ name, version }`). */
export interface VersionInfo {
  readonly name: string;
  readonly version: string;
}

/**
 * The default version reported by `GET /v1/version`.
 *
 * Kept identical to the value the skeleton worker served, so composing the app
 * is observably a no-op for that route. A deploy that wants to advertise a
 * build id passes `version` to {@link createApp} instead of editing this.
 */
export const DEFAULT_VERSION: VersionInfo = { name: "insight", version: "0.0.1" };

// ---------------------------------------------------------------------------
// Dependency contract
// ---------------------------------------------------------------------------

/**
 * Everything the composed app needs. Each field is a **required, injected
 * dependency**:
 *
 *   * `deviceTokens` / `sessions` — the credential-lookup adapters for the two
 *     credential families (D1 over `project_tokens` / `sessions` in
 *     production). Both are mandatory: the middleware is fail-closed, and a
 *     missing resolver would mean an undeployable surface, not a permissive one.
 *   * `ingest` — the ingest route's seams (`verifyToken`, `sink`, `devices`,
 *     optional `now` / `limits` / `defaultDevice`), passed straight through.
 *   * `query` — the read routes' seams (`credentials`, `projects`, `shards`,
 *     optional `totalShards` / `now`), passed straight through.
 *   * `version` — the advertised build identity. The only field with a
 *     default, because it is presentation rather than a binding.
 */
export interface AppDeps {
  /** Device (`pt_…`) credential lookup — the `device` route family. */
  readonly deviceTokens: DeviceTokenResolver;
  /** User-session credential lookup — the `admin` route family. */
  readonly sessions: SessionResolver;
  /** Seams for `POST /v1/telemetry` (see {@link TelemetrySink}, {@link DeviceRegistry}). */
  readonly ingest: {
    readonly verifyToken: VerifyToken;
    readonly sink: TelemetrySink;
    readonly devices: DeviceRegistry;
    /** Server clock — the ONLY source of a record's timestamp. */
    readonly now?: () => number;
    /** Validation limits, forwarded verbatim to the shared validator. */
    readonly limits?: TelemetryLimits;
    /** Device key used when `x-insight-device` is absent or blank. */
    readonly defaultDevice?: string;
  };
  /** Seams for the two `GET /v1/projects/:proj/…` read routes. */
  readonly query: {
    readonly credentials: CredentialResolver;
    readonly projects: ProjectLookup;
    readonly shards: ShardLookup;
    /** Shard fan-out used by the series read; must match the write path. */
    readonly totalShards?: number;
    /** Clock used to bound the series window. */
    readonly now?: () => number;
  };
  /** Version identity served at `GET /v1/version`. */
  readonly version?: VersionInfo;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Variables the composed app threads through its middleware and routes.
 *
 * These are exactly the middleware's own {@link ResolveProjectVariables}, named
 * here so the exported `App` type and this module agree on one contract.
 */
export type AppVariables = ResolveProjectVariables;

/**
 * The composed app: a Hono instance whose `fetch` is a valid Worker handler.
 * Named (rather than left as `ReturnType<typeof createApp>`) so consumers
 * import the contract directly and type errors land on this boundary. The
 * variables are the middleware's own — `principal` and `project` — so a
 * consumer that reads them is typed.
 */
export type App = Hono<{ Variables: AppVariables }>;

/**
 * Build the deployable M1 app from injected dependencies.
 *
 * Middleware order matters and is deliberate: {@link securityHeaders} is
 * mounted on `*` **first**, so it wraps every response the app can produce —
 * including the `401` its own gate returns, the framework's `404` for an
 * unknown path, and any `500` from `onError`. Being outermost, it also wraps
 * the bodies of the two routers mounted below.
 *
 * @throws TypeError when a required dependency is missing or malformed. This is
 *   a composition-time failure at the edge, not a runtime `500`: it is the
 *   guard that keeps a half-bound deploy from silently accepting telemetry.
 */
export function createApp(deps: AppDeps): App {
  assertDeps(deps);

  // The middleware and the ingest route write `principal`/`project`; declaring
  // the variables here keeps those `c.set`/`c.get` calls typed.
  const app = new Hono<{ Variables: AppVariables }>();

  // 1. Hardening first, on the widest pattern, so nothing can outrun it.
  app.use("*", securityHeaders());

  // 2. Liveness + identity — no auth, no seams, constant responses.
  app.get("/healthz", (c) => c.json({ ok: true }, 200));
  const version = deps.version ?? DEFAULT_VERSION;
  app.get("/v1/version", (c) => c.json({ name: version.name, version: version.version }, 200));

  // 3. Device ingress. The gate pins the tenant before the route runs, but the
  //    base path stays *route-authenticated*: the frozen contract for
  //    `POST /v1/telemetry` is the ingest route's own
  //    `401 { error: "unauthorized" }` (see `POST_TELEMETRY.errors`), not the
  //    middleware's `missing_credential`. So on the base path the gate runs
  //    only when a credential is actually presented — an unauthenticated POST
  //    falls through untouched and the route answers it, exactly as the
  //    contract says. A presented credential is still resolved and pinned, and
  //    the route independently re-verifies and enforces the `write` scope.
  //
  //    The `:proj` claim form is fully fail-closed (no credential => 401, a
  //    claim contradicting the credential => 403), matching the read surface.
  const ingestGate = resolveDeviceProject({
    deviceTokens: deps.deviceTokens,
    // Required by the middleware contract; never consulted on a device route
    // (and never reached, because the gate denies first).
    sessions: deps.sessions,
  });
  const projectsResolver = { deviceTokens: deps.deviceTokens, sessions: deps.sessions };

  app.use("/v1/telemetry", (c, next) =>
    // No credential at all: the route owns the 401 (its frozen body/code).
    readBearerToken(c) === null ? next() : ingestGate(c, next),
  );
  app.use("/v1/telemetry/:proj", ingestGate);
  app.route("/v1/telemetry", createTelemetryIngest(deps.ingest));

  // 4. Read surface. The router owns `:proj`; the middleware is mounted on the
  //    sub-tree so a path claim that disagrees with the credential is refused
  //    fail-closed before any read.
  const projects = new Hono();
  projects.use("/:proj/*", resolveDeviceProject(projectsResolver));
  projects.route("/", createTelemetryQuery(deps.query));
  app.route("/v1/projects", projects);

  return app;
}

/**
 * Minimal, explicit validation of the injected dependency object.
 *
 * Only the *structural* requirements are checked — a resolver must be callable
 * and a seam object must be present — because anything deeper is the domain
 * module's concern. The point is to turn the one dangerous mistake (forgetting
 * a binding and getting a silently-degraded Worker) into an immediate throw.
 */
function assertDeps(deps: AppDeps): void {
  const missing: string[] = [];
  const check = (ok: boolean, name: string): void => {
    if (!ok) missing.push(name);
  };

  check(typeof deps?.deviceTokens === "function", "deviceTokens");
  check(typeof deps?.sessions === "function", "sessions");
  check(typeof deps?.ingest === "object" && deps.ingest !== null, "ingest");
  check(typeof deps?.ingest?.verifyToken === "function", "ingest.verifyToken");
  check(typeof deps?.ingest?.sink === "object" && deps.ingest.sink !== null, "ingest.sink");
  check(
    typeof deps?.ingest?.devices === "object" && deps.ingest.devices !== null,
    "ingest.devices",
  );
  check(typeof deps?.query === "object" && deps.query !== null, "query");
  check(typeof deps?.query?.credentials === "function", "query.credentials");
  check(typeof deps?.query?.projects === "object" && deps.query.projects !== null, "query.projects");
  check(typeof deps?.query?.shards === "object" && deps.query.shards !== null, "query.shards");

  if (missing.length > 0) {
    throw new TypeError(`createApp: missing required dependency: ${missing.join(", ")}`);
  }
}

export default createApp;
