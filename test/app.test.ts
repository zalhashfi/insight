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
 *   4. the telemetry ingest route is MOUNTED: an unauthenticated
 *      `POST /v1/telemetry` (contract-locked `401`) is answered by the route,
 *      not by a 404;
 *   5. a valid project token flows all the way to the sink and is `204`;
 *   6. the `:proj` path claim is fail-closed against the credential.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_VERSION, createApp, type App, type AppDeps } from "../worker/src/app";
import { InMemoryTokenRepo } from "../worker/src/domains/identity/tokens";
import {
  InMemoryTelemetrySink,
  type DeviceRegistry,
  type RecordedSample,
} from "../worker/src/domains/telemetry/telemetry";
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
async function harness(now = 1_700_000_000_000): Promise<Harness> {
  // --- the credential store: hash-only, exactly like the D1 table -----------
  const tokens = new InMemoryTokenRepo();
  await tokens.insert({
    id: "tok_smoke",
    projectId: PROJECT,
    name: "smoke token",
    tokenHash: await hashToken(TOKEN),
    tokenPrefix: TOKEN.slice(0, 6),
    scopes: "read write",
    expiresAt: null,
    revokedAt: null,
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

  it("a :proj path claim contradicting the credential is refused (403)", async () => {
    const { app, sink } = await harness();
    const res = await post(app, `/v1/telemetry/${OTHER_PROJECT}`, { metrics: { temp: 1 } }, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(403);
    expect(sink.size).toBe(0); // fail-closed: nothing was written
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
});
