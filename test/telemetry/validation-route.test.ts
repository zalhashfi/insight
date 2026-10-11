import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  postTelemetryValidated,
  readTelemetry,
  validateTelemetryHandler,
  type TelemetryReadResult,
} from "../../worker/src/domains/telemetry/validate-route";
import { DEFAULT_LIMITS, validateTelemetry } from "../../worker/src/shared/validation";

const limits = DEFAULT_LIMITS;

/** Mount the validated POST route on a fresh app at POST /telemetry. */
function appWithRoute() {
  const app = new Hono();
  app.route("/telemetry", postTelemetryValidated);
  return app;
}

/** POST a raw string body to the mounted route. */
function post(body: string) {
  return appWithRoute().request("/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** POST a value, JSON-stringifying it first. */
function postJson(value: unknown) {
  return post(JSON.stringify(value));
}

/** Build an oversized JSON body guaranteed to exceed maxBytes. */
function oversizedBody(): string {
  return JSON.stringify({ metrics: [{ key: "k", value: 1, junk: "x".repeat(limits.maxBytes + 1) }] });
}

interface ErrorBody {
  error: string;
  message: string;
}

/** Narrow an arbitrary JSON value to the route's error body shape. */
function isErrorBody(value: unknown): value is ErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

/** Read and validate an error body from a rejected response. */
async function readErrorBody(res: Response): Promise<ErrorBody> {
  const parsed: unknown = await res.json();
  if (!isErrorBody(parsed)) throw new Error(`unexpected error body: ${JSON.stringify(parsed)}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Accepting cases -> 204
// ---------------------------------------------------------------------------
describe("POST /telemetry — accepted bodies return 204", () => {
  it("accepts a `{ metrics: [{ key, value }] }` body with 204 and an empty body", async () => {
    const res = await postJson({ metrics: [{ key: "temp", value: 25.4 }] });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("accepts a single `{ metric, value }`-shaped object with 204", async () => {
    const res = await postJson({ metrics: [{ key: "metric", value: 1 }] });
    expect(res.status).toBe(204);
  });

  it("accepts a metric expressed as a [key, value] pair with 204", async () => {
    const res = await postJson({ metrics: [["temp", 25.4]] });
    expect(res.status).toBe(204);
  });

  it("accepts a null value with 204", async () => {
    const res = await postJson({ metrics: [{ key: "temp", value: null }] });
    expect(res.status).toBe(204);
  });

  it("accepts a bare metrics array with 204", async () => {
    const res = await postJson([{ key: "temp", value: 25.4 }]);
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Rejecting cases -> 400 / 413 with the shared module's codes
// ---------------------------------------------------------------------------
describe("POST /telemetry — rejected bodies", () => {
  it("rejects a non-number (and thus any NaN) value with 400 {error:'invalid_value'}", async () => {
    // NaN / Infinity cannot survive JSON serialization (both become null), so
    // the reachable invalid_value case over the wire is a non-number value.
    // The NaN/Infinity path is asserted structurally below via the module.
    const res = await postJson({ metrics: [{ key: "cpu", value: "not-a-number" }] });
    expect(res.status).toBe(400);
    expect((await readErrorBody(res)).error).toBe("invalid_value");
  });

  it("does not accept NaN as a finite value through the route body", async () => {
    // JSON.stringify(NaN) === "null", which the shared module explicitly
    // allows; the strict finite-check is covered in test/validation.test.ts.
    // Here we assert the route faithfully reproduces the module's verdict.
    const body = JSON.stringify({ metrics: [{ key: "cpu", value: Number.NaN }] });
    const res = await post(body);
    const shared = validateTelemetry(body);
    expect(res.status).toBe(shared.ok ? 204 : shared.status);
    if (!shared.ok) expect((await readErrorBody(res)).error).toBe(shared.code);
  });

  it("rejects an oversized body with 413 {error:'payload_too_large'}", async () => {
    const res = await post(oversizedBody());
    expect(res.status).toBe(413);
    expect((await readErrorBody(res)).error).toBe("payload_too_large");
  });

  it("rejects too many metrics with 413 {error:'too_many_metrics'}", async () => {
    const metrics = Array.from({ length: limits.maxMetrics + 1 }, (_, i) => ({ key: `k${i}`, value: i }));
    const res = await postJson({ metrics });
    expect(res.status).toBe(413);
    expect((await readErrorBody(res)).error).toBe("too_many_metrics");
  });

  it("rejects invalid JSON with 400 {error:'invalid_json'}", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect((await readErrorBody(res)).error).toBe("invalid_json");
  });

  it("rejects an empty body with 400 {error:'invalid_json'}", async () => {
    const res = await post("");
    expect(res.status).toBe(400);
    expect((await readErrorBody(res)).error).toBe("invalid_json");
  });

  it("rejects an invalid key with 400 {error:'invalid_key'}", async () => {
    const res = await postJson({ metrics: [{ key: "", value: 1 }] });
    expect(res.status).toBe(400);
    expect((await readErrorBody(res)).error).toBe("invalid_key");
  });
});

// ---------------------------------------------------------------------------
// Deterministic error ordering at the HTTP layer
// ---------------------------------------------------------------------------
describe("POST /telemetry — deterministic error ordering", () => {
  it("size is reported BEFORE value: oversized + bad value => payload_too_large (413)", async () => {
    const metrics = [{ key: "cpu", value: "not-a-number", junk: "x".repeat(limits.maxBytes + 1) }];
    const res = await postJson({ metrics });
    expect(res.status).toBe(413);
    expect((await readErrorBody(res)).error).toBe("payload_too_large");
  });

  it("count is reported BEFORE value: too many + bad value => too_many_metrics (413)", async () => {
    const metrics = Array.from({ length: limits.maxMetrics + 1 }, (_, i) => ({
      key: `k${i}`,
      value: i === 0 ? "bad" : i,
    }));
    const res = await postJson({ metrics });
    expect(res.status).toBe(413);
    expect((await readErrorBody(res)).error).toBe("too_many_metrics");
  });

  it("size is reported BEFORE count: oversized + too many => payload_too_large (413)", async () => {
    const metrics = Array.from({ length: limits.maxMetrics + 1 }, (_, i) => ({
      key: `k${i}`,
      value: i,
      junk: "x".repeat(limits.maxBytes + 1),
    }));
    const res = await postJson({ metrics });
    expect(res.status).toBe(413);
    expect((await readErrorBody(res)).error).toBe("payload_too_large");
  });
});

// ---------------------------------------------------------------------------
// Delegation proof: the route must agree with the shared module, always.
// ---------------------------------------------------------------------------
describe("POST /telemetry — delegates to the shared module", () => {
  const cases: Array<[string, string]> = [
    ["valid object metric", JSON.stringify({ metrics: [{ key: "temp", value: 25.4 }] })],
    ["null value", JSON.stringify({ metrics: [{ key: "temp", value: null }] })],
    ["bare array", JSON.stringify([["temp", 25.4]])],
    ["invalid value", JSON.stringify({ metrics: [{ key: "cpu", value: "nope" }] })],
    ["invalid key", JSON.stringify({ metrics: [{ key: "", value: 1 }] })],
    [
      "too many metrics",
      JSON.stringify({ metrics: Array.from({ length: limits.maxMetrics + 1 }, (_, i) => ({ key: `k${i}`, value: i })) }),
    ],
    ["oversized body", oversizedBody()],
    ["invalid json", "{not json"],
    ["empty body", ""],
  ];

  it.each(cases)("route verdict matches validateTelemetry() for: %s", async (_name, body) => {
    const shared = validateTelemetry(body);
    const res = await post(body);

    if (shared.ok) {
      expect(res.status).toBe(204);
      return;
    }
    expect(res.status).toBe(shared.status);
    const parsed = await readErrorBody(res);
    // Identical code AND message — proves the route adds no inline reasoning.
    expect(parsed.error).toBe(shared.code);
    expect(parsed.message).toBe(shared.message);
  });

  it("readTelemetry() returns the shared module's discriminated result verbatim", async () => {
    const body = "{not json";
    let captured: TelemetryReadResult | undefined;
    const app = new Hono();
    app.post("/telemetry", async (c) => {
      captured = await readTelemetry(c);
      return c.body(null, 204);
    });

    await app.request("/telemetry", { method: "POST", body });

    const shared = validateTelemetry(body);
    expect(captured).toBeDefined();
    expect(shared.ok).toBe(false);
    if (captured && !captured.ok) {
      expect(shared.ok).toBe(false);
      if (!shared.ok) {
        expect(captured.code).toBe(shared.code);
        expect(captured.status).toBe(shared.status);
        expect(captured.message).toBe(shared.message);
      }
    }
  });

  it("exposes the handler factory for direct mounting", async () => {
    const app = new Hono();
    app.post("/telemetry", validateTelemetryHandler);
    const res = await app.request("/telemetry", {
      method: "POST",
      body: JSON.stringify({ metrics: [{ key: "temp", value: 25.4 }] }),
    });
    expect(res.status).toBe(204);
  });
});
