/**
 * app — the deployable Worker (M1 + M3), expressed as a **pure factory over seams**.
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
 *   | `GET  /v1/ota` + `GET /v1/ota/image` | {@link AppDeps.m3}.ota       |
 *   | `GET  /v1/control` + `/ack` + `/ws` | {@link AppDeps.m3}.control   |
 *   | `POST /v1/events`                | {@link AppDeps.m3}.events       |
 *   | `POST /v1/admin/projects/:proj/automations/:id/run` | {@link AppDeps.m3}.manualRun |
 *   | `GET  /v1/public/dashboards/:token` | {@link AppDeps.m3}.publicDashboard |
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
 * ## Why `/v1/telemetry` is route-authenticated, not gated
 *
 * The ingest route authenticates itself: `createTelemetryIngest` refuses an
 * absent credential with `401 { error: "unauthorized" }` *before* it reads the
 * body — the frozen contract the smoke test pins (`POST_TELEMETRY.errors` names
 * `unauthorized`, not the middleware's `missing_credential`). The rule applies
 * to a *presented* credential too: an unknown, revoked or expired token is the
 * same `401 { error: "unauthorized" }`, never the middleware's
 * `invalid_credential`.
 *
 * Mounting a `resolveDeviceProject` gate on the ingest path would break that:
 * on a rejected credential it would answer with the middleware's body before
 * the route ever ran. So the gate is **not** mounted on `/v1/telemetry`, and
 * the one-time `:proj` claim form is gone with it (the router only ever posts
 * to the base path, so `/v1/telemetry/:proj` was dead — a 404, not a route).
 *
 * The tenant is still resolved from the device credential, exactly once and by
 * the one seam the gate would have used: {@link createApp} wraps the route's
 * `verifyToken` so the same lookup pins `principal`/`project` on the context.
 * The wrapper records only — it makes no decision. The route keeps ownership of
 * the `401` and keeps enforcing `requireScope(c, "write")` (so a `read`-scoped
 * or scope-less token is `403`), and the read surface keeps its own gate.
 */

import { Hono } from "hono";
import {
  createTelemetryIngest,
  type DeviceIngestibilityGate,
  type DeviceRegistry,
  type IngestRateLimiter,
  type TelemetrySink,
  type VerifyToken,
} from "./domains/telemetry/telemetry";
import { defaultRateLimiter, type RateLimitPolicy } from "./domains/telemetry/rate-limit";
import type { TelemetryLimits } from "./shared/validation";
import {
  createTelemetryQuery,
  type CredentialResolver,
  type ProjectLookup,
  type ShardLookup,
} from "./domains/telemetry/query";
import {
  createEvents,
  type EventDispatcher,
  type VerifyEventToken,
} from "./domains/telemetry/events";
import {
  createControl,
  type ControlDeps,
  type ControlPlane,
  type VerifyControlToken,
} from "./domains/telemetry/control";
import {
  createControlWs,
  type ControlWsDeps,
  type WebSocketRuntime,
} from "./domains/telemetry/control-ws";
import {
  createOtaImage,
  type ImageDeps,
} from "./domains/firmware/image";
import {
  createOtaOffer,
  type OfferDeps,
} from "./domains/firmware/offer";
import {
  createManualRun,
  type ManualRunDeps,
} from "./platform/engine/manual-run";
import {
  PublicDashboardService,
  isPublicDashboardError,
  type PublicDashboardOptions,
} from "./domains/dashboards/public";
import { securityHeaders } from "./platform/middleware/security-headers";
import {
  resolveAdminProject,
  resolveDeviceProject,
  type CredentialLookup,
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
    /**
     * Per-token ingress rate limiter. Optional here (a caller may inject one
     * or rely on {@link createApp}'s default), consulted after auth+scope and
     * before device ingressibility; a denial is `429` + `retry-after`.
     */
    readonly rateLimiter?: IngestRateLimiter;
    /** Rate-limit policy `(limit, windowMs)`; the route default applies if omitted. */
    readonly rateLimit?: RateLimitPolicy;
    /**
     * Device lifecycle gate (INV-DEV-status). Optional: when omitted the route
     * treats every device as ingestible. Production injects a `devices`-backed
     * gate so a `retired`/`dormant` device is refused `403
     * device_not_ingestible` and only `active`/unknown devices write.
     */
    readonly ingestibility?: DeviceIngestibilityGate;
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
  /**
   * M3 surfaces. Every field is optional and independent: when a group is
   * omitted the corresponding route is simply not mounted, so an M1-only deploy
   * keeps composing unchanged. A deploy that wants the two-way control plane,
   * discrete events, OTA, admin manual-run or the public dashboard supplies the
   * matching group and the route appears — behind exactly the middleware that
   * owns its contract (device bearer for the device surfaces, the admin session
   * gate for the run route, the share resolver for the public read).
   */
  readonly m3?: {
    /**
     * `GET /v1/ota` + `GET /v1/ota/image`. Both authenticate themselves through
     * their own injected `verifyToken`; no upstream gate is mounted, so a
     * rejected credential is the route's own `401 { error: "unauthorized" }`.
     */
    readonly ota?: {
      readonly offer: OfferDeps;
      readonly image: ImageDeps;
    };
    /**
     * `GET /v1/control`, `POST /v1/control/ack` and `GET /v1/control/ws`. The
     * HTTP and socket transports share ONE control plane + verifier, so they can
     * never authenticate or deliver differently.
     */
    readonly control?: {
      readonly plane: ControlPlane;
      readonly verifyToken: VerifyControlToken;
      /** The socket upgrade seam; omit to serve the HTTP transports only. */
      readonly ws?: WebSocketRuntime;
      /** Bind delivered commands to the calling device (default true). */
      readonly scopeToDevice?: boolean;
    };
    /** `POST /v1/events` — a device event that fires automations. */
    readonly events?: {
      readonly verifyToken: VerifyEventToken;
      readonly dispatch: EventDispatcher;
    };
    /**
     * `POST /v1/admin/projects/:proj/automations/:id/run`. Mounted on the
     * `/v1/admin/projects` subtree behind {@link resolveAdminProject}, so the
     * route is fail-closed on its own session gate.
     */
    readonly manualRun?: {
      readonly deps: ManualRunDeps;
      readonly credentials: CredentialLookup;
    };
    /**
     * `GET /v1/public/dashboards/:token` — the allow-list-filtered public read.
     * A share token is resolved by {@link PublicDashboardService}; the response
     * never carries a variable outside the layout the share names.
     */
    readonly publicDashboard?: PublicDashboardOptions;
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
 * Build the deployable Worker from injected dependencies.
 *
 * The M1 surface (health, version, ingest, read) is always composed. The M3
 * surfaces (OTA, control, events, admin manual-run, public dashboard) are
 * composed only when {@link AppDeps.m3} supplies their seam groups — see
 * {@link mountM3} — so an M1 deployment is unchanged and a full one gains them.
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

  // 3. Device ingress. The ingest router is the single authority for every
  //    ingest decision, including the credential verdict. The frozen contract
  //    for `POST /v1/telemetry` (`POST_TELEMETRY.errors`) names `unauthorized`
  //    — for a missing token AND for a presented-but-rejected one — and never
  //    the middleware's `invalid_credential` / `missing_credential` codes.
  //
  //    Folding a `resolveDeviceProject` gate onto the base path would answer a
  //    rejected credential with the middleware's body before the route ran, so
  //    the gate is NOT mounted there. (The old dead `:proj` claim form —
  //    `/v1/telemetry/:proj`, which the router never posts to — is gone too: an
  //    unknown path now 404s at the framework edge rather than invoking a gate
  //    whose route does not exist.)
  //
  //    The tenant is still resolved from the device credential — exactly once,
  //    by the one seam the gate would have used — so `principal`/`project` are
  //    pinned for the route. The wrapper only records; it makes no decision:
  //    the route's own `verifyToken` still owns the `401`, and the route still
  //    enforces `requireScope(c, "write")` (so a `read`-scoped or scope-less
  //    token is `403`). Authenticating and authorizing stay with the module
  //    that owns the wire contract.
  const resolveIngestDevice = deps.deviceTokens;
  app.route(
    "/v1/telemetry",
    createTelemetryIngest({
      ...deps.ingest,
      // A rate limiter is always in force: the caller may inject one, otherwise
      // the process-wide default (one shared sliding-window log) is used. The
      // route keys it by the presented token and applies `rateLimit` (or the
      // route's own default policy), so limiting is on by default rather than
      // silently absent when a deploy forgets the seam.
      rateLimiter: deps.ingest.rateLimiter ?? defaultRateLimiter,
      verifyToken: async (presented, c) => {
        const principal = await resolveIngestDevice(presented);
        if (principal?.kind === "device") {
          c.set("principal", principal);
          c.set("project", principal.projectId);
        }
        return deps.ingest.verifyToken(presented, c);
      },
    }),
  );

  // 4. Read surface. The router owns `:proj`; the middleware is mounted on the
  //    sub-tree so a path claim that disagrees with the credential is refused
  //    fail-closed before any read.
  const projectsResolver = { deviceTokens: deps.deviceTokens, sessions: deps.sessions };
  const projects = new Hono();
  projects.use("/:proj/*", resolveDeviceProject(projectsResolver));
  projects.route("/", createTelemetryQuery(deps.query));
  app.route("/v1/projects", projects);

  // 5. M3 surfaces. Each is mounted only when its seam group is supplied, so an
  //    M1 deployment composes exactly as before and a full deployment gains the
  //    two-way control plane, events, OTA, admin run and the public dashboard.
  //    Every group keeps its own contract: the device surfaces authenticate
  //    themselves (their own `verifyToken`), the run route sits behind the admin
  //    session gate, and the public read behind the share resolver.
  mountM3(app, deps);

  return app;
}

/**
 * Mount the M3 route groups a deploy has supplied, in the frozen order.
 *
 * Kept as its own function (rather than inlined above) so the composition reads
 * as "M1 wiring, then M3 wiring" and each group's mount path and gate are
 * visible in one place. Nothing here re-implements a module: each call passes
 * the injected seams straight through, and the module owns the wire contract.
 *
 * Paths, exactly as the spec fixes them (§5.2/§6):
 *   * `GET  /v1/ota`                          — offer (device bearer)
 *   * `GET  /v1/ota/image`                    — image stream (device bearer)
 *   * `GET  /v1/control` + `POST /v1/control/ack` — downlink (device bearer)
 *   * `GET  /v1/control/ws`                   — socket transport (same seam)
 *   * `POST /v1/events`                       — discrete event (device bearer)
 *   * `POST /v1/admin/projects/:proj/automations/:id/run` — behind the admin gate
 *   * `GET  /v1/public/dashboards/:token`     — allow-list-filtered public read
 */
function mountM3(app: App, deps: AppDeps): void {
  const m3 = deps.m3;
  if (m3 === undefined) return;

  // --- OTA (A18b/A18c) ------------------------------------------------------
  // The offer sits at `/v1/ota` and the image at `/v1/ota/image`. Hono resolves
  // the more specific path first, so mounting both under the `/v1/ota` family
  // cannot shadow the image route.
  if (m3.ota !== undefined) {
    app.route("/v1/ota/image", createOtaImage(m3.ota.image));
    app.route("/v1/ota", createOtaOffer(m3.ota.offer));
  }

  // --- Control (A19/A20) ----------------------------------------------------
  // One control plane + verifier feed both transports; the socket is optional.
  if (m3.control !== undefined) {
    app.route(
      "/v1/control",
      createControl({
        control: m3.control.plane,
        verifyToken: m3.control.verifyToken,
        scopeToDevice: m3.control.scopeToDevice,
      } satisfies ControlDeps),
    );
    if (m3.control.ws !== undefined) {
      // The socket router owns `/` under its own sub-tree so the HTTP handlers
      // at `/v1/control` and `/v1/control/ack` are untouched.
      const ws = new Hono();
      ws.route(
        "/",
        createControlWs({
          control: m3.control.plane,
          verifyToken: m3.control.verifyToken,
          runtime: m3.control.ws,
          scopeToDevice: m3.control.scopeToDevice,
        } satisfies ControlWsDeps),
      );
      app.route("/v1/control/ws", ws);
    }
  }

  // --- Events (A21b) --------------------------------------------------------
  if (m3.events !== undefined) {
    app.route(
      "/v1/events",
      createEvents({ verifyToken: m3.events.verifyToken, dispatch: m3.events.dispatch }),
    );
  }

  // --- Admin manual-run (A21c) ---------------------------------------------
  // Mounted under `/v1/admin/projects` behind the shared session gate, so a
  // missing/unknown session is a fail-closed `401` and a `:proj` claim that
  // contradicts the session is `403` — before the handler runs.
  if (m3.manualRun !== undefined) {
    const admin = new Hono();
    admin.use("/:proj/automations/:id/run", resolveAdminProject(m3.manualRun.credentials));
    admin.route("/", createManualRun({ ...m3.manualRun.deps }));
    app.route("/v1/admin/projects", admin);
  }

  // --- Public dashboard (A24) ----------------------------------------------
  // A share token in the path resolves to an allow-listed view; the snapshot is
  // the projection filtered by the layout the share names. A refusal is the
  // module's own typed error mapped to its frozen status (404 for no usable
  // share, 401 for an attempted write — never a `500`).
  if (m3.publicDashboard !== undefined) {
    const dashboard = new PublicDashboardService(m3.publicDashboard);
    app.get("/v1/public/dashboards/:token", async (c) => {
      try {
        const view = await dashboard.resolve(c.req.param("token"));
        const points = await view.snapshot();
        return c.json({ variables: view.variables, points }, 200);
      } catch (err) {
        if (isPublicDashboardError(err)) {
          return c.json(err.toBody(), err.status as 401 | 404);
        }
        throw err;
      }
    });
  }
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
