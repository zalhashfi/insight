import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  DEFAULT_DEVICE_KEY,
  InMemoryDeviceRegistry,
  InMemoryTelemetrySink,
  createTelemetryIngest,
  createTelemetryIngestHandler,
  normaliseDevice,
  readBearerToken,
  type RecordedSample,
  type TelemetryDeps,
  type TelemetryHandler,
  type VerifyToken,
} from "../../worker/src/domains/telemetry/telemetry";
import { DEFAULT_LIMITS, validateTelemetry } from "../../worker/src/shared/validation";

/**
 * Spec tests for the A08 telemetry ingest route (`POST /v1/telemetry`).
 *
 * Every dependency is injected, so each contract is asserted against a value we
 * control outright:
 *
 *   1. **Auth** — no token or a rejected token is `401`; a valid token resolves
 *      the project the samples are attributed to.
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
    overrides.verifyToken ?? (async (token) => (token === TOKEN ? { projectId: PROJECT } : null));

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

  it("attributes samples to the project returned by the verifier", async () => {
    const h = harness({ verifyToken: async () => ({ projectId: "proj_other" }) });
    await postJson(h.app, { metrics: { temp: 1 } }, { "x-insight-device": "dev-8" });

    expect(h.sink.last()!.projectId).toBe("proj_other");
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
      verifyToken: async () => ({ projectId: PROJECT }),
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

  it("readBearerToken accepts the Bearer scheme case-insensitively and bare tokens", () => {
    expect(readBearerToken("Bearer pt_abc")).toBe("pt_abc");
    expect(readBearerToken("bearer pt_abc")).toBe("pt_abc");
    expect(readBearerToken("pt_abc")).toBe("pt_abc");
    expect(readBearerToken("Bearer   ")).toBe("");
    expect(readBearerToken(undefined)).toBe("");
  });
});
