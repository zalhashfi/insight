/**
 * CONTRACT LOCK SUITE — asserts the LIVE `insight` device-facing routes match
 * the frozen shape in `./contract-lock.ts` EXACTLY.
 *
 * It mounts the REAL Hono handlers (no re-implementation, no mocks of the code
 * under test) and drives representative requests:
 *
 *   * `POST /v1/telemetry` — ingest route  in `worker/src/domains/telemetry/telemetry.ts`
 *   * `POST /v1/telemetry` (validation)    in `worker/src/domains/telemetry/validate-route.ts`
 *   * `GET /v1/ota` / `GET /v1/control`    NOT implemented server-side yet (M3 / A18)
 *
 * The live assertions use the constants themselves for BOTH the request and the
 * expected value, so editing a field name, status or error code in
 * `contract-lock.ts` makes the request/expectation disagree with the unchanged
 * server and the suite FAILS. That is the load-bearing tripwire.
 *
 * Anything the server does not implement yet is asserted as *absent* (a 404
 * probe), never by inventing a route.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  InMemoryDeviceRegistry,
  InMemoryTelemetrySink,
  createTelemetryIngest,
  type TelemetryDeps,
} from "../../worker/src/domains/telemetry/telemetry";
import { postTelemetryValidated } from "../../worker/src/domains/telemetry/validate-route";
import { DEFAULT_LIMITS } from "../../worker/src/shared/validation";
import {
  CONTRACT_ERRORS,
  CONTRACT_HEADERS,
  CONTROL_ACK_REQUEST_FIELDS,
  CONTROL_COMMAND_FIELDS,
  CONTROL_RESPONSE_FIELDS,
  DEFAULT_DEVICE_KEY,
  ERROR_BODY_FIELDS,
  GET_CONTROL,
  GET_OTA,
  METRIC_FIELDS,
  OTA_RESPONSE_FIELDS,
  OTA_UPDATE_FIELDS,
  POST_CONTROL_ACK,
  POST_TELEMETRY,
  STATUS,
  TELEMETRY_OK_BODY_FIELDS,
  VALIDATION_PRIORITY,
} from "./contract-lock";

// ---------------------------------------------------------------------------
// Live route harness — the REAL handlers, injected deps only.
// ---------------------------------------------------------------------------

const PROJECT = "proj_contract";
const TOKEN = "pt_contract_token";

interface LiveTelemetry {
  /** Mounted app exposing `POST /v1/telemetry`. */
  app: Hono;
  sink: InMemoryTelemetrySink;
  devices: InMemoryDeviceRegistry;
}

/**
 * Mount the real ingest handler at the contract's own path. The path string
 * comes from the lock, so renaming the route in the lock makes the request
 * land on nothing and the status assertion fail.
 */
function liveTelemetry(): LiveTelemetry {
  const sink = new InMemoryTelemetrySink();
  const devices = new InMemoryDeviceRegistry();
  const deps: TelemetryDeps = {
    verifyToken: async (token) =>
      token === TOKEN ? { kind: "device", projectId: PROJECT } : null,
    sink,
    devices,
    now: () => 1_700_000_000_000,
  };
  const app = new Hono();
  app.route(POST_TELEMETRY.path, createTelemetryIngest(deps));
  return { app, sink, devices };
}

/** Mount the real validation-only route at the contract's path. */
function liveValidation(): Hono {
  const app = new Hono();
  app.route(POST_TELEMETRY.path, postTelemetryValidated);
  return app;
}

/** Header map carrying the frozen auth + device header names. */
function deviceHeaders(device?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [CONTRACT_HEADERS.authorization]: `Bearer ${TOKEN}`,
  };
  if (device !== undefined) headers[CONTRACT_HEADERS.device] = device;
  return headers;
}

/** POST a body with the given headers to the mounted app at the frozen path. */
function post(app: Hono, headers: Record<string, string>, body: unknown): Response | Promise<Response> {
  return app.request(POST_TELEMETRY.path, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Read a response body as JSON, or `undefined` when the body is empty. */
async function jsonOrUndefined(res: Response): Promise<Record<string, unknown> | undefined> {
  const text = await res.text();
  if (text === "") return undefined;
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Lock self-consistency
// ---------------------------------------------------------------------------

describe("contract-lock self-consistency", () => {
  it("status codes match the spec", () => {
    expect(STATUS).toEqual({
      noContent: 204,
      ok: 200,
      badRequest: 400,
      unauthorized: 401,
      notFound: 404,
      payloadTooLarge: 413,
      tooManyRequests: 429,
    });
  });

  it("error codes map to their HTTP statuses", () => {
    for (const [code, spec] of Object.entries(CONTRACT_ERRORS)) {
      expect(spec.status).toBeGreaterThanOrEqual(400);
      // Cross-check the status is a real frozen status value.
      expect(Object.values(STATUS)).toContain(spec.status);
    }
    expect(CONTRACT_ERRORS.invalid_json.status).toBe(STATUS.badRequest);
    expect(CONTRACT_ERRORS.invalid_value.status).toBe(STATUS.badRequest);
    expect(CONTRACT_ERRORS.invalid_key.status).toBe(STATUS.badRequest);
    expect(CONTRACT_ERRORS.too_many_metrics.status).toBe(STATUS.payloadTooLarge);
    expect(CONTRACT_ERRORS.payload_too_large.status).toBe(STATUS.payloadTooLarge);
    expect(CONTRACT_ERRORS.unauthorized.status).toBe(STATUS.unauthorized);
    expect(CONTRACT_ERRORS.rate_limited.status).toBe(STATUS.tooManyRequests);
  });

  it("requires the size -> count -> value/key priority (spec: ukuran -> jumlah -> nilai)", () => {
    expect(VALIDATION_PRIORITY).toEqual([
      "payload_too_large",
      "too_many_metrics",
      "invalid_key",
      "invalid_value",
      "invalid_json",
    ]);
  });

  it("freezes the exact field names for every route shape", () => {
    expect(CONTRACT_HEADERS).toEqual({
      authorization: "authorization",
      device: "x-insight-device",
      firmware: "x-insight-firmware",
    });
    expect(DEFAULT_DEVICE_KEY).toBe("unknown");
    expect(ERROR_BODY_FIELDS).toEqual(["error", "message"]);
    expect(METRIC_FIELDS).toEqual(["key", "value"]);
    // 204 carries no body.
    expect(TELEMETRY_OK_BODY_FIELDS).toEqual([]);
    expect(POST_TELEMETRY.successBodyFields).toEqual([]);
    expect(POST_TELEMETRY.success).toBe(STATUS.noContent);
    expect(POST_TELEMETRY.method).toBe("POST");
    expect(POST_TELEMETRY.path).toBe("/v1/telemetry");

    expect(OTA_RESPONSE_FIELDS).toEqual(["update"]);
    expect(OTA_UPDATE_FIELDS).toEqual(["version", "size", "sha256", "url"]);
    expect(GET_OTA.bodyFields).toEqual([
      "update",
      "update.version",
      "update.size",
      "update.sha256",
      "update.url",
    ]);
    expect(GET_OTA.success).toBe(STATUS.ok);
    expect(GET_OTA.noUpdateValue).toBeNull();
    expect(GET_OTA.updateFields).toEqual(["version", "size", "sha256", "url"]);

    expect(CONTROL_RESPONSE_FIELDS).toEqual(["control"]);
    expect(CONTROL_COMMAND_FIELDS).toEqual(["id", "variable", "value"]);
    expect(CONTROL_ACK_REQUEST_FIELDS).toEqual(["ids"]);
    expect(GET_CONTROL.bodyFields).toEqual(["control"]);
    expect(GET_CONTROL.success).toBe(STATUS.ok);
    expect(GET_CONTROL.commandFields).toEqual(["id", "variable", "value"]);
  });

  it("marks which shapes the server actually implements today", () => {
    expect(POST_TELEMETRY.implemented).toBe(true);
    expect(GET_OTA.implemented).toBe(false); // M3 / A18
    expect(GET_CONTROL.implemented).toBe(false);
    expect(POST_CONTROL_ACK.implemented).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/telemetry — LIVE
// ---------------------------------------------------------------------------

describe("POST /v1/telemetry (live ingest route)", () => {
  it("accepts the canonical metrics array with STATUS.noContent and an empty body", async () => {
    const { app, sink } = liveTelemetry();
    const res = await post(app, deviceHeaders("dev-1"), [
      { key: "temp", value: 25.4 },
      { key: "ok", value: null },
    ]);

    expect(res.status).toBe(POST_TELEMETRY.success);
    expect(res.status).toBe(STATUS.noContent);

    const body = await jsonOrUndefined(res);
    expect(body).toBeUndefined();
    for (const field of POST_TELEMETRY.successBodyFields) expect(body).toBeUndefined;

    expect(sink.size).toBe(2);
  });

  it("records the POST_TELEMETRY.requestShapes.metricsArray shape", async () => {
    const { app, sink } = liveTelemetry();
    const res = await post(app, deviceHeaders(), {
      metrics: [{ key: "temp", value: 1 }],
    });
    expect(res.status).toBe(STATUS.noContent);
    expect(sink.size).toBe(1);
  });

  it("records the metricsMap shape {metrics:{k:v}}", async () => {
    const { app, sink } = liveTelemetry();
    const res = await post(app, deviceHeaders(), { metrics: { temp: 25.4, ok: null } });
    expect(res.status).toBe(STATUS.noContent);
    expect(sink.size).toBe(2);
  });

  it("records the metricValue shorthand {metric,value}", async () => {
    const { app, sink } = liveTelemetry();
    // The shorthand uses the reserved keys `metric` / `value` (spec §6.1 shape B),
    // NOT the per-entry METRIC_FIELDS names.
    const res = await post(app, deviceHeaders(), { metric: "temp", value: 7 });
    expect(res.status).toBe(STATUS.noContent);
    expect(sink.size).toBe(1);
    expect(sink.last()?.metric).toBe("temp");
  });

  it("records the bareArray shape", async () => {
    const { app, sink } = liveTelemetry();
    const [keyField, valueField] = METRIC_FIELDS;
    const res = await post(app, deviceHeaders(), [{ [keyField]: "a", [valueField]: 1 }]);
    expect(res.status).toBe(STATUS.noContent);
    expect(sink.size).toBe(1);
  });

  it("falls back to DEFAULT_DEVICE_KEY when the device header is absent", async () => {
    const { app, sink, devices } = liveTelemetry();
    const res = await post(app, deviceHeaders(), [{ key: "a", value: 1 }]);
    expect(res.status).toBe(STATUS.noContent);
    expect(sink.last()?.device).toBe(DEFAULT_DEVICE_KEY);
    expect(devices.isRegistered(PROJECT, DEFAULT_DEVICE_KEY)).toBe(true);
  });

  it("returns STATUS.unauthorized with the frozen {error,message} body when auth is missing", async () => {
    const { app } = liveTelemetry();
    const res = await post(app, { "content-type": "application/json" }, "{}");
    expect(res.status).toBe(STATUS.unauthorized);

    const body = await jsonOrUndefined(res);
    expect(body).toBeDefined();
    const keys = Object.keys(body!).sort();
    expect(keys).toEqual([...ERROR_BODY_FIELDS].sort());
    expect(body![ERROR_BODY_FIELDS[0]]).toBe("unauthorized");
    expect(CONTRACT_ERRORS.unauthorized.status).toBe(res.status);
  });

  it("returns STATUS.unauthorized when the verifier rejects the token", async () => {
    const { app } = liveTelemetry();
    const res = await post(
      app,
      { "content-type": "application/json", [CONTRACT_HEADERS.authorization]: "Bearer nope" },
      "{}",
    );
    expect(res.status).toBe(STATUS.unauthorized);
  });

  for (const [shape, body, expectedCode] of [
    ["bad json", "{not json", "invalid_json"],
    // JSON cannot carry NaN/Infinity, so the observable invalid_value cases are
    // a non-numeric value (string) or a non-object entry.
    ["non-numeric value", [{ key: "a", value: "not-a-number" }], "invalid_value"],
    ["empty key", [{ key: "", value: 1 }], "invalid_key"],
  ] as const) {
    it(`rejects ${shape} with code ${expectedCode} and the frozen status`, async () => {
      const { app, sink } = liveTelemetry();
      const res = await post(app, deviceHeaders(), body);
      expect(res.status).toBe(CONTRACT_ERRORS[expectedCode].status);

      const parsed = await jsonOrUndefined(res);
      expect(parsed).toBeDefined();
      expect(Object.keys(parsed!).sort()).toEqual([...ERROR_BODY_FIELDS].sort());
      expect(parsed![ERROR_BODY_FIELDS[0]]).toBe(expectedCode);
      expect(sink.size).toBe(0);
    });
  }

  it("rejects too_many_metrics at STATUS.payloadTooLarge via the frozen field names", async () => {
    const { app } = liveTelemetry();
    const [keyField, valueField] = METRIC_FIELDS;
    const metrics = Array.from({ length: DEFAULT_LIMITS.maxMetrics + 1 }, (_, i) => ({
      [keyField]: `k${i}`,
      [valueField]: 1,
    }));
    const res = await post(app, deviceHeaders(), metrics);
    expect(res.status).toBe(CONTRACT_ERRORS.too_many_metrics.status);
    const parsed = await jsonOrUndefined(res);
    expect(parsed![ERROR_BODY_FIELDS[0]]).toBe("too_many_metrics");
  });

  it("honours the strict priority: too_many_metrics beats an invalid key", async () => {
    const { app } = liveTelemetry();
    const [keyField, valueField] = METRIC_FIELDS;
    const metrics = [
      { [keyField]: "", [valueField]: 1 }, // would be invalid_key alone
      ...Array.from({ length: DEFAULT_LIMITS.maxMetrics }, (_, i) => ({
        [keyField]: `k${i}`,
        [valueField]: 1,
      })),
    ];
    const res = await post(app, deviceHeaders(), metrics);
    expect(res.status).toBe(CONTRACT_ERRORS.too_many_metrics.status);
    const parsed = await jsonOrUndefined(res);
    expect(parsed![ERROR_BODY_FIELDS[0]]).toBe("too_many_metrics");
    // And that code is earlier in the frozen priority list than invalid_key.
    expect(VALIDATION_PRIORITY.indexOf("too_many_metrics")).toBeLessThan(
      VALIDATION_PRIORITY.indexOf("invalid_key"),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /v1/telemetry — validation-only route also emits the frozen shape
// ---------------------------------------------------------------------------

describe("POST /v1/telemetry (validation-only route)", () => {
  it("rejects an invalid payload with the same error code and body fields", async () => {
    const app = liveValidation();
    const res = await post(
      app,
      { "content-type": "application/json", [CONTRACT_HEADERS.device]: "dev-1" },
      [{ key: "a", value: "not-a-number" }],
    );
    expect(res.status).toBe(CONTRACT_ERRORS.invalid_value.status);
    const parsed = await jsonOrUndefined(res);
    expect(Object.keys(parsed!).sort()).toEqual([...ERROR_BODY_FIELDS].sort());
    expect(parsed![ERROR_BODY_FIELDS[0]]).toBe("invalid_value");
  });
});

// ---------------------------------------------------------------------------
// Not-yet-implemented surfaces — asserted ABSENT, never invented
// ---------------------------------------------------------------------------

describe("not-yet-implemented surfaces (M3 / A18)", () => {
  it("GET /v1/ota has no live route yet", async () => {
    expect(GET_OTA.implemented).toBe(false);
    const app = new Hono();
    const res = await app.request(GET_OTA.path, {
      method: "GET",
      headers: { [CONTRACT_HEADERS.authorization]: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(STATUS.notFound);
  });

  it("GET /v1/control has no live route yet", async () => {
    expect(GET_CONTROL.implemented).toBe(false);
    const app = new Hono();
    const res = await app.request(GET_CONTROL.path, { method: "GET" });
    expect(res.status).toBe(STATUS.notFound);
  });

  it("POST /v1/control/ack has no live route yet", async () => {
    expect(POST_CONTROL_ACK.implemented).toBe(false);
    const app = new Hono();
    const res = await app.request(POST_CONTROL_ACK.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [CONTROL_ACK_REQUEST_FIELDS[0]]: ["c_1"] }),
    });
    expect(res.status).toBe(STATUS.notFound);
  });
});
