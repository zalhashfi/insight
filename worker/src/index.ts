/**
 * Insight Worker entry point.
 *
 * This file is the *edge*: it turns the runtime environment into the injected
 * dependency object {@link createApp} expects, and exports the resulting app.
 * All routing lives in `app.ts`; all behaviour lives in the domain modules.
 *
 * Exposed routes (composed in `app.ts`):
 *   GET  /healthz                                  -> 200 { "ok": true }
 *   GET  /v1/version                               -> { "name": "insight", "version": "0.0.1" }
 *   POST /v1/telemetry                             -> 204, or 400/401/403/413
 *   GET  /v1/projects/:proj/state                  -> 200 { "state": [...] }
 *   GET  /v1/projects/:proj/variables/:key/series  -> 200 { "series": [...] }
 *
 * The `app` is exported so tests can exercise the composed surface in-process
 * via `app.request("/healthz")` without a running server; `fetch` is exposed on
 * it too, so `export default app` serves as a Cloudflare Worker handler.
 *
 * ## Bindings are NOT faked here
 *
 * The production seams (D1-backed token/session lookups, the shard + project
 * Durable Objects, the device registry) are supplied by the deploy target. This
 * module intentionally does **not** stub them: an app that accepted telemetry
 * into a throwaway store would be a silent data-loss bug, not a convenience.
 * Instead, {@link BindingAdapters} names every seam a deploy must provide and
 * {@link buildDeps} assembles them into the {@link AppDeps} {@link createApp}
 * requires — so the binding owner has one documented place to inject the real
 * implementations, and nothing here ever invents one.
 *
 * Until those adapters are supplied, the module-level {@link app} is composed
 * from {@link unboundDeps}: routes exist and every credential seam denies
 * fail-closed (`401`), which is an honest "no bindings wired yet" state.
 */

import { createApp, type AppDeps, type VersionInfo } from "./app";
import type { DeviceTokenResolver, SessionResolver } from "./platform/middleware/resolve-project";
import type { VerifyToken } from "./domains/telemetry/telemetry";
import type { CredentialResolver } from "./domains/telemetry/query";

/**
 * Adapters from an environment (`env`) to {@link AppDeps}.
 *
 * Each field is the production implementation of one seam. They are passed in
 * by the caller that holds the bindings rather than constructed here, so this
 * module never has to guess at, or silently stand in for, a real binding:
 *
 *   - `deviceTokens`  — D1 adapter over `project_tokens` (SHA-256 hash lookup);
 *   - `sessions`      — D1 adapter over `sessions`;
 *   - `verifyToken`   — the ingest route's verifier, resolving a plaintext
 *                       token to a `DevicePrincipal` carrying its scopes;
 *   - `credentials`   — the read route's resolver, token -> project id;
 *   - `sink` / `devices` / `projects` / `shards` — the Durable Object and
 *                       registry seams the ingest and read routes write/read.
 */
export interface BindingAdapters {
  readonly deviceTokens: DeviceTokenResolver;
  readonly sessions: SessionResolver;
  readonly verifyToken: VerifyToken;
  readonly credentials: CredentialResolver;
  readonly ingest: AppDeps["ingest"];
  readonly query: AppDeps["query"];
  /** Advertised build identity; defaults to the skeleton's `0.0.1`. */
  readonly version?: VersionInfo;
}

/**
 * Build the injectable {@link AppDeps} from explicit binding adapters.
 *
 * Kept separate from {@link createApp} so the composition root (whoever holds
 * `env`) has one named place to construct the seams, and so tests can supply
 * in-memory adapters without a Worker runtime. Nothing here fabricates a
 * binding: every field must be supplied.
 */
export function buildDeps(adapters: BindingAdapters): AppDeps {
  return {
    deviceTokens: adapters.deviceTokens,
    sessions: adapters.sessions,
    ingest: {
      ...adapters.ingest,
      verifyToken: adapters.verifyToken,
    },
    query: {
      ...adapters.query,
      credentials: adapters.credentials,
    },
    version: adapters.version,
  };
}

/**
 * The composed app.
 *
 * Exported as a module-level value whose `fetch` is a valid Worker handler, so
 * `export default app` serves the routes above. Because the seams are injected
 * (and this module refuses to invent them), the concrete adapters are bound by
 * the deploy target before this value is used in production; `bun test` and
 * `app.request(...)` consume it directly with in-process wiring.
 */
export const app = createApp(unboundDeps());

/** The Worker handler: the composed app itself (Hono exposes `fetch`). */
export default app;

/**
 * The *unbound* dependency object used when no binding adapters are supplied.
 *
 * No token or session store is bound yet, so every credential seam resolves to
 * `null`; the middleware and both routers turn that into a fail-closed `401`.
 * This is an honest "not deployed with bindings" state — deliberately NOT a
 * stand-in store that would accept writes and lose them. A real deploy replaces
 * this default by building `createApp(buildDeps(adapters))` from its `env`.
 */
function unboundDeps(): AppDeps {
  return {
    deviceTokens: async () => null,
    sessions: async () => null,
    ingest: {
      // Refuses every token, so the sink and registry below are never reached.
      verifyToken: async () => null,
      sink: { record: async () => undefined },
      devices: { register: () => undefined, has: () => false },
      // An unbound deploy has no device-status store, so nothing is known to be
      // refused; the honest default is "treat unknown devices as ingestible"
      // (they would be auto-registered `active`) rather than inventing a store.
      ingestibility: { status: () => undefined },
    },
    query: {
      // Unbound stores read as unavailable; nothing is fabricated.
      credentials: async () => null,
      projects: { state: async () => [] },
      shards: { ring: async () => [] },
    },
  };
}
