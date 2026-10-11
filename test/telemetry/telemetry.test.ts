import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  DEFAULT_DEVICE_KEY,
  DEFAULT_DEVICE_STATUS,
  DEVICE_NOT_INGESTIBLE_CODE,
  DEVICE_NOT_INGESTIBLE_STATUS,
  INGEST_REFUSED_STATUSES,
  InMemoryDeviceRegistry,
  InMemoryTelemetrySink,
  createTelemetryIngest,
  createTelemetryIngestHandler,
  normaliseDevice,
  type DeviceIngestibilityGate,
  type IngestRateLimiter,
  type RecordedSample,
  type TelemetryDeps,
  type TelemetryHandler,
  type VerifyToken,
} from "../../worker/src/domains/telemetry/telemetry";
import {
  RATE_LIMITED_CODE,
  RATE_LIMITED_STATUS,
  RETRY_AFTER_HEADER,
  RateLimiter,
  type RateLimitDecision,
} from "../../worker/src/domains/telemetry/rate-limit";
import {
  DEVICE_STATUSES,
  INGEST_REFUSED,
} from "../../worker/src/domains/devices/metadata";
import {
  readBearerToken,
  type DevicePrincipal,
} from "../../worker/src/platform/middleware/resolve-project";
import { DEFAULT_LIMITS, validateTelemetry } from "../../worker/src/shared/validation";

/**
 * Spec tests for the A08 telemetry ingest route (`POST /v1/telemetry`).
 *
 * Every dependency is injected, so each contract is asserted against a value we
 * control outright:
 *
 *   1. **Auth** — a missing, non-Bearer (e.g. `Basic …`) or bare header is NOT
 *      a credential (`401`); a rejected token is `401`; a valid `write`-scoped
 *      token resolves the project the samples are attributed to.
 *   1b. **Authz** — ingest is a write surface gated by the SHARED
 *      `requireScope(c, "write")`, so a `read`-scoped device token — or one
 *      whose scope is absent, which is now READ-ONLY under the least-privilege
 *      default — that authenticates is refused `403`.
 *   2. **Server clock** — the timestamp handed to the sink is the injected
 *      `now()`, never anything a device could put in the body.
 *   3. **Device key** — `x-insight-device` names the sender; absent/blank falls
 *      back to the default key and still auto-registers a device.
 *   4. **Delegated validation** — `400` / `413` come straight from the shared
 *      module with its exact code, and nothing is persisted on a rejection.
 *   5. **Persistence** — one sink call per accepted metric with the exact
 *      `(project, device, metric, value, serverTs)` tuple.
 */

const PROJECT = "proj_alpha";
const TOKEN = "pt_valid_token";

/**
 * A well-formed device principal for {@link PROJECT}, carrying the `read write`
 * capabilities the operational M1 token is minted with. Under the
 * least-privilege default a scope-less token would be read-only and refused the
 * write, so the baseline token grants `write` explicitly — the shape production
 * mints for an ingest credential.
 */
const DEVICE: DevicePrincipal = {
  kind: "device",
  projectId: PROJECT,
  tokenId: "tok_valid",
  scopes: "read write",
};

/** The exact server instant every test records against. */
const SERVER_NOW = 1_700_000_000_123;

interface Harness {
  /** Mounted app: `POST /v1/telemetry`. */
  app: Hono;
  sink: InMemoryTelemetrySink;
  devices: InMemoryDeviceRegistry;
  /** The project a valid token resolves to, for asserting attribution. */
  project: string;
}

/**
 * Build a fully-injected route.
 *
 * `verifyToken` accepts exactly {@link TOKEN} by default; pass an override to
 * exercise the refusal path. The clock is fixed, so `ts` is knowable exactly.
 */
function harness(
  overrides: Partial<TelemetryDeps> & { verifyToken?: VerifyToken } = {},
): Harness {
  const sink = new InMemoryTelemetrySink();
  const devices = new InMemoryDeviceRegistry();

  const verifyToken: VerifyToken =
    overrides.verifyToken ?? (async (token) => (token === TOKEN ? DEVICE : null));

  const deps: TelemetryDeps = {
    verifyToken,
    sink,
    devices,
    now: () => SERVER_NOW,
    ...overrides,
  };

  const app = new Hono();
  app.route("/v1/telemetry", createTelemetryIngest(deps));
  return { app, sink, devices, project: PROJECT };
}

/** POST a JSON value to the mounted ingest route. */
function postJson(
  app: Hono,
  value: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
      body: JSON.stringify(value),
    }),
  );
}

/** POST a raw body (for malformed / oversized payloads). */
function postRaw(
  app: Hono,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
      body,
    }),
  );
}

/** A JSON body guaranteed to exceed the shared module's byte limit. */
function oversizedBody(): string {
  return JSON.stringify({
    metrics: [{ key: "k", value: 1, junk: "x".repeat(DEFAULT_LIMITS.maxBytes + 1) }],
  });
}

/** Mount a bare ingest handler on a fresh app at `POST /v1/telemetry`. */
function handlerApp(handler: TelemetryHandler): Hono {
  const app = new Hono();
  app.post("/v1/telemetry", handler);
  return app;
}
/** Read a `{ error, message }` body from a rejected response. */
async function errorOf(res: Response): Promise<{ error: string; message: string }> {
  const parsed = (await res.json()) as { error?: unknown; message?: unknown };
  if (typeof parsed.error !== "string" || typeof parsed.message !== "string") {
    throw new Error(`unexpected error body: ${JSON.stringify(parsed)}`);
  }
  return { error: parsed.error, message: parsed.message };
}

/** The `(project, device, metric, value, ts)` tuple of a recorded sample. */
function tuple(s: RecordedSample): [string, string, string, number | null, number] {
  return [s.projectId, s.device, s.metric, s.value, s.ts];
}

// ---------------------------------------------------------------------------
// Acceptance — both body shapes, 204, sink receives server-stamped tuple
// ---------------------------------------------------------------------------
describe("POST /v1/telemetry — accepted bodies", () => {
  it("accepts `{metrics:{temp:25.4}}` with 204 and records (project, device, 'temp', 25.4, serverTs)", async () => {
    const h = harness();
    const res = await postJson(
      h.app,
      { metrics: { temp: 25.4 } },
      { "x-insight-device": "dev-1" },
    );

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(h.sink.size).toBe(1);
    expect(tuple(h.sink.last()!)).toEqual([PROJECT, "dev-1", "temp", 25.4, SERVER_NOW]);
  });

  it("accepts a `{metric,value}` body with 204 and records the sample", async () => {
    const h = harness();
    const res = await postJson(h.app, { metric: "cpu", value: 42.5 }, { "x-insight-device": "dev-2" });

    expect(res.status).toBe(204);
    expect(tuple(h.sink.last()!)).toEqual([PROJECT, "dev-2", "cpu", 42.5, SERVER_NOW]);
  });

  it("accepts a null value with 204 and records it verbatim", async () => {
    const h = harness();
    const res = await postJson(h.app, { metrics: { temp: null } }, { "x-insight-device": "dev-3" });

    expect(res.status).toBe(204);
    expect(tuple(h.sink.last()!)).toEqual([PROJECT, "dev-3", "temp", null, SERVER_NOW]);
  });

  it("records one sink call per metric, all with the same server timestamp", async () => {
    const h = harness();
    const res = await postJson(
      h.app,
      { metrics: { temp: 25.4, cpu: 0.5 } },
      { "x-insight-device": "dev-4" },
    );

    expect(res.status).toBe(204);
    expect(h.sink.samples().map(tuple)).toEqual([
      [PROJECT, "dev-4", "temp", 25.4, SERVER_NOW],
      [PROJECT, "dev-4", "cpu", 0.5, SERVER_NOW],
    ]);
  });

  it("still accepts the canonical `{metrics:[{key,value}]}` shape with 204", async () => {
    const h = harness();
    const res = await postJson(
      h.app,
      { metrics: [{ key: "temp", value: 25.4 }] },
      { "x-insight-device": "dev-c" },
    );

    expect(res.status).toBe(204);
    expect(tuple(h.sink.last()!)).toEqual([PROJECT, "dev-c", "temp", 25.4, SERVER_NOW]);
  });

  it("still accepts a bare metrics array with 204", async () => {
    const h = harness();
    const res = await postJson(h.app, [["temp", 25.4]], { "x-insight-device": "dev-d" });

    expect(res.status).toBe(204);
    expect(tuple(h.sink.last()!)).toEqual([PROJECT, "dev-d", "temp", 25.4, SERVER_NOW]);
  });
});

// ---------------------------------------------------------------------------
// Server-stamped time — the device clock cannot influence the record's ts
// ---------------------------------------------------------------------------
describe("POST /v1/telemetry — server-stamped timestamp", () => {
  it("stamps records with the injected server clock", async () => {
    const h = harness({ now: () => 999_888_777 });
    await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-5" });

    expect(h.sink.last()!.ts).toBe(999_888_777);
  });

  it("IGNORES a device-supplied ts/time/timestamp in the body", async () => {
    const h = harness();
    const deviceTs = 1; // absurdly old — must never reach the sink
    const res = await postJson(
      h.app,
      { metrics: { temp: 1 }, ts: deviceTs, time: deviceTs, timestamp: deviceTs },
      { "x-insight-device": "dev-6" },
    );

    expect(res.status).toBe(204);
    expect(h.sink.last()!.ts).toBe(SERVER_NOW);
    expect(h.sink.last()!.ts).not.toBe(deviceTs);
  });

  it("calls now() once per request, so every metric shares one instant", async () => {
    let calls = 0;
    const h = harness({
      now: () => {
        calls += 1;
        return 5_000 + calls;
      },
    });
    await postJson(h.app, { metrics: { a: 1, b: 2 } }, { "x-insight-device": "dev-7" });

    expect(calls).toBe(1);
    expect(h.sink.samples().map((s) => s.ts)).toEqual([5_001, 5_001]);
  });
});

// ---------------------------------------------------------------------------
// Auth — missing / rejected token => 401; nothing is persisted
// ---------------------------------------------------------------------------
describe("POST /v1/telemetry — authentication", () => {
  it("rejects a missing Authorization header with 401 and records nothing", async () => {
    const h = harness();
    const res = await h.app.request("/v1/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metrics: { temp: 1 } }),
    });

    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe("unauthorized");
    expect(h.sink.size).toBe(0);
  });

  it("rejects an invalid token with 401 and records nothing", async () => {
    const h = harness();
    const res = await h.app.request("/v1/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer pt_wrong" },
      body: JSON.stringify({ metrics: { temp: 1 } }),
    });

    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe("unauthorized");
    expect(h.sink.size).toBe(0);
  });

  it("fails closed (401) when the verifier throws, and records nothing", async () => {
    const h = harness({
      verifyToken: async () => {
        throw new Error("verifier unavailable");
      },
    });
    const res = await postJson(h.app, { metrics: { temp: 1 } });

    expect(res.status).toBe(401);
    expect(h.sink.size).toBe(0);
  });

  it("rejects a non-Bearer `Basic …` header with 401 and records nothing", async () => {
    // A Basic credential is not a credential on this surface: the shared
    // strict parser refuses to extract one, so this is `401`, not a pass.
    const h = harness();
    const res = await h.app.request("/v1/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Basic xyz" },
      body: JSON.stringify({ metrics: { temp: 1 } }),
    });

    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe("unauthorized");
    expect(h.sink.size).toBe(0);
  });

  it("rejects a bare token (no Bearer scheme) with 401 and records nothing", async () => {
    // Previously a bare value was accepted; the strict shared parser now
    // treats it as "not a credential at all" — one parser, fail closed.
    const h = harness();
    const res = await h.app.request("/v1/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: TOKEN },
      body: JSON.stringify({ metrics: { temp: 1 } }),
    });

    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe("unauthorized");
    expect(h.sink.size).toBe(0);
  });

  it("rejects a scheme-less `Bearer` with no token behind it with 401", async () => {
    const h = harness();
    const res = await h.app.request("/v1/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer" },
      body: JSON.stringify({ metrics: { temp: 1 } }),
    });

    expect(res.status).toBe(401);
    expect(h.sink.size).toBe(0);
  });

  it("attributes samples to the project returned by the verifier", async () => {
    const h = harness({
      verifyToken: async () => ({ kind: "device", projectId: "proj_other", scopes: "read write" }),
    });
    await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-8" });

    expect(h.sink.last()!.projectId).toBe("proj_other");
  });
});

// ---------------------------------------------------------------------------
// Authorization — ingest is a WRITE surface gated by the shared requireScope
// ---------------------------------------------------------------------------
describe("POST /v1/telemetry — write authorization (shared scope gate)", () => {
  /** A harness whose only usable token carries `read` scope (write forbidden). */
  function readScoped(): Harness {
    return harness({
      verifyToken: async (token) =>
        token === TOKEN ? { kind: "device", projectId: PROJECT, scopes: "read" } : null,
    });
  }

  it("refuses a valid read-scoped token with 403 (previously it could write)", async () => {
    const h = readScoped();
    const res = await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-ro" });

    expect(res.status).toBe(403);
    // The body is the shared module's `insufficient_scope` shape, not the
    // route's `unauthorized` — proving the policy module, not a local check.
    expect((await errorOf(res)).error).toBe("insufficient_scope");
    // A refusal never persists, registers, or even parses the body.
    expect(h.sink.size).toBe(0);
    expect(h.devices.isRegistered(PROJECT, "dev-ro")).toBe(false);
  });

  it("accepts a write-scoped token with 204 and records the sample", async () => {
    const h = harness({
      verifyToken: async (token) =>
        token === TOKEN ? { kind: "device", projectId: PROJECT, scopes: "read write" } : null,
    });
    const res = await postJson(h.app, { metrics: { temp: 25.4 } }, { "x-insight-device": "dev-rw" });

    expect(res.status).toBe(204);
    expect(tuple(h.sink.last()!)).toEqual([PROJECT, "dev-rw", "temp", 25.4, SERVER_NOW]);
  });

  it("accepts a write-only token (write without read) with 204", async () => {
    const h = harness({
      verifyToken: async (token) =>
        token === TOKEN ? { kind: "device", projectId: PROJECT, scopes: "write" } : null,
    });
    const res = await postJson(h.app, { metrics: { cpu: 1 } }, { "x-insight-device": "dev-wo" });

    expect(res.status).toBe(204);
    expect(h.sink.last()!.device).toBe("dev-wo");
  });

  it("refuses an unrestricted/scope-less token with 403 (least-privilege default)", async () => {
    // A token minted WITHOUT an explicit scope no longer means "unrestricted".
    // The default is read-only, so this credential may read but may not write
    // — the least-privilege fix. (Previously this shape wrote successfully.)
    const h = harness({
      verifyToken: async (token) => (token === TOKEN ? { ...DEVICE, scopes: undefined } : null),
    });
    const res = await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-any" });

    expect(res.status).toBe(403);
    expect((await errorOf(res)).error).toBe("insufficient_scope");
    expect(h.sink.size).toBe(0);
  });

  it("a read-scoped token is refused BEFORE the body is validated (403, not 400)", async () => {
    // An invalid body must not turn the 403 into a 400: authz precedes parsing,
    // exactly as auth does.
    const h = readScoped();
    const res = await postRaw(h.app, "{not json", { "x-insight-device": "dev-ro2" });

    expect(res.status).toBe(403);
    expect((await errorOf(res)).error).toBe("insufficient_scope");
    expect(h.sink.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting — (limit + 1)th ingest is 429 + retry-after, zero sink writes
// ---------------------------------------------------------------------------
describe("POST /v1/telemetry — rate limiting", () => {
  /** A harness with a real limiter and a hand-cranked clock. */
  function limited(policy = { limit: 3, windowMs: 60_000 }): {
    h: Harness;
    advance: (ms: number) => void;
  } {
    let now = SERVER_NOW;
    const rateLimiter = new RateLimiter({ now: () => now });
    const h = harness({ rateLimiter, rateLimit: policy, now: () => now });
    return {
      h,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("admits exactly `limit` ingests, then answers the (limit+1)th with 429 + retry-after and zero writes", async () => {
    const { h } = limited({ limit: 3, windowMs: 60_000 });

    for (let i = 0; i < 3; i += 1) {
      const ok = await postJson(h.app, { metrics: { temp: i } }, { "x-insight-device": "dev-rl" });
      expect(ok.status).toBe(204);
    }
    expect(h.sink.size).toBe(3);

    const denied = await postJson(h.app, { metrics: { temp: 99 } }, { "x-insight-device": "dev-rl" });
    expect(denied.status).toBe(429);
    // The frozen `rate_limited` body and a valid `retry-after` header.
    expect((await errorOf(denied)).error).toBe(RATE_LIMITED_CODE);
    const retryAfter = Number(denied.headers.get(RETRY_AFTER_HEADER));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    // NOTHING was written by the throttled request.
    expect(h.sink.size).toBe(3);
  });

  it("does not read or validate the body of a throttled request (429, not 400/413)", async () => {
    const { h } = limited({ limit: 1, windowMs: 60_000 });
    expect((await postJson(h.app, { metrics: { temp: 1 } })).status).toBe(204);

    // A malformed AND oversized body must still be answered 429: the limiter
    // runs before the body is touched.
    const denied = await postRaw(h.app, oversizedBody(), { "x-insight-device": "dev-rl2" });
    expect(denied.status).toBe(429);
    expect((await errorOf(denied)).error).toBe(RATE_LIMITED_CODE);
    expect(h.sink.size).toBe(1);
  });

  it("counts per token: a second token is not throttled by the first", async () => {
    let now = SERVER_NOW;
    const rateLimiter = new RateLimiter({ now: () => now });
    // Two valid tokens, each write-scoped for the same project.
    const h = harness({
      rateLimiter,
      rateLimit: { limit: 1, windowMs: 60_000 },
      verifyToken: async (token) =>
        token === TOKEN || token === "pt_second"
          ? { kind: "device", projectId: PROJECT, scopes: "read write" }
          : null,
    });

    const first = await postJson(h.app, { metrics: { a: 1 } }, { "x-insight-device": "d1" });
    expect(first.status).toBe(204);
    const firstAgain = await postJson(h.app, { metrics: { a: 2 } }, { "x-insight-device": "d1" });
    expect(firstAgain.status).toBe(429);

    const second = await postJson(
      h.app,
      { metrics: { a: 3 } },
      { "x-insight-device": "d2", authorization: "Bearer pt_second" },
    );
    expect(second.status).toBe(204);
  });

  it("rate limiting runs AFTER auth (401) and scope (403), never instead of them", async () => {
    // A flood of unauthenticated / under-scoped requests must not consume the
    // token's budget, and must be answered 401/403 — not 429.
    const { h } = limited({ limit: 1, windowMs: 60_000 });
    // No Authorization header at all: strictly no credential -> 401, and the
    // limiter is never consulted.
    const noAuth = await h.app.request("/v1/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", "x-insight-device": "d" },
      body: "{}",
    });
    expect(noAuth.status).toBe(401);

    const readOnly = harness({
      rateLimit: { limit: 1, windowMs: 60_000 },
      rateLimiter: new RateLimiter({ now: () => SERVER_NOW }),
      verifyToken: async (token) =>
        token === TOKEN ? { kind: "device", projectId: PROJECT, scopes: "read" } : null,
    });
    const forbidden = await postJson(readOnly.app, { metrics: { a: 1 } }, { "x-insight-device": "d" });
    expect(forbidden.status).toBe(403);
    expect(readOnly.sink.size).toBe(0);
  });

  it("admits again once the window has rolled", async () => {
    const { h, advance } = limited({ limit: 1, windowMs: 60_000 });
    expect((await postJson(h.app, { metrics: { a: 1 } })).status).toBe(204);
    expect((await postJson(h.app, { metrics: { a: 2 } })).status).toBe(429);

    advance(60_000);
    expect((await postJson(h.app, { metrics: { a: 3 } })).status).toBe(204);
    expect(h.sink.size).toBe(2);
  });

  it("a limiter is optional: without one the route is unlimited (composable seam)", async () => {
    const h = harness(); // no rateLimiter injected
    for (let i = 0; i < 25; i += 1) {
      const res = await postJson(h.app, { metrics: { temp: i } }, { "x-insight-device": "dev-open" });
      expect(res.status).toBe(204);
    }
    expect(h.sink.size).toBe(25);
  });

  it("a throwing limiter fails closed with 429 rate_limited + retry-after and zero writes (a broken guard never opens the gate)", async () => {
    // The budget cannot be enforced when the limiter store is down, so the route
    // must refuse — never treat "limiter broke" as "admit". Same wire shape as a
    // normal denial: a frozen `429 rate_limited` with a valid `retry-after`.
    const throwing: IngestRateLimiter = {
      checkAndConsume(): RateLimitDecision {
        throw new Error("limiter store unavailable");
      },
    };
    const h = harness({ rateLimiter: throwing });
    const res = await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-x" });

    expect(res.status).toBe(429);
    expect(res.status).toBe(RATE_LIMITED_STATUS);
    expect((await errorOf(res)).error).toBe(RATE_LIMITED_CODE);
    const retryAfter = Number(res.headers.get(RETRY_AFTER_HEADER));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(h.sink.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Device ingestibility — retired/dormant refused 403 device_not_ingestible
// ---------------------------------------------------------------------------
describe("POST /v1/telemetry — device ingestibility (INV-DEV-status)", () => {
  /** A registry-backed gate: only the statuses it knows are refused. */
  function gateFor(statuses: Record<string, string>): DeviceIngestibilityGate {
    return { status: (projectId, device) => statuses[`${projectId}/${device}`] };
  }

  it("refuses a RETIRED device with 403 device_not_ingestible and zero sink writes", async () => {
    const h = harness({
      ingestibility: gateFor({ [`${PROJECT}/dev-old`]: "retired" }),
    });
    const res = await postJson(h.app, { metrics: { temp: 25.4 } }, { "x-insight-device": "dev-old" });

    expect(res.status).toBe(403);
    expect(res.status).toBe(DEVICE_NOT_INGESTIBLE_STATUS);
    const body = await errorOf(res);
    expect(body.error).toBe(DEVICE_NOT_INGESTIBLE_CODE);
    expect(h.sink.size).toBe(0);
    // A refused device is not (re-)registered.
    expect(h.devices.isRegistered(PROJECT, "dev-old")).toBe(false);
  });

  it("refuses a DORMANT device with 403 device_not_ingestible (documented policy)", async () => {
    const h = harness({ ingestibility: gateFor({ [`${PROJECT}/dev-sleep`]: "dormant" }) });
    const res = await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-sleep" });

    expect(res.status).toBe(403);
    expect((await errorOf(res)).error).toBe(DEVICE_NOT_INGESTIBLE_CODE);
    expect(h.sink.size).toBe(0);
  });

  // The refused set has ONE home: the domain policy `INGEST_REFUSED`. The route
  // must not carry a drifting second copy, so this proves route ≡ domain across
  // the WHOLE status vocabulary — for every status, the route's verdict equals
  // `INGEST_REFUSED[status]`, and a route-side flip of the policy would fail it.
  it("the route's refused set is the domain policy INGEST_REFUSED — proven, not restated", () => {
    const routeRefuses = (status: string): boolean => INGEST_REFUSED_STATUSES.includes(status);

    // Membership is exactly the domain table's, for every known status.
    for (const status of DEVICE_STATUSES) {
      expect(routeRefuses(status)).toBe(INGEST_REFUSED[status]);
    }

    // Anchored to the domain contract, not a literal: retired and dormant are
    // refused because `INGEST_REFUSED` says so, and only those.
    expect(routeRefuses("retired")).toBe(true);
    expect(routeRefuses("dormant")).toBe(true);
    expect(routeRefuses("active")).toBe(false);
    expect(INGEST_REFUSED).toEqual({ active: false, dormant: true, retired: true });
  });

  it("a DORMANT device is refused end-to-end BECAUSE the domain policy refuses it", async () => {
    // Drive the route for every status and compare the outcome to the table, so
    // the cross-check is behavioural, not just a membership test.
    for (const status of DEVICE_STATUSES) {
      const h = harness({ ingestibility: gateFor({ [`${PROJECT}/dev-${status}`]: status }) });
      const res = await postJson(
        h.app,
        { metrics: { temp: 1 } },
        { "x-insight-device": `dev-${status}` },
      );
      if (INGEST_REFUSED[status]) {
        expect(res.status).toBe(DEVICE_NOT_INGESTIBLE_STATUS);
        expect((await errorOf(res)).error).toBe(DEVICE_NOT_INGESTIBLE_CODE);
        expect(h.sink.size).toBe(0);
      } else {
        expect(res.status).toBe(204);
        expect(h.sink.size).toBe(1);
      }
    }
  });

  it("accepts an ACTIVE device with 204 and records the sample", async () => {
    const h = harness({ ingestibility: gateFor({ [`${PROJECT}/dev-live`]: "active" }) });
    const res = await postJson(h.app, { metrics: { temp: 25.4 } }, { "x-insight-device": "dev-live" });

    expect(res.status).toBe(204);
    expect(tuple(h.sink.last()!)).toEqual([PROJECT, "dev-live", "temp", 25.4, SERVER_NOW]);
  });

  it("admits an UNKNOWN device (auto-registered active) with 204", async () => {
    const h = harness({ ingestibility: gateFor({}) }); // knows no devices
    const res = await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-new" });

    expect(res.status).toBe(204);
    expect(h.devices.isRegistered(PROJECT, "dev-new")).toBe(true);
    expect(DEFAULT_DEVICE_STATUS).toBe("active");
  });

  it("the ingestibility gate runs BEFORE validation: a retired device's bad body is still 403", async () => {
    const h = harness({ ingestibility: gateFor({ [`${PROJECT}/dev-old`]: "retired" }) });
    const res = await postRaw(h.app, "{not json", { "x-insight-device": "dev-old" });

    expect(res.status).toBe(403);
    expect((await errorOf(res)).error).toBe(DEVICE_NOT_INGESTIBLE_CODE);
    expect(h.sink.size).toBe(0);
  });

  it("a retired device is refused but a valid write-scoped ACTIVE token still writes (order preserved)", async () => {
    // Same token, two devices: the gate is per-device, not per-credential.
    const h = harness({
      ingestibility: gateFor({ [`${PROJECT}/dev-bad`]: "retired" }),
    });
    const bad = await postJson(h.app, { metrics: { a: 1 } }, { "x-insight-device": "dev-bad" });
    expect(bad.status).toBe(403);
    const good = await postJson(h.app, { metrics: { a: 2 } }, { "x-insight-device": "dev-good" });
    expect(good.status).toBe(204);
    expect(h.sink.samples().map((s) => s.device)).toEqual(["dev-good"]);
  });

  it("without an ingestibility seam every device is admitted (gate is optional)", async () => {
    const h = harness(); // no ingestibility injected
    const res = await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-any" });

    expect(res.status).toBe(204);
    expect(h.sink.last()?.device).toBe("dev-any");
  });
});

// ---------------------------------------------------------------------------
// Delegated validation — 400 / 413 come straight from the shared module
// ---------------------------------------------------------------------------
describe("POST /v1/telemetry — validation failures", () => {
  it("rejects an oversized body with 413 and records nothing", async () => {
    const h = harness();
    const res = await postRaw(h.app, oversizedBody(), { "x-insight-device": "dev-9" });

    expect(res.status).toBe(413);
    expect((await errorOf(res)).error).toBe("payload_too_large");
    expect(h.sink.size).toBe(0);
  });

  it("rejects a NaN value with 400 invalid_value and records nothing", async () => {
    // A real NaN cannot survive JSON.stringify (it serialises to "null", which
    // is explicitly allowed), so the finite-check is asserted two ways:
    //   1. structurally, via the shared module the route delegates to;
    //   2. over the wire, via an equally non-finite non-number value.
    const shared = validateTelemetry({ metrics: [{ key: "cpu", value: Number.NaN }] });
    expect(shared.ok).toBe(false);
    if (!shared.ok) {
      expect(shared.status).toBe(400);
      expect(shared.code).toBe("invalid_value");
    }

    const h = harness();
    const res = await postJson(h.app, { metrics: { cpu: "not-a-number" } }, { "x-insight-device": "dev-nan" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).error).toBe("invalid_value");
    expect(h.sink.size).toBe(0);
  });

  it("rejects an invalid key with 400 invalid_key and records nothing", async () => {
    const h = harness();
    const res = await postJson(h.app, { metrics: { "": 1 } }, { "x-insight-device": "dev-10" });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).error).toBe("invalid_key");
    expect(h.sink.size).toBe(0);
  });

  it("rejects malformed JSON with 400 invalid_json and records nothing", async () => {
    const h = harness();
    const res = await postRaw(h.app, "{not json", { "x-insight-device": "dev-11" });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).error).toBe("invalid_json");
    expect(h.sink.size).toBe(0);
  });

  it("rejects an unrecognised shape with the shared module's 400 invalid_json", async () => {
    const h = harness();
    const res = await postJson(h.app, { nope: true }, { "x-insight-device": "dev-shape" });

    expect(res.status).toBe(400);
    const body = await errorOf(res);
    expect(body.error).toBe("invalid_json");

    // The message is the shared module's own verdict, not invented by the route.
    const shared = validateTelemetry(JSON.stringify({ nope: true }));
    expect(shared.ok).toBe(false);
    if (!shared.ok) {
      expect(body.error).toBe(shared.code);
      expect(body.message).toBe(shared.message);
    }
    expect(h.sink.size).toBe(0);
  });

  it("rejects an empty body with 400 invalid_json and records nothing", async () => {
    const h = harness();
    const res = await postRaw(h.app, "", { "x-insight-device": "dev-empty" });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).error).toBe("invalid_json");
    expect(h.sink.size).toBe(0);
  });

  it("does not auto-register a device when the body is rejected", async () => {
    const h = harness();
    await postJson(h.app, { metrics: { "": 1 } }, { "x-insight-device": "dev-12" });

    expect(h.devices.isRegistered(PROJECT, "dev-12")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Device key + auto-registration
// ---------------------------------------------------------------------------
describe("POST /v1/telemetry — device key and auto-registration", () => {
  it("uses `x-insight-device` as the device key", async () => {
    const h = harness();
    await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-explicit" });

    expect(h.sink.last()!.device).toBe("dev-explicit");
  });

  it("falls back to the default device key when the header is absent, and auto-registers it", async () => {
    const h = harness();
    const res = await postJson(h.app, { metrics: { temp: 1 } });

    expect(res.status).toBe(204);
    expect(h.sink.last()!.device).toBe(DEFAULT_DEVICE_KEY);
    expect(h.devices.isRegistered(PROJECT, DEFAULT_DEVICE_KEY)).toBe(true);
    expect(h.devices.all().map((d) => d.device)).toEqual([DEFAULT_DEVICE_KEY]);
  });

  it("uses the default device key when the header is blank, and auto-registers it", async () => {
    const h = harness();
    const res = await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "   " });

    expect(res.status).toBe(204);
    expect(h.sink.last()!.device).toBe(DEFAULT_DEVICE_KEY);
    expect(h.devices.isRegistered(PROJECT, DEFAULT_DEVICE_KEY)).toBe(true);
  });

  it("auto-registers a named device on first telemetry with the server timestamp", async () => {
    const h = harness();
    await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-13" });

    expect(h.devices.isRegistered(PROJECT, "dev-13")).toBe(true);
    expect(h.devices.all()).toEqual([
      { projectId: PROJECT, device: "dev-13", firstSeenAt: SERVER_NOW },
    ]);
  });

  it("registers each device only once across repeated telemetry", async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) {
      await postJson(h.app, { metrics: { temp: i } }, { "x-insight-device": "dev-14" });
    }

    expect(h.sink.size).toBe(3);
    expect(h.devices.all()).toHaveLength(1);
    expect(h.devices.all()[0].firstSeenAt).toBe(SERVER_NOW);
  });

  it("still records telemetry when registration is unnecessary (already known)", async () => {
    const h = harness();
    await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-15" });
    await postJson(h.app, { metrics: { temp: 2 } }, { "x-insight-device": "dev-15" });

    expect(h.sink.samples().map((s) => s.value)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Bare handler factory — mountable on any path
// ---------------------------------------------------------------------------
describe("createTelemetryIngestHandler", () => {
  it("returns a mountable handler that persists server-stamped samples", async () => {
    const sink = new InMemoryTelemetrySink();
    const devices = new InMemoryDeviceRegistry();
    const handler = createTelemetryIngestHandler({
      verifyToken: async () => ({ kind: "device", projectId: PROJECT, scopes: "read write" }),
      sink,
      devices,
      now: () => SERVER_NOW,
    });

    const res = await postJson(handlerApp(handler), { metric: "cpu", value: 7 }, { "x-insight-device": "dev-h" });

    expect(res.status).toBe(204);
    expect(tuple(sink.last()!)).toEqual([PROJECT, "dev-h", "cpu", 7, SERVER_NOW]);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("telemetry helpers", () => {
  it("normaliseDevice trims, falls back on blank, and clamps length", () => {
    expect(normaliseDevice("  dev-a  ", "fallback")).toBe("dev-a");
    expect(normaliseDevice(undefined, "fallback")).toBe("fallback");
    expect(normaliseDevice("", "fallback")).toBe("fallback");
    expect(normaliseDevice("   ", "fallback")).toBe("fallback");
    expect(normaliseDevice("x".repeat(500), "fallback").length).toBe(128);
  });

  it("the credential is parsed by the SHARED strict Bearer parser (not a local one)", async () => {
    // Probe `readBearerToken` through a real Hono context: it returns `null`
    // for anything that is not a well-formed `Bearer <token>`, and the exact
    // token for a valid one. This pins the parser telemetry.ts consumes.
    const probe = async (authorization?: string): Promise<string | null> => {
      const app = new Hono();
      let seen: string | null = "<unset>";
      app.get("/probe", (c) => {
        seen = readBearerToken(c);
        return c.text("ok");
      });
      await app.request("/probe", {
        headers: authorization === undefined ? {} : { authorization },
      });
      return seen;
    };

    expect(await probe("Bearer pt_abc")).toBe("pt_abc");
    expect(await probe("bearer pt_abc")).toBe("pt_abc");
    // Strict: a bare token, a Basic scheme and a tokenless Bearer are all
    // "no credential" -> null (which the route maps to 401).
    expect(await probe("pt_abc")).toBeNull();
    expect(await probe("Basic xyz")).toBeNull();
    expect(await probe("Bearer")).toBeNull();
    expect(await probe(undefined)).toBeNull();
  });
});
