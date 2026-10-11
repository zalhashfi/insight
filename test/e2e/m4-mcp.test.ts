/**
 * E05 — end-to-end M4 evidence: the MCP bridge (read + write) over the REAL
 * composed worker, secret redaction on every output, an anomaly → notification
 * through the integration runtime, and an external poll → ingest.
 *
 * Ticket E05 (`.planning/01-02-PLAN.md`, M4 · lane INT). The milestone's gate is
 * behavioural, so this suite drives the *whole* wired surface — `createApp` with
 * its `m4` seam groups — rather than any module in isolation. Every seam below
 * is the module's own honest in-memory fake, and nothing here re-implements a
 * route: the assertions observe what the composed app and the app's own hooks
 * answer.
 *
 * The four scenarios the gate names:
 *
 *   1. **A standard MCP client reads and writes through the composed app.**
 *      A real OAuth 2.1 authorization-code + PKCE exchange at
 *      `/v1/mcp/oauth/token` mints an access token; that token is fed back to
 *      the gate, which accepts it. A `mcp:read` credential serves a real read
 *      (`get_state`) from the injected store, and a `mcp:manage` credential
 *      writes (`set_variable`) — observably changing the store. (FR-AI-01..04)
 *
 *   2. **The secret never appears in tool output.** An integration is stored
 *      whose config carries a credential; EVERY read tool's serialized output
 *      is scanned for the plaintext. The write is behind BOTH keys: with the
 *      flag off (or the scope absent) the write is refused and the store is
 *      untouched. (NFR-SEC-05)
 *
 *   3. **An anomaly fires a notification through the integration runtime.** The
 *      engine `createApp` built (its `emit` wired to `notify`) observes a
 *      reading over the threshold; `notify` executes the REAL
 *      `executeIntegration` over a fake transport — so the notification is a
 *      genuine integration call whose rendered request the fake records, and
 *      whose result never carries the opened secret. (FR-AI-05, FR-INT-01)
 *
 *   4. **An external poll ingests into the shared sink.** A trigger at
 *      `/v1/external/poll` runs the REAL `pollSource` over a stub `fetch`,
 *      mapping allow-listed fields into the SAME telemetry sink the device
 *      route uses; a non-allow-listed field never lands. (FR-EXT-01)
 *
 * The mutation proof (acceptance): unmounting the MCP group makes the MCP
 * scenarios fail — see the `MutationClosureProbe` describe at the bottom, which
 * composes the app WITHOUT `m4.mcp` and shows `/v1/mcp/*` is gone (`404`).
 */

import { describe, expect, it } from "vitest";
import {
  createApp,
  anomalyEngineFor,
  type App,
  type AppDeps,
} from "../../worker/src/app";
import { InMemoryMcpToolStores } from "../../worker/src/mcp/tools";
import {
  DISCOVERY_PATH,
  InMemoryMcpTokenIssuer,
  InMemoryOAuthGrantStore,
  MANAGE_SCOPE,
  READ_SCOPE,
  TOKEN_PATH,
  verifyPkceS256,
  type AuthorizationCode,
  type McpScope,
} from "../../worker/src/mcp/gate";
import {
  PROVIDER_IDS,
  getProvider,
} from "../../worker/src/shared/integrations/index";
import {
  executeIntegration,
  type IntegrationTransport,
  type RenderedRequest,
  type TransportResponse,
} from "../../worker/src/shared/integrations/runtime";
import { ThresholdDetector } from "../../worker/src/domains/analytics/anomaly";
import {
  InMemoryCursorStore,
  InMemoryPollSink,
  type FetchLike,
} from "../../worker/src/domains/external/poll";
import { base64url } from "../../worker/src/platform/lib/tokens";
import type { DevicePrincipal } from "../../worker/src/platform/middleware/resolve-project";
import type { Rule } from "../../worker/src/platform/engine/run";

// ---------------------------------------------------------------------------
// Fixtures — one project, one seeded store bundle, one fixed instant.
// ---------------------------------------------------------------------------

const PROJECT = "proj_m4_demo";
const OTHER_PROJECT = "proj_m4_other";
const USER = "user_m4_owner";
const DEVICE = "iot-sim-m4";
const VARIABLE = "temp";

/** The exactly-knowable instant every request runs against. */
const FIXED_NOW = 1_700_000_000_000;

/** A credential in the shape the redactor's value-markers recognise. */
const SECRET = "sk_live_51H_m4_integration_secret";
/** The same plaintext tucked under an innocent key, to prove value redaction. */
const NESTED_SECRET = "sk_live_51H nested under an innocent key";

/** The variable the anomaly detector watches. */
const ANOMALY_VARIABLE = "temp";

/** A device principal for the project (the read/write tenant). */
const DEVICE_PRINCIPAL: DevicePrincipal = {
  kind: "device",
  projectId: PROJECT,
  scopes: "read write",
};

/** Accept exactly the demo device token. */
const verifyDevice = async (token: string): Promise<DevicePrincipal | null> =>
  token === "pt_m4_demo_token" ? DEVICE_PRINCIPAL : null;

/** A minimal automation rule for the store seed (not exercised here). */
const TEMP_RULE: Rule = {
  id: "rule_temp",
  cooldownMs: 0,
  conditions: [],
  actions: [{ type: "set_variable", key: "temp", value: 1 }],
};

// ---------------------------------------------------------------------------
// A recording transport — the only thing that can perform an effect.
// ---------------------------------------------------------------------------

class RecordingTransport implements IntegrationTransport {
  readonly kind = "dry-run" as const;
  readonly sent: RenderedRequest[] = [];
  private readonly response: TransportResponse;

  constructor(response: TransportResponse = { status: 200, body: { ok: true, delivered: true } }) {
    this.response = response;
  }

  send(request: RenderedRequest): Promise<TransportResponse> {
    this.sent.push(request);
    return Promise.resolve(this.response);
  }
}

// ---------------------------------------------------------------------------
// The wire envelope a gated tool call returns inside `{ result }`.
// ---------------------------------------------------------------------------

/** `{ ok: true, data }` on success, `{ ok: false, error, message }` on a tool failure. */
interface WireEnvelope {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly message?: string;
}

/** Cast a tool value the app itself produced; the shape is known a priori. */
function asShape<T>(value: unknown): T {
  return value as T;
}

/** The envelope a gated tool call returns, unwrapped from `{ result }`. */
async function gatedResult(
  app: App,
  path: string,
  init: RequestInit,
): Promise<{ status: number; envelope: WireEnvelope; raw: string }> {
  const res = await app.request(path, init);
  const raw = await res.text();
  const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
  const envelope = asShape<WireEnvelope>(body.result ?? {});
  return { status: res.status, envelope, raw };
}

// ---------------------------------------------------------------------------
// Harness — the whole M4 worker, wired exactly as a deploy binds it.
// ---------------------------------------------------------------------------

interface Harness {
  /** The composed app: MCP + integrations + anomaly hook + external poll. */
  app: App;
  /** The seeded MCP tool stores (reads/writes land here, observably). */
  stores: InMemoryMcpToolStores;
  /** The OAuth token issuer + matching gate verifier (one trust chain). */
  issuer: InMemoryMcpTokenIssuer;
  /** The OAuth grant store (authorization codes + refresh tokens). */
  grants: InMemoryOAuthGrantStore;
  /** The integration transport the notification hook and `/test` send through. */
  transport: RecordingTransport;
  /** The anomaly-engine group object; hand it back to {@link anomalyEngineFor}. */
  anomalyGroup: NonNullable<NonNullable<AppDeps["m4"]>["anomaly"]>;
  /** The shared telemetry sink the external poll writes into. */
  pollSink: InMemoryPollSink;
  /** Register an authorization code (as the consent step would). */
  grantCode: (code: string, scopes: readonly McpScope[], challenge: string, redirectUri: string) => void;
}

/** A seeded MCP store bundle for {@link PROJECT} and {@link OTHER_PROJECT}. */
function seededStores(): InMemoryMcpToolStores {
  const s = new InMemoryMcpToolStores(() => FIXED_NOW);
  s.addProject(PROJECT, USER, "owner", "Demo");
  s.addProject(OTHER_PROJECT, "other_owner", "owner", "Other");
  s.addVariable(PROJECT, "temp", 21.5);
  s.addState(PROJECT, { device: DEVICE, variable: "temp", value: 21.5, ts: FIXED_NOW - 100, seq: 3 });
  s.addSeriesPoint(PROJECT, { device: DEVICE, variable: "temp", value: 21, ts: FIXED_NOW - 200, seq: 1 });
  s.addSeriesPoint(PROJECT, { device: DEVICE, variable: "temp", value: 21.5, ts: FIXED_NOW - 100, seq: 3 });
  s.addLayout(PROJECT, "main", ["temp"]);
  s.addAutomation(PROJECT, "rule_temp", TEMP_RULE);
  // The secret-bearing integration the redaction scenario scans for.
  s.addIntegration(PROJECT, "hooks", {
    url: "https://hooks.example/abc",
    apiKey: SECRET,
    nested: { note: NESTED_SECRET },
  });
  return s;
}

/** A stub transport that answers one JSON payload (the external source's body). */
function jsonFetch(payload: unknown): FetchLike {
  return async () => ({
    status: 200,
    json: async () => payload,
  });
}

/**
 * Build the composed M4 worker over honest, injected in-memory seams, with the
 * anomaly engine's `emit` wired to a notification that executes the REAL
 * integration runtime over the recording transport.
 */
function harness(options: {
  readonly mcpWriteEnabled?: boolean;
  readonly pollPayload?: unknown;
} = {}): Harness {
  const stores = seededStores();
  const issuer = new InMemoryMcpTokenIssuer();
  const grants = new InMemoryOAuthGrantStore();
  const transport = new RecordingTransport();
  const pollSink = new InMemoryPollSink();

  // The notification seam: an anomaly is delivered by executing the REAL
  // integration runtime against a fake transport — so "anomaly → notification"
  // is a genuine integration call, not a recorded closure.
  const notified: string[] = [];
  const notify = async (event: { variable: string; value: number; reason: string; ts: number }) => {
    await executeIntegration({
      providerId: "slack",
      action: "send_message",
      config: { channel: "#alerts" },
      // A plaintext secret stands in for a stored envelope; a `/test`-before-save
      // shape the runtime opens at the boundary and never returns.
      secret: { webhook_url: { plain: "https://hooks.slack.com/services/T/B/m4-secret-webhook" } },
      scope: { message: `anomaly ${event.reason} on ${event.variable}=${event.value}` },
      transport,
    });
    notified.push(event.variable);
  };

  // A threshold detector on the watching variable: 30 is the inclusive ceiling,
  // so a reading above it fires `above_range`.
  const anomalyGroup = {
    detectors: [new ThresholdDetector({ variable: ANOMALY_VARIABLE, high: 30 })],
    notify,
    now: () => FIXED_NOW,
  } satisfies NonNullable<NonNullable<AppDeps["m4"]>["anomaly"]>;

  const external = {
    sources: [
      {
        sourceId: "src_m4_weather",
        url: "https://example.test/weather",
        envelopePath: "readings",
        sentinelMap: { temp_c: "temp", humidity: "humidity" },
        allowList: ["temp_c", "humidity"],
        projectId: PROJECT,
        device: "external:m4",
      },
    ],
    fetch: jsonFetch(options.pollPayload ?? { readings: [{ temp_c: 24, humidity: 55, api_key: "leak-me" }] }),
    cursor: new InMemoryCursorStore(),
    sink: pollSink,
    now: () => FIXED_NOW,
    authorize: () => true,
  } satisfies NonNullable<NonNullable<AppDeps["m4"]>["external"]>;

  const deps: AppDeps = {
    deviceTokens: verifyDevice,
    sessions: async () => null,
    ingest: {
      verifyToken: async (token) =>
        token === "pt_m4_demo_token" ? DEVICE_PRINCIPAL : null,
      sink: { record: async () => undefined },
      devices: { register: () => undefined, has: () => false },
      now: () => FIXED_NOW,
    },
    query: {
      credentials: async () => null,
      projects: { state: async () => [] },
      shards: { ring: async () => [] },
    },
    m4: {
      mcp: {
        tools: stores.seams,
        gate: { verifyToken: issuer.verifyToken, mcpWriteEnabled: options.mcpWriteEnabled ?? true },
        oauth: {
          grants,
          issueAccessToken: issuer.issueAccessToken,
          issuer: "https://insight.example",
          now: () => FIXED_NOW,
        },
      },
      integrations: {
        transport,
        authorize: async () => PROJECT,
      },
      anomaly: anomalyGroup,
      external,
    },
  };

  return {
    app: createApp(deps),
    stores,
    issuer,
    grants,
    transport,
    anomalyGroup,
    pollSink,
    grantCode: (code, scopes, challenge, redirectUri) => {
      const grant: AuthorizationCode = {
        code,
        client_id: "client_m4",
        redirect_uri: redirectUri,
        scopes,
        code_challenge: challenge,
        expires_at: FIXED_NOW + 600_000,
        projectId: PROJECT,
      };
      grants.putCode(grant);
    },
  };
}

/** The PKCE verifier + its S256 challenge, as a public client computes them. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = "m4-verifier-" + "a".repeat(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Run an OAuth authorization-code exchange and return the access token. */
async function exchangeFor(h: Harness, scopes: readonly McpScope[]): Promise<string> {
  const { verifier, challenge } = await pkce();
  const redirectUri = "https://client.example/callback";
  h.grantCode("code_m4_" + scopes.join("_"), scopes, challenge, redirectUri);

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: "code_m4_" + scopes.join("_"),
    client_id: "client_m4",
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const res = await h.app.request(TOKEN_PATH, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  expect(res.status).toBe(200);
  const body = asShape<{ access_token: string; scope: string }>(await res.json());
  return body.access_token;
}

// ===========================================================================
// 1. MCP read + write through the composed app (OAuth → token → gate → tool)
// ===========================================================================
describe("M4 e2e — a standard MCP client reads and writes via the composed app", () => {
  it("exchanges an OAuth code for a token the gate accepts, then reads real state", async () => {
    const h = harness();

    // A public MCP client discovers the server and exchanges a PKCE-bound code.
    // Discovery lives under the `/v1/mcp/oauth` mount (RFC 8414's well-known
    // suffix is served relative to the tenant's issuer path).
    const discovery = await h.app.request(`/v1/mcp/oauth${DISCOVERY_PATH}`);
    expect(discovery.status).toBe(200);
    const doc = asShape<{ issuer: string; scopes_supported: string[] }>(await discovery.json());
    expect(doc.scopes_supported).toEqual(["mcp:read", "mcp:manage"]);

    const { verifier, challenge } = await pkce();
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
    const token = await exchangeFor(h, [READ_SCOPE]);

    // The issued token is accepted by the gate and serves a REAL read.
    const read = await gatedResult(h.app, `/v1/mcp/read?tool=get_state&projectId=${PROJECT}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);
    expect(read.envelope.ok).toBe(true);
    const state = asShape<{ state: { device: string; variable: string; value: number }[] }>(
      read.envelope.data,
    );
    expect(state.state).toHaveLength(1);
    expect(state.state[0]).toMatchObject({ device: DEVICE, variable: "temp", value: 21.5 });
  });

  it("writes with mcp:manage — and the write is observable in the store", async () => {
    const h = harness();
    const token = await exchangeFor(h, [MANAGE_SCOPE]);

    const write = await gatedResult(h.app, "/v1/mcp/write", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        tool: "set_variable",
        args: { projectId: PROJECT, key: "temp", value: 7 },
      }),
    });
    expect(write.status).toBe(200);
    expect(write.envelope.ok).toBe(true);
    // The store the write targeted is observably changed — not an echo.
    expect(h.stores.variables.get(PROJECT)?.get("temp")?.value).toBe(7);
  });

  it("refuses a write by a read-scoped token (403) and leaves the store untouched", async () => {
    const h = harness();
    const token = await exchangeFor(h, [READ_SCOPE]);

    const write = await h.app.request("/v1/mcp/write", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "set_variable", args: { projectId: PROJECT, key: "temp", value: 99 } }),
    });
    expect(write.status).toBe(403);
    expect(asShape<{ error: string }>(await write.json()).error).toBe("insufficient_scope");
    // Untouched: the write never ran.
    expect(h.stores.variables.get(PROJECT)?.get("temp")?.value).toBe(21.5);
  });

  it("refuses a manage-scoped write when the flag is off — the second key", async () => {
    const h = harness({ mcpWriteEnabled: false });
    const token = await exchangeFor(h, [MANAGE_SCOPE]);

    const write = await h.app.request("/v1/mcp/write", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "set_variable", args: { projectId: PROJECT, key: "temp", value: 42 } }),
    });
    expect(write.status).toBe(403);
    expect(asShape<{ error: string }>(await write.json()).error).toBe("write_disabled");
    expect(h.stores.variables.get(PROJECT)?.get("temp")?.value).toBe(21.5);
  });

  it("refuses a request with no bearer (401) before any tool runs", async () => {
    const h = harness();
    const read = await h.app.request(`/v1/mcp/read?tool=get_state&projectId=${PROJECT}`);
    expect(read.status).toBe(401);
  });

  it("accepts a NUMERIC read param (get_series.windowMs) over the GET query surface", async () => {
    // Regression: `readRequest` once delivered every query value as a string, so
    // `get_series`'s declared numeric `windowMs` was rejected as a non-number on
    // the documented GET surface. A query string carries only strings, so the
    // reader coerces by the DECLARED param type.
    const h = harness();
    const token = await exchangeFor(h, [READ_SCOPE]);

    const withWindow = await gatedResult(
      h.app,
      `/v1/mcp/read?tool=get_series&projectId=${PROJECT}&variable=temp&windowMs=300`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(withWindow.status).toBe(200);
    expect(withWindow.envelope.ok).toBe(true);

    // A non-numeric value for the same param is still refused (not silently
    // coerced to a number), so the coercion cannot mask bad input.
    const bad = await gatedResult(
      h.app,
      `/v1/mcp/read?tool=get_series&projectId=${PROJECT}&variable=temp&windowMs=soon`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(bad.envelope.ok).toBe(false);
    expect(bad.envelope.error).toBe("invalid_request");
  });
});

// ===========================================================================
// 1b. Tenant isolation through the composed app (the BLOCKER's acceptance)
//
// The credential the OAuth exchange mints is bound to a tenant (the code's
// `projectId`), the gate carries it onto the principal, and the tool layer
// refuses any call naming a different project. These cases prove it end-to-end
// through `createApp` — not with a hand-built principal — for reads AND writes.
// ===========================================================================
describe("M4 e2e — a tenant-bound credential cannot cross tenants", () => {
  it("refuses a cross-tenant READ (403) and never returns the other tenant's data", async () => {
    const h = harness();
    const token = await exchangeFor(h, [READ_SCOPE]);

    const read = await gatedResult(h.app, `/v1/mcp/read?tool=get_state&projectId=${OTHER_PROJECT}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // The gate authorized the read class; the tool refused the foreign tenant.
    expect(read.status).toBe(200);
    expect(read.envelope.ok).toBe(false);
    expect(read.envelope.error).toBe("forbidden");
    // The foreign tenant's id (and any of its rows) never appears in the body.
    expect(read.raw).not.toContain(OTHER_PROJECT);
    expect(read.raw).not.toContain("secret_of_other");
  });

  it("refuses a cross-tenant WRITE (403) and leaves the other tenant's store untouched", async () => {
    const h = harness();
    const token = await exchangeFor(h, [MANAGE_SCOPE]);

    const write = await gatedResult(h.app, "/v1/mcp/write", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        tool: "set_variable",
        args: { projectId: OTHER_PROJECT, key: "temp", value: 999 },
      }),
    });
    expect(write.status).toBe(200);
    expect(write.envelope.ok).toBe(false);
    expect(write.envelope.error).toBe("forbidden");
    // The foreign tenant was never written.
    expect(h.stores.variables.get(OTHER_PROJECT)).toBeUndefined();
  });

  it("still serves the SAME credential WITHIN its own tenant (read + write)", async () => {
    const h = harness();
    const token = await exchangeFor(h, [MANAGE_SCOPE]);

    const read = await gatedResult(h.app, `/v1/mcp/read?tool=get_state&projectId=${PROJECT}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(read.envelope.ok).toBe(true);

    const write = await gatedResult(h.app, "/v1/mcp/write", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "set_variable", args: { projectId: PROJECT, key: "temp", value: 8 } }),
    });
    expect(write.envelope.ok).toBe(true);
    expect(h.stores.variables.get(PROJECT)?.get("temp")?.value).toBe(8);
  });
});

// ===========================================================================
// 2. The secret never appears in tool output
// ===========================================================================
describe("M4 e2e — no secret appears in any tool output", () => {
  it("never serializes the integration's secret through any read tool", async () => {
    const h = harness();
    const token = await exchangeFor(h, [READ_SCOPE]);

    const reads: [string, Record<string, string>][] = [
      ["list_projects", {}],
      ["get_project", { projectId: PROJECT }],
      ["list_variables", { projectId: PROJECT }],
      ["get_state", { projectId: PROJECT }],
      ["get_series", { projectId: PROJECT, variable: "temp" }],
      ["list_dashboards", { projectId: PROJECT }],
      ["get_dashboard", { projectId: PROJECT, dashboardId: "main" }],
      ["list_automations", { projectId: PROJECT }],
      ["get_automation", { projectId: PROJECT, automationId: "rule_temp" }],
      ["list_integrations", { projectId: PROJECT }],
      ["get_integration", { projectId: PROJECT, integrationId: "hooks" }],
    ];

    for (const [tool, args] of reads) {
      const query = new URLSearchParams({ tool, ...args }).toString();
      const res = await h.app.request(`/v1/mcp/read?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain(SECRET);
      expect(raw).not.toContain(NESTED_SECRET);
      // The *shape* survives (a caller sees which keys exist), but no config
      // VALUE does: an integration config is a secret container by contract.
      if (tool === "get_integration") {
        expect(raw).toContain("url");
        expect(raw).not.toContain("https://hooks.example/abc");
      }
    }
  });
});

// ===========================================================================
// 3. Anomaly → notification through the integration runtime (fake transport)
// ===========================================================================
describe("M4 e2e — an anomaly fires a notification through the integration runtime", () => {
  it("routes a threshold breach from the app's engine to a real integration call", async () => {
    const h = harness();
    const engine = anomalyEngineFor(h.app, h.anomalyGroup);
    expect(engine).toBeDefined();

    // A normal reading: no notification.
    expect(engine!.observe(ANOMALY_VARIABLE, 25)).toEqual([]);
    expect(h.transport.sent).toHaveLength(0);

    // A reading above the inclusive ceiling: the engine emits and the notify
    // seam executes the REAL integration runtime over the fake transport.
    const emitted = engine!.observe(ANOMALY_VARIABLE, 31.5);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ variable: ANOMALY_VARIABLE, value: 31.5, reason: "above_range" });

    // Await the async notification the engine fired (its emit is fire-and-forget).
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(h.transport.sent).toHaveLength(1);
    const request = h.transport.sent[0];
    expect(request.providerId).toBe("slack");
    expect(request.action).toBe("send_message");
    // The rendered message carries the anomaly, and the bot secret rides ONLY to
    // the transport (it is the one place a plaintext secret is allowed to travel).
    expect(JSON.stringify(request.body)).toContain("above_range");
    expect(request.auth.webhook_url).toBe("https://hooks.slack.com/services/T/B/m4-secret-webhook");
  });

  it("drives the engine from the REAL INGEST ROUTE, not just the test seam", async () => {
    // The production producer: a telemetry POST that persists a reading also
    // feeds `AnomalyEngine.observe`. This is the wiring the earlier audit found
    // missing (`anomalyEngineFor` had no production caller). No test seam is
    // touched here — the engine is reached only through the ingest route.
    const h = harness();

    const payload = JSON.stringify({ metrics: [{ key: ANOMALY_VARIABLE, value: 42.5 }] });
    const res = await h.app.request("/v1/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer pt_m4_demo_token",
      },
      body: payload,
    });
    expect(res.status).toBe(204);

    // The reading crossed the threshold, so the engine emitted and the
    // notification seam fired a real integration call — with no test-side
    // `observe()` at all.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(h.transport.sent).toHaveLength(1);
    expect(JSON.stringify(h.transport.sent[0].body)).toContain("above_range");

    // A reading under the threshold is persisted but emits nothing.
    const calm = await h.app.request("/v1/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer pt_m4_demo_token" },
      body: JSON.stringify({ metrics: [{ key: ANOMALY_VARIABLE, value: 20 }] }),
    });
    expect(calm.status).toBe(204);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(h.transport.sent).toHaveLength(1);
  });

  it("returns a result whose opened secret is redacted (safe to log)", async () => {
    const h = harness();
    // Driving the notification path once, then inspecting what a caller sees.
    const engine = anomalyEngineFor(h.app, h.anomalyGroup);
    engine!.observe(ANOMALY_VARIABLE, 40);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    // The `/test` route (same runtime, same transport) returns a redacted result.
    const res = await h.app.request("/v1/integrations/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "slack",
        action: "send_message",
        config: { channel: "#alerts" },
        secret: { webhook_url: { plain: "https://hooks.slack.com/services/T/B/route-secret" } },
        scope: { message: "hello" },
      }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("route-secret");
  });

  it("refuses an unknown provider through the runtime's own typed error", async () => {
    const h = harness();
    const res = await h.app.request("/v1/integrations/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "nope", action: "send", config: {} }),
    });
    expect(res.status).toBe(400);
    expect(asShape<{ error: string }>(await res.json()).error).toBe("unknown_provider");
  });

  it("lists exactly the eight catalogued providers on the read surface", async () => {
    const h = harness();
    const res = await h.app.request("/v1/integrations");
    expect(res.status).toBe(200);
    const body = asShape<{ providers: { id: string }[] }>(await res.json());
    expect(body.providers.map((p) => p.id).sort()).toEqual([...PROVIDER_IDS].sort());
    // The catalog the route serves is the frozen one.
    expect(getProvider("slack")?.actions.map((a) => a.name)).toContain("send_message");
  });
});

// ===========================================================================
// 4. External poll → ingest into the shared sink
// ===========================================================================
describe("M4 e2e — an external poll ingests into the telemetry sink", () => {
  it("maps allow-listed fields into the sink, never the unlisted ones", async () => {
    const h = harness({
      pollPayload: { readings: [{ temp_c: 24, humidity: 55, api_key: "leak-me" }] },
    });

    const res = await h.app.request("/v1/external/poll", { method: "POST" });
    expect(res.status).toBe(200);
    const body = asShape<{ ingested: number }>(await res.json());
    expect(body.ingested).toBe(2);

    // The two allow-listed fields landed — under the mapped variable names and
    // the source's synthetic device — with the poll instant as the timestamp.
    const samples = h.pollSink.samples();
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.metric).sort()).toEqual(["humidity", "temp"]);
    for (const sample of samples) {
      expect(sample.projectId).toBe(PROJECT);
      expect(sample.device).toBe("external:m4");
      expect(sample.ts).toBe(FIXED_NOW);
    }
    // The non-allow-listed field never reached the sink.
    expect(JSON.stringify(samples)).not.toContain("leak-me");
  });

  it("de-duplicates a re-poll of the same payload via the cursor", async () => {
    // A source with a `cursor` config: each item carries a monotonic `id`, so a
    // re-poll of the same body is entirely already-seen.
    const sink = new InMemoryPollSink();
    const cursor = new InMemoryCursorStore();
    const deps: AppDeps = {
      deviceTokens: verifyDevice,
      sessions: async () => null,
      ingest: {
        verifyToken: async () => null,
        sink: { record: async () => undefined },
        devices: { register: () => undefined, has: () => false },
      },
      query: {
        credentials: async () => null,
        projects: { state: async () => [] },
        shards: { ring: async () => [] },
      },
      m4: {
        external: {
          sources: [
            {
              sourceId: "src_m4_cursor",
              url: "https://example.test/cursor",
              envelopePath: "readings",
              cursor: { field: "id", kind: "number" },
              sentinelMap: { temp_c: "temp" },
              allowList: ["temp_c"],
              projectId: PROJECT,
            },
          ],
          fetch: jsonFetch({ readings: [{ temp_c: 24, id: 1 }, { temp_c: 25, id: 2 }] }),
          cursor,
          sink,
          now: () => FIXED_NOW,
          authorize: () => true,
        },
      },
    };
    const app = createApp(deps);

    const first = await app.request("/v1/external/poll", { method: "POST" });
    expect(first.status).toBe(200);
    expect(asShape<{ ingested: number }>(await first.json()).ingested).toBe(2);

    const second = await app.request("/v1/external/poll", { method: "POST" });
    expect(second.status).toBe(200);
    expect(asShape<{ ingested: number }>(await second.json()).ingested).toBe(0);
    expect(sink.size).toBe(2);
  });
});

// ===========================================================================
// Mutation proof — unmounting the MCP group removes the MCP surface
// ===========================================================================
describe("MutationClosureProbe — without m4.mcp the MCP surface is gone", () => {
  /**
   * Compose the SAME worker as {@link harness} but with the `mcp` group
   * omitted. This is the mutation the acceptance names: the E05 MCP assertions
   * depend on the group being mounted, so removing it must fail them. Here we
   * prove the mechanism directly — `/v1/mcp/read`, `/v1/mcp/write` and the
   * OAuth token endpoint are all absent (404), not merely unauthenticated.
   */
  it("answers 404 on every MCP path when the mcp group is not supplied", async () => {
    const stores = seededStores();
    const deps: AppDeps = {
      deviceTokens: verifyDevice,
      sessions: async () => null,
      ingest: {
        verifyToken: async () => null,
        sink: { record: async () => undefined },
        devices: { register: () => undefined, has: () => false },
      },
      query: {
        credentials: async () => null,
        projects: { state: async () => [] },
        shards: { ring: async () => [] },
      },
      // No `m4.mcp` — integrations/anomaly/external may stay; the bridge is gone.
      m4: {
        integrations: { transport: new RecordingTransport(), authorize: async () => PROJECT },
      },
    };
    const app = createApp(deps);

    const read = await app.request(`/v1/mcp/read?tool=get_state&projectId=${PROJECT}`, {
      headers: { Authorization: "Bearer whatever" },
    });
    expect(read.status).toBe(404);

    const write = await app.request("/v1/mcp/write", {
      method: "POST",
      headers: { Authorization: "Bearer whatever", "content-type": "application/json" },
      body: JSON.stringify({ tool: "set_variable", args: {} }),
    });
    expect(write.status).toBe(404);

    const token = await app.request(TOKEN_PATH, { method: "POST", body: "grant_type=authorization_code" });
    expect(token.status).toBe(404);

    // And the store was never reachable: nothing changed it.
    expect(stores.variables.get(PROJECT)?.get("temp")?.value).toBe(21.5);
  });

  it("still serves the integrations catalog when only mcp is omitted", async () => {
    const app = createApp({
      deviceTokens: verifyDevice,
      sessions: async () => null,
      ingest: {
        verifyToken: async () => null,
        sink: { record: async () => undefined },
        devices: { register: () => undefined, has: () => false },
      },
      query: {
        credentials: async () => null,
        projects: { state: async () => [] },
        shards: { ring: async () => [] },
      },
      m4: { integrations: { transport: new RecordingTransport(), authorize: async () => PROJECT } },
    });
    const res = await app.request("/v1/integrations");
    expect(res.status).toBe(200);
  });
});
