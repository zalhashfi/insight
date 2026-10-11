/**
 * E2E composition smoke test — the *whole* M1 Worker, wired the way production
 * wires it.
 *
 * Unlike the per-unit suites (which drive one module behind a harness app),
 * this one exercises {@link createApp}: the real `securityHeaders` middleware,
 * the real `resolveDeviceProject` gate, and the real ingest/query routers, all
 * mounted together and driven in-process through `app.request(path)`. Nothing
 * is mocked here — every seam is a genuine module entry point, and the only
 * substitutions are the documented, injectable edges (an in-memory token store
 * and in-memory read stores), exactly as the contract intends.
 *
 * Assertions, in the order they appear:
 *   1. `securityHeaders()` is mounted on `*` and covers the composed surface —
 *      success, `401` and `404` alike;
 *   2. `/healthz` is `200 { ok: true }`;
 *   3. `/v1/version` reports the advertised identity;
 *   4. the telemetry ingest route is MOUNTED and is the sole authority on the
 *      ingest `401`: no credential, a non-Bearer credential, an unknown
 *      credential and a REVOKED credential are all the frozen
 *      `401 { error: "unauthorized" }` — never the middleware's
 *      `invalid_credential`;
 *   5. a valid project token flows all the way to the sink and is `204`, while
 *      a `read`-scoped token is refused the write with `403`;
 *   6. the read surface is fail-closed behind its own project gate.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_VERSION, createApp, type App, type AppDeps } from "../worker/src/app";
import { InMemoryTokenRepo } from "../worker/src/domains/identity/tokens";
import {
  InMemoryTelemetrySink,
  type DeviceIngestibilityGate,
  type DeviceRegistry,
  type IngestRateLimiter,
  type RecordedSample,
} from "../worker/src/domains/telemetry/telemetry";
import { RateLimiter, type RateLimitPolicy } from "../worker/src/domains/telemetry/rate-limit";
import {
  InMemoryCredentials,
  InMemoryProjectLookup,
  InMemoryShards,
} from "../worker/src/domains/telemetry/query";
import { hashToken, TOKEN_PREFIX } from "../worker/src/platform/lib/tokens";
import { SECURITY_HEADERS } from "../worker/src/platform/middleware/security-headers";
import type {
  CredentialLookupResult,
  DevicePrincipal,
} from "../worker/src/platform/middleware/resolve-project";

// ---------------------------------------------------------------------------
// Fixtures — one project, one hashed device token, honest in-memory seams
// ---------------------------------------------------------------------------

const PROJECT = "prj_alpha";
const OTHER_PROJECT = "prj_beta";
const DEVICE = "iot-sim-01";

/** A realistic-looking opaque project token (characters only; the value is arbitrary). */
const TOKEN = `${TOKEN_PREFIX}smoke_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
const FOREIGN_TOKEN = `${TOKEN_PREFIX}smoke_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
/** A real, resolvable token that grants `read` only — never a write. */
const READ_ONLY_TOKEN = `${TOKEN_PREFIX}smoke_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr`;
/** A real, resolvable token that has been revoked — present but unusable. */
const REVOKED_TOKEN = `${TOKEN_PREFIX}smoke_vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv`;
/** Well-formed and presented, but never stored — resolvable to nothing. */
const UNKNOWN_TOKEN = `${TOKEN_PREFIX}smoke_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz`;

const DEVICE_PRINCIPAL: DevicePrincipal = {
  kind: "device",
  projectId: PROJECT,
  tokenId: "tok_smoke",
};

interface Harness {
  readonly app: App;
  readonly sink: InMemoryTelemetrySink;
  readonly devices: DeviceRegistry & { has(p: string, d: string): boolean };
  readonly credentials: InMemoryCredentials;
  readonly registerCalls: { projectId: string; device: string; ts: number }[];
}

/**
 * Compose the app with in-memory seams that mirror production semantics:
 *
 *   - the token store holds a SHA-256 hash, never the plaintext (as D1 does),
 *     and the `verifyToken` seam resolves it back to a real `DevicePrincipal`;
 *   - the same token store backs BOTH the query resolver and the ingest
 *     verifier, so ingest and read agree on who the credential is;
 *   - the sink records every accepted `(projectId, device, metric, value, ts)`
 *     tuple, with `ts` from a pinned clock.
 */
async function harness(
  now = 1_700_000_000_000,
  options: {
    scopes?: string | null;
    rateLimiter?: IngestRateLimiter;
    rateLimit?: RateLimitPolicy;
    ingestibility?: DeviceIngestibilityGate;
  } = {},
): Promise<Harness> {
  // --- the credential store: hash-only, exactly like the D1 table -----------
  const tokens = new InMemoryTokenRepo();
  await tokens.insert({
    id: "tok_smoke",
    projectId: PROJECT,
    name: "smoke token",
    tokenHash: await hashToken(TOKEN),
    tokenPrefix: TOKEN.slice(0, 6),
    // `null` mints a token with NO scope string — the least-privilege
    // read-only default; omitted keeps the operational `read write` token.
    scopes: options.scopes === null ? null : (options.scopes ?? "read write"),
    expiresAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  // A second REAL token in the same project, but scoped `read` only: it
  // authenticates (so ingest must not answer `401`) yet the write gate refuses
  // it with `403`. This is the credential the acceptance criterion names.
  await tokens.insert({
    id: "tok_read_only",
    projectId: PROJECT,
    name: "read-only token",
    tokenHash: await hashToken(READ_ONLY_TOKEN),
    tokenPrefix: READ_ONLY_TOKEN.slice(0, 6),
    scopes: "read",
    expiresAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  // A REVOKED token: stored, so it is a *presented* credential the verifier
  // recognises and then rejects. Revocation must read as `unauthorized`, not
  // as a leak of why (it is the same `401` an unknown token gets).
  await tokens.insert({
    id: "tok_revoked",
    projectId: PROJECT,
    name: "revoked token",
    tokenHash: await hashToken(REVOKED_TOKEN),
    tokenPrefix: REVOKED_TOKEN.slice(0, 6),
    scopes: "read write",
    expiresAt: null,
    revokedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  /** Token resolver shared by the middleware and the ingest verifier. */
  const resolveDevice = async (presented: string): Promise<CredentialLookupResult> => {
    const hash = await hashToken(presented);
    const record = await tokens.findByHash(hash);
    if (record === null || record.revokedAt !== null) return null;
    return {
      kind: "device",
      projectId: record.projectId,
      tokenId: record.id,
      scopes: record.scopes,
    };
  };

  // The read routes' resolver returns only the tenant; a foreign token resolves
  // to a DIFFERENT project so a mismatch is observable, not a 401.
  const credentials = new InMemoryCredentials()
    .add(TOKEN, PROJECT)
    .add(FOREIGN_TOKEN, OTHER_PROJECT);

  const sink = new InMemoryTelemetrySink();
  const registerCalls: Harness["registerCalls"] = [];
  // Registry keyed by `projectId` -> set of device keys; a `Map` because the
  // key is a composite runtime value, not a static literal.
  const seen = new Map<string, Set<string>>();
  const devices: Harness["devices"] = {
    has: (projectId, device) => seen.get(projectId)?.has(device) ?? false,
    register: (projectId, device, ts) => {
      const forProject = seen.get(projectId) ?? new Set<string>();
      forProject.add(device);
      seen.set(projectId, forProject);
      registerCalls.push({ projectId, device, ts });
    },
  };

  const deps: AppDeps = {
    deviceTokens: resolveDevice,
    sessions: async () => null, // no user sessions in M1's device-facing slice
    ingest: {
      verifyToken: async (presented) => {
        const principal = await resolveDevice(presented);
        return principal?.kind === "device" ? principal : null;
      },
      sink,
      devices,
      now: () => now,
      // Optional seams, only set when a test asks for them, so the default
      // harness exercises the app's own composition (default rate limiter).
      ...(options.rateLimiter !== undefined ? { rateLimiter: options.rateLimiter } : {}),
      ...(options.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
      ...(options.ingestibility !== undefined ? { ingestibility: options.ingestibility } : {}),
    },
    query: {
      credentials: credentials.resolver,
      projects: new InMemoryProjectLookup().set(PROJECT, [
        { device: DEVICE, variable: "temp", value: 25.4, ts: now, seq: 1 },
      ]),
      shards: new InMemoryShards(),
      now: () => now,
    },
  };

  return { app: createApp(deps), sink, devices, credentials, registerCalls };
}

/** POST helper attaching a Bearer credential and the device header. */
function post(
  app: Harness["app"],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

// ---------------------------------------------------------------------------
// 1. Security headers — present on the composed surface, success and failure
// ---------------------------------------------------------------------------

describe("composed app: security headers on *", () => {
  it("stamps every hardening header onto a success response", async () => {
    const { app } = await harness();
    const res = await app.request("/healthz");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
  });

  it("covers a 401 from an unauthenticated POST (headers applied after next())", async () => {
    const { app } = await harness();
    const res = await post(app, "/v1/telemetry", { metrics: { temp: 25.4 } });
    expect(res.status).toBe(401);
    for (const name of Object.keys(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).not.toBeNull();
    }
  });

  it("covers the framework 404 for an unknown path", async () => {
    const { app } = await harness();
    const res = await app.request("/no/such/route");
    expect(res.status).toBe(404);
    for (const name of Object.keys(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. Liveness and identity
// ---------------------------------------------------------------------------

describe("composed app: liveness and identity", () => {
  it("GET /healthz is 200 { ok: true }", async () => {
    const { app } = await harness();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /v1/version reports the advertised identity", async () => {
    const { app } = await harness();
    const res = await app.request("/v1/version");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...DEFAULT_VERSION });
  });

  it("GET /v1/version honours an injected version", async () => {
    const { app } = await harness();
    const custom = createApp({
      deviceTokens: async () => null,
      sessions: async () => null,
      ingest: {
        verifyToken: async () => null,
        sink: { record: () => undefined },
        devices: { register: () => undefined },
      },
      query: {
        credentials: async () => null,
        projects: { state: async () => [] },
        shards: { ring: async () => [] },
      },
      version: { name: "insight", version: "9.9.9" },
    });
    const res = await custom.request("/v1/version");
    expect(await res.json()).toEqual({ name: "insight", version: "9.9.9" });
    // Sanity: the two apps are distinct instances.
    expect(app).not.toBe(custom);
  });
});

// ---------------------------------------------------------------------------
// 4. The telemetry route is MOUNTED (not a 404) and the contract holds
// ---------------------------------------------------------------------------

describe("composed app: POST /v1/telemetry is mounted", () => {
  it("unauth POST is 401 from the route, never a 404", async () => {
    const { app } = await harness();
    const res = await post(app, "/v1/telemetry", { metrics: { temp: 25.4 } });
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
  });

  it("a non-Bearer credential is still 401 (strict parser)", async () => {
    const { app } = await harness();
    const res = await post(app, "/v1/telemetry", { metrics: { temp: 25.4 } }, {
      authorization: `Basic ${TOKEN}`,
    });
    expect(res.status).toBe(401);
  });

  it("a valid project token is accepted end-to-end (204, sample + device recorded)", async () => {
    const { app, sink, registerCalls } = await harness();
    const res = await post(app, "/v1/telemetry", { metrics: { temp: 25.4 } }, {
      authorization: `Bearer ${TOKEN}`,
      "x-insight-device": DEVICE,
    });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    const sample: RecordedSample | undefined = sink.last();
    expect(sample).toEqual({
      projectId: PROJECT,
      device: DEVICE,
      metric: "temp",
      value: 25.4,
      ts: 1_700_000_000_000, // server clock, not any device-supplied value
    });
    // The device was auto-registered on first sighting.
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0]).toMatchObject({ projectId: PROJECT, device: DEVICE });
  });

  it("a presented-but-unknown Bearer is the frozen 401 unauthorized", async () => {
    // The credential is PRESENTED and well-formed but resolves to nothing. The
    // frozen contract names `unauthorized` here — the SAME code an absent
    // credential gets — and emphatically not the middleware's
    // `invalid_credential`. The route, not a gate, owns this verdict.
    const { app, sink } = await harness();
    const res = await post(app, "/v1/telemetry", { metrics: { temp: 25.4 } }, {
      authorization: `Bearer ${UNKNOWN_TOKEN}`,
    });
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
    expect(body.error).not.toBe("invalid_credential");
    expect(sink.size).toBe(0); // fail-closed: nothing was written
  });

  it("a presented-but-revoked Bearer is also 401 unauthorized (not invalid_credential)", async () => {
    // Revoked is a submitted credential the verifier recognises and rejects;
    // it must read exactly like the unknown one — no oracle for *why*.
    const { app, sink } = await harness();
    const res = await post(app, "/v1/telemetry", { metrics: { temp: 25.4 } }, {
      authorization: `Bearer ${REVOKED_TOKEN}`,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
    expect(body.error).not.toBe("invalid_credential");
    expect(sink.size).toBe(0);
  });

  it("a read-scoped Bearer authenticates but is refused the write (403)", async () => {
    // A REAL token in the credential's own project, scoped `read` only: it is
    // not a 401 (the route resolved it), and the shared `requireScope("write")`
    // gate refuses it 403 so nothing is persisted.
    const { app, sink } = await harness();
    const res = await post(app, "/v1/telemetry", { metrics: { temp: 25.4 } }, {
      authorization: `Bearer ${READ_ONLY_TOKEN}`,
      "x-insight-device": DEVICE,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("insufficient_scope");
    expect(sink.size).toBe(0);
  });

  it("the dead `:proj` ingest mount is gone (404, not a claim form)", async () => {
    // `/v1/telemetry/:proj` never had a route behind it, so the claim form was
    // dead wiring. It is removed: an unknown path 404s at the framework edge
    // rather than running a gate whose route does not exist.
    const { app, sink } = await harness();
    const res = await post(app, `/v1/telemetry/${OTHER_PROJECT}`, { metrics: { temp: 1 } }, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(404);
    expect(sink.size).toBe(0);
  });

  it("a scope-less token is refused a write with 403 (least-privilege default)", async () => {
    // The credential is minted with NO `scopes` field: the least-privilege
    // default makes it read-only, so the composed ingest route — which gates
    // with the shared `requireScope(c, "write")` — refuses it 403.
    const h = await harness(1_700_000_000_000, { scopes: null });
    const res = await post(h.app, "/v1/telemetry", { metrics: { temp: 1 } }, {
      authorization: `Bearer ${TOKEN}`,
      "x-insight-device": DEVICE,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("insufficient_scope");
    expect(h.sink.size).toBe(0);
  });

  it("the (limit+1)th ingest through the COMPOSED app is 429 + retry-after with zero writes", async () => {
    // Proves the rate limiter is actually threaded into the mounted route, not
    // just constructible: three ingests pass, the fourth is throttled.
    const rateLimiter = new RateLimiter({ now: () => 1_700_000_000_000 });
    const h = await harness(1_700_000_000_000, {
      rateLimiter,
      rateLimit: { limit: 3, windowMs: 60_000 },
    });
    const headers = { authorization: `Bearer ${TOKEN}`, "x-insight-device": DEVICE };

    for (let i = 0; i < 3; i += 1) {
      expect((await post(h.app, "/v1/telemetry", { metrics: { temp: i } }, headers)).status).toBe(204);
    }
    expect(h.sink.size).toBe(3);

    const denied = await post(h.app, "/v1/telemetry", { metrics: { temp: 9 } }, headers);
    expect(denied.status).toBe(429);
    const body = (await denied.json()) as { error?: string };
    expect(body.error).toBe("rate_limited");
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(h.sink.size).toBe(3); // nothing written by the throttled request
  });

  it("a retired device is refused 403 device_not_ingestible through the COMPOSED app", async () => {
    const h = await harness(1_700_000_000_000, {
      ingestibility: { status: (p, d) => (p === PROJECT && d === "dev-retired" ? "retired" : undefined) },
    });
    const headers = { authorization: `Bearer ${TOKEN}` };

    const refused = await post(
      h.app,
      "/v1/telemetry",
      { metrics: { temp: 1 } },
      { ...headers, "x-insight-device": "dev-retired" },
    );
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error?: string };
    expect(body.error).toBe("device_not_ingestible");
    expect(h.sink.size).toBe(0);

    // A different (active/unknown) device with the SAME credential writes fine.
    const accepted = await post(
      h.app,
      "/v1/telemetry",
      { metrics: { temp: 2 } },
      { ...headers, "x-insight-device": "dev-active" },
    );
    expect(accepted.status).toBe(204);
    expect(h.sink.samples().map((s) => s.device)).toEqual(["dev-active"]);
  });
});

// ---------------------------------------------------------------------------
// 5. The read surface is mounted behind the same fail-closed gate
// ---------------------------------------------------------------------------

describe("composed app: GET /v1/projects/:proj/state", () => {
  it("unauth read is 401 (mounted, not 404)", async () => {
    const { app } = await harness();
    const res = await app.request(`/v1/projects/${PROJECT}/state`);
    expect(res.status).toBe(401);
  });

  it("returns the projection for the credential's own project", async () => {
    const { app } = await harness();
    const res = await app.request(`/v1/projects/${PROJECT}/state`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: [{ device: DEVICE, variable: "temp", value: 25.4, ts: 1_700_000_000_000, seq: 1 }],
    });
  });

  it("a cross-project path claim is 403, not a filtered 200", async () => {
    const { app } = await harness();
    const res = await app.request(`/v1/projects/${OTHER_PROJECT}/state`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("a bare / scheme-less Authorization is 401 (shared STRICT parser)", async () => {
    const { app } = await harness();
    const res = await app.request(`/v1/projects/${PROJECT}/state`, {
      headers: { authorization: TOKEN },
    });
    expect(res.status).toBe(401);
  });

  it("a non-Bearer scheme is 401 on the read surface", async () => {
    const { app } = await harness();
    const res = await app.request(`/v1/projects/${PROJECT}/variables/temp/series`, {
      headers: { authorization: `Basic ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });
});
