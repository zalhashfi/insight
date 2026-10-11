/**
 * FROZEN API CONTRACT LOCK — single source of truth for the wire shape of the
 * device-facing `insight` routes.
 *
 * This file is *test-only* (never imported by production code) and exists so a
 * pair of suites across two repos can assert against one frozen description:
 *
 *   * `insight/test/contracts/contract.test.ts`   — mounts the REAL Hono
 *     handlers and asserts their live responses match these shapes exactly.
 *   * `insight-sdk/test/test_contract/test_main.cpp` — mirrors the same status
 *     codes / error codes / header names and asserts the SDK's parsing and
 *     classification agree.
 *
 * Rules for editing:
 *   * Field names, status codes and error codes are the CONTRACT. Changing any
 *     value here MUST break the insight suite (that is the point — this file is
 *     the tripwire). See `contract.test.ts`.
 *   * Where the server route does not exist yet, the shape is still recorded
 *     and clearly marked `implemented: false`, per spec §6.4/§6.2. Never invent
 *     a server route to satisfy a shape.
 */

// ---------------------------------------------------------------------------
// Header names (device ingress)
// ---------------------------------------------------------------------------

/** Header names shared by the device-facing ingress routes. */
export const CONTRACT_HEADERS = {
  /** `Authorization: Bearer <project-token>` — project token auth. */
  authorization: "authorization",
  /** Optional device identity; blank/absent falls back to the default key. */
  device: "x-insight-device",
  /** Running firmware version, sent to `GET /v1/ota`. */
  firmware: "x-insight-firmware",
} as const;

/** Default device key when `x-insight-device` is absent or blank (spec §6.1). */
export const DEFAULT_DEVICE_KEY = "unknown";

/** Longest device key the ingress will persist (header is attacker-controlled). */
export const MAX_DEVICE_KEY_LENGTH = 128;

// ---------------------------------------------------------------------------
// Status codes
// ---------------------------------------------------------------------------

/**
 * The complete set of status codes the device-facing contract may return.
 * Frozen as an object so tests reference names, never bare literals.
 */
export const STATUS = {
  /** Accepted / acknowledged (telemetry ingest, control ack). */
  noContent: 204,
  /** A `GET` that succeeded (control, OTA check). */
  ok: 200,
  /** Malformed body, invalid value/key, or unusable token (auth is `unauthorized`). */
  badRequest: 400,
  /** No token, or a token the verifier rejects. */
  unauthorized: 401,
  /** Not found (e.g. an OTA image that has been deleted). */
  notFound: 404,
  /** Body too large, or too many metrics. */
  payloadTooLarge: 413,
  /** Rate limited (token or OTA per-device quota). */
  tooManyRequests: 429,
} as const;

export type StatusName = keyof typeof STATUS;
export type StatusCode = (typeof STATUS)[StatusName];

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Every `error` code the device-facing contract emits, mapped to the HTTP
 * status that carries it and whether the server route exists today.
 *
 * `implemented: false` means the code is part of the frozen spec shape but its
 * route is not wired yet (M3 / A18); the test asserts only the parts that
 * exist and records the rest.
 */
export const CONTRACT_ERRORS = {
  // --- live today --------------------------------------------------------
  invalid_json: { status: STATUS.badRequest, implemented: true },
  invalid_value: { status: STATUS.badRequest, implemented: true },
  invalid_key: { status: STATUS.badRequest, implemented: true },
  too_many_metrics: { status: STATUS.payloadTooLarge, implemented: true },
  payload_too_large: { status: STATUS.payloadTooLarge, implemented: true },
  unauthorized: { status: STATUS.unauthorized, implemented: true },
  // --- spec-frozen, route not wired yet (not invented) -------------------
  rate_limited: { status: STATUS.tooManyRequests, implemented: false },
} as const;

export type ErrorCode = keyof typeof CONTRACT_ERRORS;

/** The `{ error, message }` body every rejection carries. */
export const ERROR_BODY_FIELDS = ["error", "message"] as const;

// ---------------------------------------------------------------------------
// Priority: which error code wins when several rules are violated
// ---------------------------------------------------------------------------

/**
 * STRICT validation order (spec: size -> count -> value/key). A payload that
 * violates several rules fails with the code of the *earliest* rule. The order
 * is observable at the HTTP layer and therefore part of the contract.
 */
export const VALIDATION_PRIORITY: readonly ErrorCode[] = [
  "payload_too_large",
  "too_many_metrics",
  "invalid_key",
  "invalid_value",
  "invalid_json",
];

// ---------------------------------------------------------------------------
// Accepted telemetry payload shapes (spec §6.1)
// ---------------------------------------------------------------------------

/**
 * Understood request shapes for `POST /v1/telemetry`. Each maps to the same
 * normalised `{ metrics: [{ key, value }] }` the shared validator consumes.
 */
export const TELEMETRY_REQUEST_SHAPES = {
  /** `{"metrics":[{"key":"temp","value":25.4},{"key":"ok","value":null}]}` */
  metricsArray: { implemented: true },
  /** `{"metrics":{"temp":25.4,"ok":null}}` — map of key -> value. */
  metricsMap: { implemented: true },
  /** `{"metric":"temp","value":25.4}` — FR-DEV-03 shorthand. */
  metricValue: { implemented: true },
  /** `[{"key":"temp","value":25.4}]` — bare array of entries. */
  bareArray: { implemented: true },
} as const;

export type TelemetryRequestShape = keyof typeof TELEMETRY_REQUEST_SHAPES;

/** Field names of a single accepted metric entry. */
export const METRIC_FIELDS = ["key", "value"] as const;

/**
 * Field names of a successful `POST /v1/telemetry` response.
 * Deliberately EMPTY: success is `204 No Content` and carries no body.
 */
export const TELEMETRY_OK_BODY_FIELDS: readonly string[] = [];

// ---------------------------------------------------------------------------
// POST /v1/telemetry
// ---------------------------------------------------------------------------

export const POST_TELEMETRY = {
  method: "POST",
  path: "/v1/telemetry",
  implemented: true,
  auth: "project-token (bearer)",
  success: STATUS.noContent,
  headers: [CONTRACT_HEADERS.authorization, CONTRACT_HEADERS.device],
  requestShapes: TELEMETRY_REQUEST_SHAPES,
  /** Success carries no body; rejections carry `{ error, message }`. */
  successBodyFields: TELEMETRY_OK_BODY_FIELDS,
  errorBodyFields: ERROR_BODY_FIELDS,
  errors: [
    "invalid_json",
    "invalid_value",
    "invalid_key",
    "too_many_metrics",
    "payload_too_large",
    "unauthorized",
    "rate_limited",
  ] satisfies readonly ErrorCode[],
} as const;

// ---------------------------------------------------------------------------
// GET /v1/ota  (spec §6.4)
// ---------------------------------------------------------------------------

/**
 * Field names of the OTA envelope: `{"update": null | {...}}`.
 * `update` is a reserved envelope key holding the payload or JSON `null`.
 */
export const OTA_RESPONSE_FIELDS = ["update"] as const;

/** Field names of the `update` object when a newer firmware is available. */
export const OTA_UPDATE_FIELDS = ["version", "size", "sha256", "url"] as const;

/** `GET /v1/ota` — NOT implemented server-side yet (M3 / A18). */
export const GET_OTA = {
  method: "GET",
  path: "/v1/ota",
  /**
   * No Hono route exists today. The shape below is frozen from spec §6.4 so the
   * SDK can encode it; the insight suite MUST NOT fabricate the route and
   * asserts nothing about live behaviour here beyond the absence of a route.
   */
  implemented: false,
  auth: "project-token (bearer)",
  headers: [CONTRACT_HEADERS.authorization, CONTRACT_HEADERS.firmware],
  success: STATUS.ok,
  /** Envelope field list, longest-prefix-first (`update` before `update.version`). */
  bodyFields: [...OTA_RESPONSE_FIELDS, ...OTA_UPDATE_FIELDS.map((f) => `update.${f}`)],
  /** Up-to-date: `update` is JSON `null`. */
  noUpdateValue: null,
  /** Available: `update` is an object with exactly {@link OTA_UPDATE_FIELDS}. */
  updateFields: OTA_UPDATE_FIELDS,
  errors: [
    { code: "unauthorized", status: STATUS.unauthorized },
    { code: "rate_limited", status: STATUS.tooManyRequests },
  ],
} as const;

// ---------------------------------------------------------------------------
// GET /v1/control  (spec §6.2, read-only half of §6.3)
// ---------------------------------------------------------------------------

/** Field names of the control envelope: `{"control": [ ... ]}`. */
export const CONTROL_RESPONSE_FIELDS = ["control"] as const;

/** Field names of one pending control command. */
export const CONTROL_COMMAND_FIELDS = ["id", "variable", "value"] as const;

/** Field names of the `POST /v1/control/ack` body. */
export const CONTROL_ACK_REQUEST_FIELDS = ["ids"] as const;

/** `GET /v1/control` — the control read surface is not wired server-side yet. */
export const GET_CONTROL = {
  method: "GET",
  path: "/v1/control",
  implemented: false,
  auth: "project-token (bearer)",
  headers: [CONTRACT_HEADERS.authorization],
  success: STATUS.ok,
  /**
   * `control` is an ARRAY (reserved envelope key), flagging the SDK's index
   * scanner to look inside it rather than compare against a scalar sentinel.
   */
  bodyFields: CONTROL_RESPONSE_FIELDS,
  /** Each element of `control` has exactly {@link CONTROL_COMMAND_FIELDS}. */
  commandFields: CONTROL_COMMAND_FIELDS,
  /** Empty array = no pending commands (valid success). */
  emptyValue: [] as readonly unknown[],
  errors: [{ code: "unauthorized", status: STATUS.unauthorized }],
} as const;

/** `POST /v1/control/ack` — not wired server-side yet; shape frozen from §6.3. */
export const POST_CONTROL_ACK = {
  method: "POST",
  path: "/v1/control/ack",
  implemented: false,
  auth: "project-token (bearer)",
  requestFields: CONTROL_ACK_REQUEST_FIELDS,
  success: STATUS.noContent,
  successBodyFields: [] as readonly string[],
} as const;

// ---------------------------------------------------------------------------
// Convenience aggregate
// ---------------------------------------------------------------------------

/** All device-facing routes this lock covers, live and pending. */
export const CONTRACT_ROUTES = {
  postTelemetry: POST_TELEMETRY,
  getOta: GET_OTA,
  getControl: GET_CONTROL,
  postControlAck: POST_CONTROL_ACK,
} as const;
