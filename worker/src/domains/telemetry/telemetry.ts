/**
 * Telemetry ingest route — `POST /v1/telemetry`.
 *
 * This is the *ingest* half of A08; the pure validation half lives in
 * `validate-route.ts` + `shared/validation.ts` and is reused verbatim here.
 * Nothing about parsing, size/count gates or key/value rules is re-implemented
 * in this file: {@link readTelemetry} is the single entry point and the shared
 * module remains the single source of truth.
 *
 * What this route adds on top of validation
 * -----------------------------------------
 *   1. **Auth** — a presented token is verified through an injected seam
 *      ({@link VerifyToken}). Missing or unusable -> `401`.
 *   2. **Server-stamped time** — every accepted record is stamped with the
 *      *server's* clock (the injected `now` seam). Any device-supplied `ts`,
 *      `time` or `timestamp` field is IGNORED for ordering, so a device with a
 *      wrong clock cannot reorder the series.
 *   3. **Device key** — `x-insight-device` names the sender; when the header is
 *      absent or blank the request still counts against a stable default key
 *      (`DEFAULT_DEVICE_KEY`). The header is normalised (trimmed, clamped) so a
 *      blank value can never create a nameless device.
 *   4. **Auto-registration** — the first body seen for a device registers it
 *      through the {@link DeviceRegistry} seam. Registration is best-effort and
 *      idempotent: a device already known, or a concurrent first sighting, is
 *      never an error.
 *   5. **Persistence** — accepted metrics are handed to a {@link TelemetrySink}
 *      seam (one call per metric) carrying the *server* timestamp. The real
 *      Durable Object sink lands in A09; tests drive an in-memory fake.
 *
 * Response contract
 * -----------------
 *   * `204 No Content`                       — accepted and persisted.
 *   * `400` / `413` `{ error, message }`     — validation failure, status and
 *     code taken straight from the shared module (never remapped).
 *   * `401` `{ error: "unauthorized", ... }` — no token, or a token the
 *     verifier rejects.
 *
 * Everything is injected (verifier, sink, device registry, clock, limits) via
 * {@link TelemetryDeps} so the route is fully deterministic under test and the
 * concrete Cloudflare bindings can arrive later without touching this file.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import {
  DEFAULT_LIMITS,
  checkSize,
  validateTelemetry,
  type TelemetryLimits,
  type ValidTelemetry,
  type ValidationResult,
} from "../../shared/validation";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Clock seam. Returns Unix epoch milliseconds. Tests pass a fixed function so
 * the recorded timestamp is exactly knowable.
 */
export type Clock = () => number;

/**
 * Verifies a presented plaintext token and resolves it to a project.
 *
 * Production wraps `verifyProjectToken` over the D1-backed `TokenRepo`; tests
 * pass a stub. Returning `null` (or throwing) means "not usable" and the route
 * answers `401` — the two are deliberately indistinguishable to the client, so
 * a caller cannot probe *why* a token failed.
 */
export type VerifyToken = (token: string) => Promise<{ projectId: string } | null>;

/**
 * Persistence seam for accepted telemetry.
 *
 * One `record` call per accepted metric. `ts` is always the **server** clock,
 * never a value from the request body. Implementations must be idempotent-safe
 * against retries (the DO sink is expected to dedupe by `(project, device,
 * metric, ts)`); the route itself performs no deduplication.
 */
export interface TelemetrySink {
  record(
    projectId: string,
    device: string,
    metric: string,
    value: number | null,
    ts: number,
  ): Promise<void> | void;
}

/**
 * Device auto-registration seam.
 *
 * `register` is called the first time a device is seen for a project. It MUST
 * be idempotent (an already-registered device resolves successfully) and SHOULD
 * tolerate its return value being ignored — the route only needs to know the
 * device now exists, and a first-sighting race is not an error.
 */
export interface DeviceRegistry {
  register(projectId: string, device: string, ts: number): Promise<void> | void;
  /** Optional: when present, registration is skipped for a known device. */
  has?(projectId: string, device: string): Promise<boolean> | boolean;
}

/** Everything the route needs, injectable end-to-end for tests. */
export interface TelemetryDeps {
  /** Verify the presented bearer token -> project, or `null` to refuse. */
  readonly verifyToken: VerifyToken;
  /** Where accepted metrics land (real DO in A09). */
  readonly sink: TelemetrySink;
  /** First-sighting device registration. */
  readonly devices: DeviceRegistry;
  /** Server clock seam; the ONLY source of a record's timestamp. */
  readonly now?: Clock;
  /** Validation limits forwarded verbatim to the shared module. */
  readonly limits?: TelemetryLimits;
  /**
   * Device key used when `x-insight-device` is absent or blank. Defaults to
   * {@link DEFAULT_DEVICE_KEY} so an anonymous sender is still attributable.
   */
  readonly defaultDevice?: string;
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/** Header naming the sending device. */
export const DEVICE_HEADER = "x-insight-device";

/** Device key applied when the header is absent or blank. */
export const DEFAULT_DEVICE_KEY = "unknown";

/**
 * Longest device key we will persist. The header is attacker-controlled, so it
 * is clamped here as a defensive belt-and-braces limit on the device dimension
 * (metric keys themselves are bounded by the shared module's `keyPattern`).
 */
export const MAX_DEVICE_KEY_LENGTH = 128;

/** Default wall clock: Unix epoch milliseconds. */
const defaultClock: Clock = () => Date.now();

/** Error body for every `401`; reason is deliberately not differentiated. */
export interface UnauthorizedBody {
  error: "unauthorized";
  message: string;
}

/**
 * Normalise a raw `x-insight-device` header into a device key.
 *
 * `undefined`, an empty string and an all-whitespace string all collapse to the
 * supplied default, so a device can never be nameless. Longer values are
 * truncated to {@link MAX_DEVICE_KEY_LENGTH}.
 */
export function normaliseDevice(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return fallback;
  return trimmed.length > MAX_DEVICE_KEY_LENGTH
    ? trimmed.slice(0, MAX_DEVICE_KEY_LENGTH)
    : trimmed;
}

/**
 * Extract the plaintext token from the `Authorization` header.
 *
 * Accepts the `Bearer <token>` scheme case-insensitively. A bare token (no
 * scheme) is also accepted, which keeps simple `curl -H` probes workable. A
 * missing header, or a `Bearer` with no token behind it, yields `""`, which no
 * verifier accepts.
 */
export function readBearerToken(header: string | undefined): string {
  const raw = (header ?? "").trim();
  if (raw === "") return "";
  const scheme = /^Bearer\s*(.*)$/i.exec(raw);
  if (scheme !== null) return scheme[1].trim();
  return raw;
}

/** JSON `401` body, shared by both the missing-token and rejected-token paths. */
function unauthorized(c: Context): Response {
  const body: UnauthorizedBody = { error: "unauthorized", message: "a valid project token is required" };
  return c.json(body, 401);
}

/** JSON error body mirroring the shape produced by `validate-route.ts`. */
function errorResponse(c: Context, status: number, error: string, message: string): Response {
  return c.json({ error, message }, status as 400 | 413);
}

/**
 * Understood payload shapes, as a single lookup so the accepted set is declared
 * in one place. The validator never sees a body outside this set.
 */
const BODY_KINDS = ["metrics-array", "metrics-map", "metric-value", "bare-array"] as const;
type BodyKind = (typeof BODY_KINDS)[number];

/** The normalised, validator-ready form of an accepted body. */
interface NormalisedBody {
  readonly metrics: unknown;
}

/** Is `value` a plain object (not null, not an array)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detect which understood shape `parsed` is, or `undefined` if none match.
 *
 * Recognised, in precedence order:
 *   * `{ metrics: [...] }`  — canonical array of metric entries  (canonical)
 *   * `[...]`               — bare array of metric entries
 *   * `{ metrics: { k: v }}` — map of key -> value
 *   * `{ metric, value }`    — single metric (FR-DEV-03 shorthand)
 *
 * An unknown shape yields `undefined` so the caller can report `invalid_json`
 * using the exact message the shared validator itself would produce.
 */
function detectBodyKind(parsed: unknown): BodyKind | undefined {
  if (Array.isArray(parsed)) return "bare-array";
  if (!isPlainObject(parsed)) return undefined;
  if ("metrics" in parsed) {
    const metrics = parsed.metrics;
    if (Array.isArray(metrics)) return "metrics-array";
    if (isPlainObject(metrics)) return "metrics-map";
    return undefined;
  }
  if ("metric" in parsed) return "metric-value";
  return undefined;
}

/**
 * Rewrite any understood shape into the canonical `{ metrics: [...] }` the
 * shared validator consumes, delegating every per-entry rule to it afterwards.
 *
 * Conversions are shape-only — nothing here validates a key or a value:
 *   * `{ metric, value }`    -> `{ metrics: [{ key, value }] }`
 *   * `{ metrics: {k: v} }`  -> `{ metrics: [{ key: k, value: v }, ...] }`
 *   * `[...]` / canonical    -> unchanged
 *
 * The `metric-value` shape is turned into a `{ key, value }` pair with `metric`
 * as the key verbatim: a missing/non-string/blank `metric` is intentionally NOT
 * screened here, so the validator reports it as `invalid_key` (and a missing
 * `value` as `invalid_value`) — the authoritative codes.
 */
function normaliseBody(parsed: unknown): NormalisedBody | undefined {
  const kind = detectBodyKind(parsed);
  if (kind === undefined) return undefined;

  if (kind === "bare-array") return { metrics: parsed };

  const body = parsed as Record<string, unknown>;

  if (kind === "metrics-array") return { metrics: body.metrics };

  if (kind === "metrics-map") {
    const map = body.metrics as Record<string, unknown>;
    return { metrics: Object.entries(map).map(([key, value]) => ({ key, value })) };
  }

  // metric-value: build the pair and let the validator judge key and value.
  return { metrics: [{ key: body.metric, value: body.value }] };
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

/**
 * The ingest handler shape, named so consumers (and tests) can hold a reference
 * without reaching through `ReturnType<typeof ...>`.
 */
export type TelemetryHandler = (c: Context) => Promise<Response>;

/**
 * Build the telemetry ingest handler from injected dependencies.
 *
 * The returned function is a plain Hono handler; it is exposed separately from
 * the mounted router so tests (and later wiring) can drop it onto any path.
 *
 * Failure mapping, in the order the checks run:
 *   * no/invalid token            -> `401`
 *   * shared validation failure   -> that result's own `400` / `413`
 *   * otherwise                   -> persist, then `204`
 */
export function createTelemetryIngestHandler(deps: TelemetryDeps): TelemetryHandler {
  const now = deps.now ?? defaultClock;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const defaultDevice = deps.defaultDevice ?? DEFAULT_DEVICE_KEY;

  return async function telemetryIngestHandler(c: Context): Promise<Response> {
    // 1. AUTH — before touching the body, so unauthenticated payloads are never
    //    parsed or measured (no timing/size oracle for an anonymous caller).
    const token = readBearerToken(c.req.header("authorization"));
    if (token === "") return unauthorized(c);

    let project: { projectId: string } | null;
    try {
      project = await deps.verifyToken(token);
    } catch {
      // A throwing verifier is a refusal, not a 500: fail closed.
      project = null;
    }
    if (project === null) return unauthorized(c);

    // 2. NORMALISE — FR-DEV-01/03 accept both `{ metrics: {...} }` and the
    //    `{ metric, value }` shorthand beside the canonical `{ metrics: [...] }`
    //    shape. Only a *shape* rewrite happens here; every size / key / value /
    //    count / JSON rule is applied by the shared module in step 3.
    const raw = await c.req.text();

    // 2a. SIZE — the shared module's own size gate, run first and on the raw
    //     bytes so an oversized body is never parsed (same ordering it enforces
    //     internally). Its result is surfaced verbatim.
    const sized = checkSize(raw, limits);
    if (!sized.ok) return errorResponse(c, sized.status, sized.code, sized.message);

    // 2b. SHAPE — parse only to decide which understood shape this is. Anything
    //     unparseable or unrecognised is passed to the shared validator as the
    //     raw string, so it emits the authoritative `invalid_json` code/message.
    let normalised: NormalisedBody | string = raw;
    try {
      const parsedBody: unknown = JSON.parse(raw);
      normalised = normaliseBody(parsedBody) ?? raw;
    } catch {
      normalised = raw;
    }

    // 3. VALIDATE — delegated wholesale to the shared module. This is the ONLY
    //    place per-metric rules are applied; this file adds none. A normalised
    //    object is already `{ metrics: ... }`; a raw string lets the shared
    //    module report its own invalid_json/empty-body verdict.
    const result: ValidationResult<ValidTelemetry> = validateTelemetry(normalised, limits);
    if (!result.ok) return errorResponse(c, result.status, result.code, result.message);

    // 4. STAMP — server time is the sole timestamp. A device-supplied `ts`,
    //    `time` or `timestamp` is intentionally never read; `result.data`
    //    holds only validated `{key,value}` pairs, so device clocks cannot
    //    influence ordering.
    const ts = now();
    const device = normaliseDevice(c.req.header(DEVICE_HEADER), defaultDevice);
    const projectId = project.projectId;

    // 5. AUTO-REGISTER — first sighting only, and never fatal. An already-known
    //    device (or a concurrent first sighting) is a no-op, not an error.
    await ensureDevice(deps.devices, projectId, device, ts);

    // 6. PERSIST — one sink call per accepted metric carrying the server ts.
    const data: ValidTelemetry = result.data;
    for (const metric of data.metrics) {
      await deps.sink.record(projectId, device, metric.key, metric.value, ts);
    }

    return c.body(null, 204);
  };
}

/**
 * Register `device` unless the registry already knows it.
 *
 * Best-effort by design: a registry that reports the device as present skips
 * the write, and any failure to register is swallowed so a registry hiccup can
 * never drop a valid telemetry sample. Immutability of the sample flow is the
 * priority; registration is metadata.
 */
async function ensureDevice(
  devices: DeviceRegistry,
  projectId: string,
  device: string,
  ts: number,
): Promise<void> {
  try {
    if (devices.has !== undefined && (await devices.has(projectId, device))) return;
    await devices.register(projectId, device, ts);
  } catch {
    // Registration is advisory — never fail the ingest because of it.
  }
}

/**
 * Build a ready-to-mount Hono app exposing the ingest route at `POST /`.
 *
 * Mount with `app.route("/v1/telemetry", createTelemetryIngest(deps))`.
 */
export function createTelemetryIngest(deps: TelemetryDeps): Hono {
  const app = new Hono();
  app.post("/", createTelemetryIngestHandler(deps));
  return app;
}

// ---------------------------------------------------------------------------
// In-memory fakes — honest implementations of the seams, for tests and local dev
// ---------------------------------------------------------------------------

/** One persisted sample, exactly as the sink received it. */
export interface RecordedSample {
  readonly projectId: string;
  readonly device: string;
  readonly metric: string;
  readonly value: number | null;
  readonly ts: number;
}

/**
 * In-memory {@link TelemetrySink}.
 *
 * Keeps every call in arrival order so tests can assert the exact tuple
 * `(projectId, device, metric, value, ts)` — including that `ts` is the server
 * clock. Not a production store: it never dedupes and never evicts.
 */
export class InMemoryTelemetrySink implements TelemetrySink {
  readonly #samples: RecordedSample[] = [];

  record(
    projectId: string,
    device: string,
    metric: string,
    value: number | null,
    ts: number,
  ): void {
    this.#samples.push({ projectId, device, metric, value, ts });
  }

  /** Every sample received, in arrival order. */
  samples(): readonly RecordedSample[] {
    return this.#samples;
  }

  /** Convenience: the most recent sample, or `undefined` if none. */
  last(): RecordedSample | undefined {
    return this.#samples[this.#samples.length - 1];
  }

  /** Number of samples received. */
  get size(): number {
    return this.#samples.length;
  }
}

/** A device as known to {@link InMemoryDeviceRegistry}. */
export interface RegisteredDevice {
  readonly projectId: string;
  readonly device: string;
  /** Server-clock epoch ms of the FIRST sighting (later calls do not move it). */
  readonly firstSeenAt: number;
}

/**
 * In-memory {@link DeviceRegistry}.
 *
 * Registration is keyed by `(projectId, device)` and is idempotent: the first
 * sighting is kept, later ones are ignored — mirroring the "insert if absent"
 * semantics the DO will implement.
 */
export class InMemoryDeviceRegistry implements DeviceRegistry {
  readonly #devices = new Map<string, RegisteredDevice>();

  static #key(projectId: string, device: string): string {
    // NUL never appears in a normalised device key, so it is a safe separator.
    return `${projectId}\u0000${device}`;
  }

  has(projectId: string, device: string): boolean {
    return this.#devices.has(InMemoryDeviceRegistry.#key(projectId, device));
  }

  register(projectId: string, device: string, ts: number): void {
    const key = InMemoryDeviceRegistry.#key(projectId, device);
    if (this.#devices.has(key)) return; // first sighting wins
    this.#devices.set(key, { projectId, device, firstSeenAt: ts });
  }

  /** Every registered device, in first-sighting order. */
  all(): readonly RegisteredDevice[] {
    return Array.from(this.#devices.values());
  }

  /** Is `device` registered for `projectId`? */
  isRegistered(projectId: string, device: string): boolean {
    return this.has(projectId, device);
  }
}
