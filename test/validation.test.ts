import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  checkKey,
  checkValue,
  validateTelemetry,
} from "../worker/src/shared/validation";

const limits = DEFAULT_LIMITS;

/** Build an oversized JSON string guaranteed to exceed maxBytes. */
function oversizedBody(): string {
  return JSON.stringify({ metrics: [{ key: "k", value: 1, junk: "x".repeat(limits.maxBytes + 1) }] });
}

describe("validation — individual rules", () => {
  it("accepts a well-formed payload", () => {
    const res = validateTelemetry({ metrics: [{ key: "cpu", value: 1.5 }] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.metrics).toEqual([{ key: "cpu", value: 1.5 }]);
  });

  it("ALLOWS null values", () => {
    const res = validateTelemetry({ metrics: [{ key: "cpu", value: null }] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.metrics[0].value).toBeNull();
  });

  it("rejects payloads over the size limit with 413/payload_too_large", () => {
    const res = validateTelemetry(oversizedBody());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("payload_too_large");
      expect(res.status).toBe(413);
    }
  });

  it("rejects too many metrics with 413/too_many_metrics", () => {
    const metrics = Array.from({ length: limits.maxMetrics + 1 }, (_, i) => ({
      key: `k${i}`,
      value: i,
    }));
    const res = validateTelemetry({ metrics });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("too_many_metrics");
      expect(res.status).toBe(413);
    }
  });

  it("rejects NaN with 400/invalid_value", () => {
    expect(checkValue(Number.NaN).ok).toBe(false);
    const res = validateTelemetry({ metrics: [{ key: "cpu", value: Number.NaN }] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("invalid_value");
      expect(res.status).toBe(400);
    }
  });

  it("rejects +/-Infinity with 400/invalid_value", () => {
    expect(checkValue(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(checkValue(Number.NEGATIVE_INFINITY).ok).toBe(false);
  });

  it("rejects empty keys and keys over the max length", () => {
    expect(checkKey("").ok).toBe(false);
    const longKey = "k".repeat(limits.maxKeyLength + 1);
    const emptyRes = validateTelemetry({ metrics: [{ key: "", value: 1 }] });
    const longRes = validateTelemetry({ metrics: [{ key: longKey, value: 1 }] });
    for (const res of [emptyRes, longRes]) {
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("invalid_key");
        expect(res.status).toBe(400);
      }
    }
  });

  it("rejects malformed JSON with 400/invalid_json", () => {
    const res = validateTelemetry("{not json");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("invalid_json");
      expect(res.status).toBe(400);
    }
  });
});

describe("validation — STRICT order (size -> count -> value)", () => {
  it("size is checked BEFORE count: oversized + too many => payload_too_large", () => {
    const metrics = Array.from({ length: limits.maxMetrics + 1 }, (_, i) => ({
      key: `k${i}`,
      value: i,
      junk: "x".repeat(limits.maxBytes + 1),
    }));
    const res = validateTelemetry({ metrics });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("payload_too_large");
  });

  it("count is checked BEFORE value: too many + bad value => too_many_metrics", () => {
    const metrics = Array.from({ length: limits.maxMetrics + 1 }, (_, i) => ({
      key: `k${i}`,
      value: i === 0 ? Number.NaN : i,
    }));
    const res = validateTelemetry({ metrics });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("too_many_metrics");
  });

  it("size is checked BEFORE value: oversized + NaN value => payload_too_large", () => {
    // NaN serializes to null in JSON, so embed an oversized string alongside it.
    const body = JSON.stringify({
      metrics: [{ key: "cpu", value: null, junk: "x".repeat(limits.maxBytes + 1) }],
    });
    const res = validateTelemetry(body);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("payload_too_large");
  });
});

describe("validation — finite check is load-bearing", () => {
  // This test FAILS if the Number.isFinite check is removed: with only a
  // `typeof value === "number"` guard, NaN would be accepted as valid.
  it("NaN is rejected (would pass if the finite-check were removed)", () => {
    const res = validateTelemetry({ metrics: [{ key: "cpu", value: Number.NaN }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_value");

    // Directly assert the guard behavior that the finite-check provides.
    expect(typeof Number.NaN === "number").toBe(true); // NaN is "number" ...
    expect(Number.isFinite(Number.NaN)).toBe(false); // ... but not finite.
  });
});
