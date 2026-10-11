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
 *   | `DELETE /v1/admin/projects/:proj`       | {@link AppDeps.m3}.projectDelete |
 *   | `POST /v1/admin/projects/:proj/firmware`| {@link AppDeps.m3}.firmwareUpload |
 *   | `POST /v1/admin/projects/:proj/devices/import` | {@link AppDeps.m3}.deviceImport |
 *   | `GET  /v1/public/dashboards/:token` (+ `/stream`) | {@link AppDeps.m3}.publicDashboard |
 *   | `GET  /embed/:token`             | {@link AppDeps.m3}.publicDashboard |
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
import type { Context } from "hono";
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
  createFirmwareUploadRoute,
  type FirmwareUploadRouteDeps,
} from "./domains/firmware/upload-route";
import {
  createProjectDeleteRoute,
  type ProjectDeleteRouteDeps,
} from "./domains/projects/delete-route";
import {
  createDeviceImportRoute,
  type DeviceImportRouteDeps,
} from "./domains/devices/import-route";
import {
  PublicDashboardService,
  isPublicDashboardError,
  type PublicDashboardOptions,
} from "./domains/dashboards/public";
import { createEmbedRoute, type EmbedLayout } from "./domains/dashboards/embed";
import {
  createMcpToolRoutes,
  redactSecrets,
  type McpToolDeps,
} from "./mcp/tools";
import {
  createMcpOAuth,
  type McpGateDeps,
  type McpOAuthDeps,
} from "./mcp/gate";
import {
  testIntegration,
  dryRunTransport,
  type DryRunTransport,
  type ExecuteIntegrationInput,
  type IntegrationTransport,
  type IntegrationResult,
  type SecretValue,
} from "./shared/integrations/runtime";
import { listProviders } from "./shared/integrations/index";
import {
  AnomalyEngine,
  type AnomalyDetector,
  type Clock,
  type EmitAnomaly,
  type SeriesReader,
} from "./domains/analytics/anomaly";
import {
  pollSource,
  type ExternalSourceConfig,
  type FetchLike,
  type CursorStore,
  type PollResult,
  type TelemetrySinkLike,
} from "./domains/external/poll";
import { securityHeaders, frameableHeaders } from "./platform/middleware/security-headers";
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
     * `DELETE /v1/admin/projects/:proj` — the owner-only project delete.
     * Mounted on the `/v1/admin/projects` subtree behind
     * {@link resolveAdminProject}; the handler additionally enforces the
     * owner-only `project:delete` capability through the membership table.
     */
    readonly projectDelete?: {
      readonly deps: ProjectDeleteRouteDeps;
      readonly credentials: CredentialLookup;
    };
    /**
     * `POST /v1/admin/projects/:proj/firmware` — the admin OTA upload. Mounted
     * on the `/v1/admin/projects` subtree behind {@link resolveAdminProject};
     * the handler additionally enforces `project:update` (admin+) through the
     * membership table, and the service's own `413` for an oversize body.
     */
    readonly firmwareUpload?: {
      readonly deps: FirmwareUploadRouteDeps;
      readonly credentials: CredentialLookup;
    };
    /**
     * `POST /v1/admin/projects/:proj/devices/import` — the bulk device import
     * (A34/FR-DEV-06). Mounted on the `/v1/admin/projects` subtree behind
     * {@link resolveAdminProject}; the handler additionally enforces
     * `project:update` (admin+) through the membership table, and the import
     * service's own `413` covers an oversize body (checked before lexing).
     */
    readonly deviceImport?: {
      readonly deps: DeviceImportRouteDeps;
      readonly credentials: CredentialLookup;
    };
    /**
     * `GET /v1/public/dashboards/:token` and `.../stream` — the
     * allow-list-filtered public read and its live stream. A share token is
     * resolved by {@link PublicDashboardService}; neither response ever carries
     * a variable outside the layout the share names.
     */
    readonly publicDashboard?: PublicDashboardOptions;
    /**
     * `GET /embed/:token` (A33/FR-DSH-05) — the read-only HTML embed landing.
     * It reuses {@link publicDashboard} for resolution (one share, one rule) and
     * adds only presentation. Optional policy: a deploy may refuse to *frame* a
     * share the resolver accepts, which becomes a uniform `forbidden` (403) —
     * distinct from "no such share" (404) and never a leak.
     */
    readonly embed?: {
      readonly allowsEmbed?: (layout: EmbedLayout) => boolean;
    };
  };
  /**
   * M4 surfaces — the AI layer. Like {@link AppDeps.m3}, every group is
   * optional and independent: an M4-less deploy composes exactly as before, and
   * a deploy that supplies a group gains its route/hook wired to the real
   * seams it holds.
   *
   *   * `mcp` — the AI bridge: `GET /v1/mcp/read` + `POST /v1/mcp/write` behind
   *     the bearer gate (scope projection + `mcp_write_enabled`), and the
   *     optional OAuth 2.1 token/discovery surface at `/v1/mcp/oauth`. The tool
   *     stores are injected, so a bridge call is indistinguishable downstream
   *     from the equivalent API call.
   *   * `integrations` — the outbound-egress surface: the provider catalog (a
   *     read) plus the guarded `/test` execution, both over the injected
   *     {@link IntegrationTransport}. Secrets ride only to the transport.
   *   * `anomaly` — the notification hook: an {@link AnomalyEngine} whose emitted
   *     events are routed to a notification sink (in production, an integration
   *     execution). The engine is the REAL one; this is wiring, not a detector.
   *   * `external` — external-source polling: a route that runs {@link pollSource}
   *     for each configured source into the shared telemetry sink, so an
   *     external reading lands exactly where a device reading does.
   */
  readonly m4?: {
    /**
     * The MCP bridge. `tools` are the injected store seams the tool surface
     * reads/writes; `gate` adds the credential verifier and the write flag. The
     * optional `oauth` group mounts `/v1/mcp/oauth` when supplied.
     */
    readonly mcp?: {
      readonly tools: McpToolDeps;
      readonly gate: McpGateDeps;
      readonly oauth?: McpOAuthDeps;
    };
    /**
     * The integrations surface. `transport` is the injected network-egress
     * port; `execute` (when supplied) gates the `/test` route via a caller
     * authorization seam. The catalog read is always available when the group
     * is present.
     */
    readonly integrations?: {
      readonly transport: IntegrationTransport;
      /**
       * The dry-run transport the `/test` route sends through. The runtime
       * enforces that a `/test` never uses a live transport, so this must
       * declare `kind: "dry-run"`. Omitted → the runtime's own
       * {@link dryRunTransport} (no I/O, reports `{ dryRun: true }`) is used, so
       * the safe default needs no wiring. Supply one to *observe* what a `/test`
       * would send.
       */
      readonly testTransport?: DryRunTransport;
      /**
       * Resolve the caller to the project a `/test` execution is performed for,
       * or `null` to refuse. Omitted → the `/test` route is not mounted (the
       * catalog read still is), because an ungated test that opens secrets would
       * be an authorization hole.
       */
      readonly authorize?: (c: Context) => Promise<string | null> | string | null;
      /**
       * The secret-opening + config seam per provider. The route parses the
       * request body's `config` and `secret` and hands them here; omitted → the
       * route accepts only plaintext `secret` values (a `/test` before storage).
       */
      readonly openSecret?: (
        input: ExecuteIntegrationInput,
        projectId: string,
      ) => Promise<ExecuteIntegrationInput> | ExecuteIntegrationInput;
    };
    /**
     * The anomaly notification hook. `createApp` constructs the REAL
     * {@link AnomalyEngine} from the supplied `detectors`/`series`/`now` and
     * wires its `emit` to `notify` — so every anomaly the engine finds is routed
     * to the notification seam (in production, an integration execution). A
     * `notify`-less group still builds the engine (detection without a notifier);
     * the constructed engine is exposed on the returned app's deps for a test or
     * a scheduler to `warm()`/`observe()` through.
     */
    readonly anomaly?: {
      readonly detectors: readonly AnomalyDetector[];
      readonly notify?: EmitAnomaly;
      /** History seam for warm-pending detectors. */
      readonly series?: SeriesReader;
      /** Clock seam; defaults to the wall clock. */
      readonly now?: Clock;
      /** Warm-up look-back window in ms. */
      readonly warmWindowMs?: number;
    };
    /**
     * External sources. Each configured source is polled by the injected
     * `fetch` + `cursor`, with mapped points landing on `sink`. `route` names
     * the path the poll trigger is mounted at; it defaults to
     * `/v1/external/poll`.
     */
    readonly external?: {
      readonly sources: readonly ExternalSourceConfig[];
      readonly fetch: FetchLike;
      readonly cursor: CursorStore;
      readonly sink: TelemetrySinkLike;
      readonly now?: () => number;
      /** The poll-trigger path. Defaults to `/v1/external/poll`. */
      readonly route?: string;
      /**
       * Resolve the caller allowed to trigger a poll, or `null` to refuse.
       * Omitted → the route is not mounted (polling writes telemetry, so it must
       * not be anonymous).
       */
      readonly authorize?: (c: Context) => Promise<boolean> | boolean;
    };
  };
  /** Version identity served at `GET /v1/version`. */
  readonly version?: VersionInfo;
  /**
   * Origins allowed to frame the `/embed/:token` surface, matched against CSP
   * `frame-ancestors`. This is the deploy-configurable framing seam: the
   * baseline hardening ({@link securityHeaders}) denies framing everywhere
   * (`X-Frame-Options: DENY` + `frame-ancestors 'none'`), and the `/embed`
   * subtree is the ONE place that is relaxed — by exactly the origins listed
   * here. Omitted or empty ⇒ the embed is frameable by its own origin only
   * (`frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`); a deploy that
   * hosts the dashboard on another origin lists it here. Never a wildcard.
   *
   * The override applies only when the public-dashboard seam (which mounts
   * `/embed`) is supplied; a deploy without it keeps DENY on `/embed` too.
   */
  readonly embedFrameAncestors?: readonly string[];
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
 * Middleware order matters and is deliberate. The `/embed` framing override
 * ({@link frameableHeaders}) is mounted on that narrow subtree **first**, so it
 * is the outermost middleware there and — because both it and
 * {@link securityHeaders} write after `await next()` — its `set` wins on the
 * unwind. {@link securityHeaders} is then mounted on `*`, wrapping every other
 * response the app can produce — including the `401` its own gate returns, the
 * framework's `404` for an unknown path, and any `500` from `onError`. The
 * result: `/embed/:token` is frameable by the configured origins, while every
 * other path keeps the `X-Frame-Options: DENY` / `frame-ancestors 'none'`
 * baseline.
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

  // 1. Framing exception FIRST, on the narrow `/embed` subtree only, so it is
  //    the OUTERMOST middleware for that path. Both this and `securityHeaders`
  //    write after `await next()`, so the outer one unwinds last and wins: the
  //    embed ends up frameable while every other path keeps the DENY default.
  //    Mounted only when the embed surface is actually composed, so an M1-only
  //    deploy keeps DENY even on `/embed`.
  if (deps.m3?.publicDashboard !== undefined) {
    const frames = frameableHeaders({ ancestors: deps.embedFrameAncestors ?? [] });
    app.use("/embed", frames);
    app.use("/embed/*", frames);
  }

  // 2. Hardening next, on the widest pattern: it wraps everything but the
  //    `/embed` framing override above.
  app.use("*", securityHeaders());

  // 3. Liveness + identity — no auth, no seams, constant responses.
  app.get("/healthz", (c) => c.json({ ok: true }, 200));
  const version = deps.version ?? DEFAULT_VERSION;
  app.get("/v1/version", (c) => c.json({ name: version.name, version: version.version }, 200));

  // 4. Device ingress. The ingest router is the single authority for every
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

  // 5. Read surface. The router owns `:proj`; the middleware is mounted on the
  //    sub-tree so a path claim that disagrees with the credential is refused
  //    fail-closed before any read.
  const projectsResolver = { deviceTokens: deps.deviceTokens, sessions: deps.sessions };
  const projects = new Hono();
  projects.use("/:proj/*", resolveDeviceProject(projectsResolver));
  projects.route("/", createTelemetryQuery(deps.query));
  app.route("/v1/projects", projects);

  // 6. M3 surfaces. Each is mounted only when its seam group is supplied, so an
  //    M1 deployment composes exactly as before and a full deployment gains the
  //    two-way control plane, events, OTA, admin run and the public dashboard.
  //    Every group keeps its own contract: the device surfaces authenticate
  //    themselves (their own `verifyToken`), the run route sits behind the admin
  //    session gate, and the public read behind the share resolver.
  mountM3(app, deps);

  // 7. M4 surfaces — the AI layer. Mounted only when their seam groups are
  //    supplied, exactly like M3, so an M1–M3 deploy composes unchanged. The
  //    MCP bridge sits behind its bearer gate + write flag; the integrations,
  //    anomaly hook and external poll are wired to the injected seams they own.
  mountM4(app, deps);

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
 *   * `DELETE /v1/admin/projects/:proj`       — owner-only project delete
 *   * `POST /v1/admin/projects/:proj/firmware` — admin OTA upload (413 >8 MiB)
 *   * `POST /v1/admin/projects/:proj/devices/import` — admin bulk import (413 >cap)
 *   * `GET  /v1/public/dashboards/:token`     — allow-list-filtered public read
 *   * `GET  /v1/public/dashboards/:token/stream` — allow-list-filtered live stream
 *   * `GET  /embed/:token`                    — allow-list-filtered embed landing (A33)
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

  // --- Admin project delete (A23) ------------------------------------------
  // Owner-only. The shared session gate pins the principal and matches `:proj`,
  // then the handler enforces `project:delete` (owner) through the membership
  // table. The delete is the idempotent, resumable entry, so a rerun leaves no
  // orphan.
  if (m3.projectDelete !== undefined) {
    app.route(
      "/v1/admin/projects",
      createProjectDeleteRoute({
        ...m3.projectDelete.deps,
        credentials: m3.projectDelete.credentials,
      }),
    );
  }

  // --- Admin firmware upload (A18) -----------------------------------------
  // Admin+. The shared session gate pins the principal and matches `:proj`,
  // then the handler enforces `project:update` (admin+) before any bytes are
  // read; the upload service's own `413` covers an oversize body.
  if (m3.firmwareUpload !== undefined) {
    app.route(
      "/v1/admin/projects",
      createFirmwareUploadRoute({
        ...m3.firmwareUpload.deps,
        credentials: m3.firmwareUpload.credentials,
      }),
    );
  }

  // --- Admin device import (A34) -------------------------------------------
  // Admin+. The shared session gate pins the principal and matches `:proj`,
  // then the handler enforces `project:update` (admin+) before any bytes are
  // read; the import service's own `payload_too_large` (413) covers an oversize
  // body, checked BEFORE the body is lexed so a huge upload is never walked.
  if (m3.deviceImport !== undefined) {
    app.route(
      "/v1/admin/projects",
      createDeviceImportRoute({
        ...m3.deviceImport.deps,
        credentials: m3.deviceImport.credentials,
      }),
    );
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

    // The live stream (A24 / INV-D2): the SAME view's `subscribe`, whose frames
    // are filtered through the SAME allow-list as the snapshot — so a variable
    // outside the layout is dropped on the stream exactly as it is in the read.
    // A share that cannot be resolved is the uniform 404 before any stream is
    // opened, so an anonymous caller never gets a long-lived refused socket.
    app.get("/v1/public/dashboards/:token/stream", async (c) => {
      let view;
      try {
        view = await dashboard.resolve(c.req.param("token"));
      } catch (err) {
        if (isPublicDashboardError(err)) {
          return c.json(err.toBody(), err.status as 401 | 404);
        }
        throw err;
      }

      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (data: unknown): void => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          };
          // Announce the allow-list once, so a client knows what it may receive
          // before the first frame arrives.
          send({ variables: view.variables });
          try {
            unsubscribe = await view.subscribe((frame) => send(frame));
          } catch {
            // No frame seam (snapshot-only deploy): close cleanly after the
            // allow-list rather than holding an empty stream open.
            controller.close();
          }
        },
        cancel() {
          unsubscribe?.();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        },
      });
    });

    // --- Embed landing (A33 / FR-DSH-05) ------------------------------------
    // `/embed/:token` renders the SAME resolved, allow-list-filtered view as an
    // HTML document for an iframe — read-only, no login. It is built from the
    // same `publicDashboard` options, so a share has exactly one resolution
    // rule: the embed adds a presentation, never a second path to the data. An
    // unusable token is the uniform 404; a share the deploy will not frame is a
    // 403. Both are JSON refusals, so no page is rendered from a refused share.
    app.route(
      "/embed",
      createEmbedRoute({
        publicDashboard: m3.publicDashboard,
        ...(m3.embed?.allowsEmbed !== undefined
          ? { allowsEmbed: m3.embed.allowsEmbed }
          : {}),
      }),
    );
  }
}

/**
 * Mount the M4 route groups and hooks a deploy has supplied, in the frozen
 * order — after {@link mountM3}, so nothing here can shadow an earlier route.
 *
 * Paths the modules fix (the MCP surface per `mcp/gate.ts`, the poll trigger
 * defaulting to `/v1/external/poll`):
 *   * `GET  /v1/mcp/read`                     — gated read (device bearer + scope)
 *   * `POST /v1/mcp/write`                    — gated write (`mcp:manage` + flag)
 *   * `GET  /v1/mcp/oauth/.well-known/...`    — RFC 8414 discovery
 *   * `POST /v1/mcp/oauth/token`              — RFC 6749 token endpoint
 *   * `GET  /v1/integrations`                 — provider catalog (read)
 *   * `POST /v1/integrations/test`            — guarded synthetic `/test`
 *   * `POST /v1/external/poll`                — trigger a poll into the sink
 *
 * The anomaly group mounts no route: it is a **hook**. A deploy that supplies
 * `anomaly.notify` routes every event the REAL engine emits to it — the
 * notification seam. (The engine's own `emit` is untouched when `notify` is
 * omitted, so detection can be wired without a notifier.)
 *
 * Nothing here re-implements a module: the MCP route group is
 * {@link createMcpToolRoutes}, the OAuth surface {@link createMcpOAuth}, the
 * integrations catalog is the frozen provider table (`listProviders`), an
 * execution is the runtime's own {@link testIntegration}, and a poll is
 * {@link pollSource}.
 */
function mountM4(app: App, deps: AppDeps): void {
  const m4 = deps.m4;
  if (m4 === undefined) return;

  // --- MCP bridge (A27/A28) -------------------------------------------------
  // The tool route group composes the gate in front of the tool surface, so the
  // read path is behind `mcp:read` and the write path behind `mcp:manage` AND
  // the `mcp_write_enabled` flag. Mounted at `/v1/mcp`, the tools at `/read`
  // and `/write` under it (the group's own convention).
  if (m4.mcp !== undefined) {
    app.route("/v1/mcp", createMcpToolRoutes({ ...m4.mcp.tools, gate: m4.mcp.gate }));
    if (m4.mcp.oauth !== undefined) {
      // The OAuth surface owns the discovery + token paths relative to its own
      // sub-tree, exactly as `createMcpOAuth` serves them.
      app.route("/v1/mcp/oauth", createMcpOAuth(m4.mcp.oauth));
    }
  }

  // --- Integrations (A29b) --------------------------------------------------
  // The catalog is always a readable surface when the group is present (it is
  // pure data — the frozen provider table). The `/test` execution is mounted
  // only when an `authorize` seam is supplied: an ungated test opens secrets,
  // so refusing to mount it is the fail-closed direction.
  if (m4.integrations !== undefined) {
    const integrations = m4.integrations;
    app.get("/v1/integrations", (c) => c.json({ providers: listProviders() }, 200));

    if (integrations.authorize !== undefined) {
      app.post("/v1/integrations/test", async (c) => {
        const projectId = await integrations.authorize!(c);
        if (projectId === null) {
          return c.json({ error: "unauthorized", message: "a test may not be run anonymously" }, 401);
        }

        // Parse the request body into the runtime's own input shape; the
        // injected `openSecret` seam may then translate stored envelopes into
        // plaintext (the deploy's concern), staying outside this module.
        let body: Record<string, unknown>;
        try {
          const raw = await c.req.text();
          const parsed = raw.trim() === "" ? {} : JSON.parse(raw);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return c.json({ error: "invalid_request", message: "body must be an object" }, 400);
          }
          body = parsed as Record<string, unknown>;
        } catch {
          return c.json({ error: "invalid_request", message: "malformed JSON body" }, 400);
        }

        const providerId = typeof body.providerId === "string" ? body.providerId : "";
        const action = typeof body.action === "string" ? body.action : "";
        const base: ExecuteIntegrationInput = {
          providerId,
          action,
          config: isStringRecord(body.config) ? body.config : undefined,
          // The scope is the caller's interpolation context (project state,
          // thresholds, …): passed through as an opaque nested record, exactly
          // as the interpolator consumes it.
          scope: isPlainObject(body.scope) ? body.scope : undefined,
          // Secret inputs ride in the runtime's own boundary shape — either a
          // `{ plain }` value (a test before storage) or a `{ envelope, key }`
          // pair. The runtime opens them; nothing here inspects the plaintext.
          secret: isPlainObject(body.secret)
            ? (body.secret as Readonly<Record<string, SecretValue>>)
            : undefined,
          // A live transport is required by the input type but is ALWAYS
          // overwritten below by a dry-run transport, so `/test` can never
          // reach it (see the note under `testIntegration`).
          transport: integrations.transport,
        };
        const input =
          integrations.openSecret !== undefined ? await integrations.openSecret(base, projectId) : base;

        // A `/test` is always synthetic AND always dry-run: the runtime renders
        // exactly what a live call would, redacts the secrets, and refuses any
        // transport that is not declared `kind: "dry-run"` — so a `/test` cannot
        // reach the live `transport`, by construction. A deploy that wants to
        // observe the request supplies `testTransport`; otherwise the runtime's
        // own no-I/O dry-run sink is used.
        try {
          const result: IntegrationResult = await testIntegration({
            ...input,
            transport: integrations.testTransport ?? dryRunTransport(),
          });
          // The runtime already emptied `request.auth`; the whole result passes
          // through the SAME structural redactor the MCP tools use, so an
          // interpolated secret in the rendered body/config is removed too.
          return c.json({ result: redactSecrets(result) as IntegrationResult }, 200);
        } catch (err) {
          const code =
            err !== null && typeof err === "object" && "code" in err && typeof err.code === "string"
              ? err.code
              : "integration_error";
          return c.json({ error: code, message: err instanceof Error ? err.message : "integration failed" }, 400);
        }
      });
    }
  }

  // --- Anomaly notification hook (A30) -------------------------------------
  // Detection is a hook, not a route. `createApp` constructs the REAL
  // {@link AnomalyEngine} from the supplied seams and wires its `emit` to
  // `notify` (the notification seam), so every event the engine finds is routed
  // there. Without `notify` the engine still detects; the constructed instance
  // is stashed on the app (see {@link anomalyEngines}) so a scheduler — or a
  // test — can `warm()`/`observe()` through the ONE engine the app built.
  if (m4.anomaly !== undefined) {
    const engine = new AnomalyEngine({
      detectors: m4.anomaly.detectors,
      emit: m4.anomaly.notify,
      series: m4.anomaly.series,
      now: m4.anomaly.now,
      warmWindowMs: m4.anomaly.warmWindowMs,
    });
    const registry = anomalyEngines(app);
    registry.set(m4.anomaly, engine);
  }

  // --- External poll (A31) --------------------------------------------------
  // Polling writes telemetry, so it is mounted only behind an `authorize` seam
  // — exactly like the integration `/test` — and refuses an anonymous trigger.
  if (m4.external !== undefined && m4.external.authorize !== undefined) {
    const external = m4.external;
    const route = external.route ?? "/v1/external/poll";
    app.post(route, async (c) => {
      if (!(await external.authorize!(c))) {
        return c.json({ error: "unauthorized", message: "polling requires authorization" }, 401);
      }
      const deps = {
        fetch: external.fetch,
        cursor: external.cursor,
        sink: external.sink,
        now: external.now,
      };
      const results: PollResult[] = [];
      for (const source of external.sources) {
        results.push(await pollSource(source, deps));
      }
      const ingested = results.reduce((sum, r) => sum + r.ingested, 0);
      return c.json({ ingested, results }, 200);
    });
  }
}

/** Is every own enumerable value of `value` a string? Narrows to a string record. */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

/** Is `value` a non-array object (the shape `config` / `scope` / `secret` take)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// M4 — the constructed anomaly engine registry
// ---------------------------------------------------------------------------

/**
 * The anomaly engines {@link createApp} built, keyed by the group it built them
 * from, attached to the returned app under a symbol.
 *
 * The engine is real state the app owns (detectors accumulate rolling windows as
 * readings arrive), so a scheduler — or a test — must reach the SAME instance
 * the app wired, not a reconstruction. A symbol-keyed sidecar keeps the `App`
 * type a plain Hono while still exposing the one object that carries the hook.
 */
const ANOMALY_ENGINES = Symbol.for("insight.m4.anomalyEngines");

/** The app's anomaly-engine sidecar, created on first use. */
function anomalyEngines(app: App): Map<unknown, AnomalyEngine> {
  const holder = app as App & { [ANOMALY_ENGINES]?: Map<unknown, AnomalyEngine> };
  const existing = holder[ANOMALY_ENGINES];
  if (existing !== undefined) return existing;
  const created = new Map<unknown, AnomalyEngine>();
  holder[ANOMALY_ENGINES] = created;
  return created;
}

/**
 * The {@link AnomalyEngine} a composed app built for the given anomaly group —
 * the SAME instance whose `emit` the app wired to `notify`.
 *
 * Returns `undefined` when the app was not composed with that group. A caller
 * keeps the group object it passed to `createApp` and hands it back here.
 */
export function anomalyEngineFor(
  app: App,
  group: NonNullable<NonNullable<AppDeps["m4"]>["anomaly"]>,
): AnomalyEngine | undefined {
  return anomalyEngines(app).get(group);
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

  // M4 groups are optional, but a *supplied* one must be structurally sound —
  // the same "fail loudly at the edge, not silently degrade" rule. Only the
  // groups whose absence would mount an unsafe or broken surface are checked.
  check(
    deps?.m3?.deviceImport === undefined ||
      typeof deps.m3.deviceImport.deps?.imports?.importDevices === "function",
    "m3.deviceImport.deps.imports",
  );
  check(
    deps?.m3?.deviceImport === undefined ||
      typeof deps.m3.deviceImport.credentials?.sessions === "function",
    "m3.deviceImport.credentials",
  );
  check(
    deps?.m4?.mcp === undefined || (typeof deps.m4.mcp.tools === "object" && deps.m4.mcp.tools !== null),
    "m4.mcp.tools",
  );
  check(
    deps?.m4?.mcp === undefined || typeof deps.m4.mcp.gate?.verifyToken === "function",
    "m4.mcp.gate.verifyToken",
  );
  check(
    deps?.m4?.integrations === undefined || typeof deps.m4.integrations.transport?.send === "function",
    "m4.integrations.transport",
  );
  check(
    deps?.m4?.external === undefined || typeof deps.m4.external.fetch === "function",
    "m4.external.fetch",
  );

  if (missing.length > 0) {
    throw new TypeError(`createApp: missing required dependency: ${missing.join(", ")}`);
  }
}

export default createApp;
