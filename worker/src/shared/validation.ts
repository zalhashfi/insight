/**
 * Shared telemetry-payload validation.
 *
 * Pure, dependency-free functions. No I/O, no throwing — every failure is
 * reported through a discriminated result value so callers can map straight
 * onto HTTP responses.
 *
 * STRICT validation order (short-circuits on first failure):
 *   1. size   -> payload_too_large   (413)
 *   2. count  -> too_many_metrics    (413)
 *   3. value/key -> invalid_value / invalid_key / invalid_json (400)
 *
 * The order is observable: a payload that violates several rules at once
 * always fails with the code of the earliest rule in that list.
 */

/** Error codes returned by validation. */
export type ValidationErrorCode =
  | "invalid_json"
  | "invalid_value"
  | "invalid_key"
  | "too_many_metrics"
  | "payload_too_large";

/** Successful validation. */
export interface ValidationOk<T> {
  ok: true;
  data: T;
}

/** Failed validation. `status` is the HTTP status to surface. */
export interface ValidationErr {
  ok: false;
  code: ValidationErrorCode;
  status: number;
  message: string;
}

/** Discriminated result of a validation call. */
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

/** A single accepted metric after validation. */
export interface ValidMetric {
  key: string;
  value: number | null;
}

/** Accepted telemetry payload. */
export interface ValidTelemetry {
  metrics: ValidMetric[];
}

/** Tunable limits for {@link validateTelemetry}. */
export interface TelemetryLimits {
  /** Maximum allowed JSON body size, in bytes (UTF-8). */
  maxBytes: number;
  /** Maximum number of metrics allowed in one payload. */
  maxMetrics: number;
  /** Maximum allowed key length, in characters. */
  maxKeyLength: number;
  /** Telemetry keys must match this pattern (non-empty, bounded length). */
  keyPattern: RegExp;
}

/** Default limits. */
export const DEFAULT_LIMITS: TelemetryLimits = {
  maxBytes: 64 * 1024, // 64 KiB
  maxMetrics: 128,
  maxKeyLength: 128,
  keyPattern: /^[A-Za-z0-9_.:-]{1,128}$/,
};

/** Raw string or already-parsed object accepted as input. */
export type TelemetryInput = string | unknown;

const UTF8 = new TextEncoder();

/** Byte length of a UTF-8 string. */
export function byteLength(input: string): number {
  return UTF8.encode(input).length;
}

/**
 * Step 1 — size gate. Rejects bodies whose UTF-8 size exceeds `maxBytes`.
 * Must run before parsing/scanning so oversized payloads are never walked.
 */
export function checkSize(
  input: TelemetryInput,
  limits: TelemetryLimits = DEFAULT_LIMITS,
): ValidationResult<string> {
  const raw = typeof input === "string" ? input : JSON.stringify(input ?? "");
  if (byteLength(raw) > limits.maxBytes) {
    return {
      ok: false,
      code: "payload_too_large",
      status: 413,
      message: `payload exceeds ${limits.maxBytes} bytes`,
    };
  }
  return { ok: true, data: raw };
}

/**
 * Step 2 — count gate. Rejects payloads with more than `maxMetrics` entries.
 * Must run before per-metric value validation.
 */
export function checkCount(
  metrics: unknown[],
  limits: TelemetryLimits = DEFAULT_LIMITS,
): ValidationResult<unknown[]> {
  if (metrics.length > limits.maxMetrics) {
    return {
      ok: false,
      code: "too_many_metrics",
      status: 413,
      message: `payload has ${metrics.length} metrics, limit is ${limits.maxMetrics}`,
    };
  }
  return { ok: true, data: metrics };
}

/**
 * Step 3 — key gate. Rejects empty keys and keys over `maxKeyLength`.
 * `null` is not a valid key (it is not a string).
 */
export function checkKey(
  key: unknown,
  limits: TelemetryLimits = DEFAULT_LIMITS,
): ValidationResult<string> {
  if (typeof key !== "string") {
    return { ok: false, code: "invalid_key", status: 400, message: "metric key must be a string" };
  }
  if (key.length === 0) {
    return { ok: false, code: "invalid_key", status: 400, message: "metric key must not be empty" };
  }
  if (key.length > limits.maxKeyLength) {
    return {
      ok: false,
      code: "invalid_key",
      status: 400,
      message: `metric key exceeds ${limits.maxKeyLength} characters`,
    };
  }
  if (!limits.keyPattern.test(key)) {
    return { ok: false, code: "invalid_key", status: 400, message: "metric key has invalid characters" };
  }
  return { ok: true, data: key };
}

/**
 * Step 3 — value gate. `null` is explicitly ALLOWED. Every other value must
 * be a finite number; NaN, +/-Infinity and non-numbers are rejected.
 *
 * NOTE: `Number.isFinite` is what rejects NaN/Infinity. `typeof v === "number"`
 * alone would accept NaN and Infinity — see test/validation.test.ts.
 */
export function checkValue(value: unknown): ValidationResult<number | null> {
  if (value === null) {
    return { ok: true, data: null };
  }
  if (typeof value !== "number") {
    return { ok: false, code: "invalid_value", status: 400, message: "metric value must be a number or null" };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, code: "invalid_value", status: 400, message: "metric value must be finite" };
  }
  return { ok: true, data: value };
}

function parseBody(input: TelemetryInput): ValidationResult<unknown> {
  if (typeof input !== "string") {
    return { ok: true, data: input };
  }
  if (input.trim() === "") {
    return { ok: false, code: "invalid_json", status: 400, message: "empty body" };
  }
  try {
    return { ok: true, data: JSON.parse(input) as unknown };
  } catch {
    return { ok: false, code: "invalid_json", status: 400, message: "malformed JSON" };
  }
}

function toMetricArray(
  body: unknown,
): ValidationResult<unknown[]> {
  if (Array.isArray(body)) {
    return { ok: true, data: body };
  }
  if (body !== null && typeof body === "object") {
    const metrics = (body as Record<string, unknown>).metrics;
    if (Array.isArray(metrics)) {
      return { ok: true, data: metrics };
    }
  }
  return { ok: false, code: "invalid_json", status: 400, message: "expected an array of metrics" };
}

/**
 * Validate a telemetry payload.
 *
 * Accepts either a raw JSON string or an already-parsed value shaped as
 * `{ metrics: [...] }` (or a bare array of metrics). Returns a discriminated
 * result; `status` on failures is one of 400 or 413.
 *
 * Order is strict and observable: size -> count -> value/key.
 */
export function validateTelemetry(
  input: TelemetryInput,
  limits: TelemetryLimits = DEFAULT_LIMITS,
): ValidationResult<ValidTelemetry> {
  // 1. SIZE — always first, on the raw input.
  const sized = checkSize(input, limits);
  if (!sized.ok) return sized;

  // Parse after the size gate.
  const parsed = parseBody(input);
  if (!parsed.ok) return parsed;

  const asArray = toMetricArray(parsed.data);
  if (!asArray.ok) return asArray;
  const metrics = asArray.data;

  // 2. COUNT — before touching any individual metric.
  const counted = checkCount(metrics, limits);
  if (!counted.ok) return counted;

  // 3. VALUE / KEY — per metric, in document order.
  const out: ValidMetric[] = [];
  for (const entry of metrics) {
    let key: unknown;
    let value: unknown;

    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      key = rec.key;
      value = rec.value;
    } else if (Array.isArray(entry)) {
      key = entry[0];
      value = entry[1];
    } else {
      return { ok: false, code: "invalid_value", status: 400, message: "metric must be an object or pair" };
    }

    const keyRes = checkKey(key, limits);
    if (!keyRes.ok) return keyRes;

    const valueRes = checkValue(value);
    if (!valueRes.ok) return valueRes;

    out.push({ key: keyRes.data, value: valueRes.data });
  }

  return { ok: true, data: { metrics: out } };
}
