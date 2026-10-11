/**
 * FROZEN OTA CONTRACT LOCK — the single source of truth for the wire shape of
 * the OTA routes (spec §6.4 / §6.5), the device-side half of E03.
 *
 * This file is *test-only* (never imported by production code). It narrows the
 * device-facing lock in `./contract-lock.ts` to the two OTA routes and freezes
 * their shape so a pair of suites across two repos can assert against ONE
 * description:
 *
 *   * `insight/test/contracts/ota-contract.test.ts`   — mounts what the server
 *     actually exposes today and asserts the OTA shape EXACTLY; where a route
 *     is not implemented yet it asserts only the frozen shape / the route's
 *     ABSENCE, never an invented route.
 *   * `insight/test/contracts/mirror.test.ts`         — parses the SDK's C++
 *     mirror (`insight-sdk/test/test_contract/test_main.cpp`, namespace
 *     `contract`) TEXTUALLY and asserts these same frozen values, so a
 *     one-sided edit fails there.
 *   * `insight-sdk/test/test_contract/test_main.cpp`  — encodes the same shape
 *     in C++ constants and asserts the SDK's own behaviour against them.
 *
 * Rules for editing (identical to `contract-lock.ts`):
 *   * Field names, header names, media types, status codes and the retry
 *     parameter are the CONTRACT. Changing any value here MUST break the mirror
 *     guard (that is the point — this file is a tripwire).
 *   * Where the route does not exist yet, the shape is STILL recorded and
 *     clearly marked `implemented: false` (spec §6.4/§6.5; M3 tickets A18b /
 *     A18c). Never invent a server route to satisfy a shape.
 *
 * The values that overlap `contract-lock.ts` (`GET_OTA`, `STATUS`,
 * `CONTRACT_HEADERS`, `OTA_RESPONSE_FIELDS`, `OTA_UPDATE_FIELDS`) are re-exported
 * here rather than duplicated, so the two locks cannot drift from each other.
 */

// ---------------------------------------------------------------------------
// Narrow status names — reused so this lock and contract-lock.ts cannot drift.
// ---------------------------------------------------------------------------

import {
  CONTRACT_HEADERS,
  GET_OTA,
  OTA_RESPONSE_FIELDS,
  OTA_UPDATE_FIELDS,
  STATUS,
} from "./contract-lock";

export { CONTRACT_HEADERS, OTA_RESPONSE_FIELDS, OTA_UPDATE_FIELDS, STATUS };

/** The `sha256` field holds a LOWERCASE 64-hex-character digest (§6.4). */
export const OTA_SHA256_HEX_LENGTH = 64;

// ---------------------------------------------------------------------------
// GET /v1/ota — the offer (spec §6.4)
// ---------------------------------------------------------------------------

/**
 * The offer route's frozen description.
 *
 * Shape, frozen from spec §6.4:
 *   * request header `x-insight-firmware` — the RUNNING firmware version.
 *   * `200 {update: null}`                       — device is current.
 *   * `200 {update: {version,size,sha256,url}}`   — a newer firmware exists.
 *
 * `implemented: false` today (M3 ticket A18b): no `/v1/ota` Hono route is
 * wired in `worker/src/app.ts`, so `ota-contract.test.ts` asserts only this
 * shape and the route's absence — it never fabricates one. When A18b lands,
 * only `implemented` flips; the frozen fields below do not move.
 */
export const OTA_OFFER = {
  method: "GET",
  path: "/v1/ota",
  implemented: false, // M3 / A18b
  auth: "project-token (bearer)",
  /** The request header carrying the running firmware version. */
  requestHeader: CONTRACT_HEADERS.firmware,
  /** Accepts both frozen bodies; the response carries no other shape. */
  success: STATUS.ok,
  /** Envelope key: `update` (JSON null, or the object below). */
  envelopeField: OTA_RESPONSE_FIELDS[0],
  /** Fields of the `update` object when an update is available. */
  updateFields: OTA_UPDATE_FIELDS,
  /** The literal value of `update` when the device is current. */
  noUpdateValue: GET_OTA.noUpdateValue, // null
  /** Digest length, in hex characters, of the `sha256` field. */
  sha256HexLength: OTA_SHA256_HEX_LENGTH,
  errors: GET_OTA.errors,
} as const;

// ---------------------------------------------------------------------------
// GET /v1/ota/image — the image (spec §6.5)
// ---------------------------------------------------------------------------

/**
 * The image route's frozen description.
 *
 * Shape, frozen from spec §6.5:
 *   * `200 application/octet-stream` — the image bytes, streamed from R2.
 *   * `429` + `retry-after` header   — per-device/hour quota exhausted (D2.8).
 *   * `404`                          — the image was deleted / does not exist.
 *
 * `implemented: false` today (M3 ticket A18c): no `/v1/ota/image` Hono route
 * exists, so `ota-contract.test.ts` asserts only this shape and the route's
 * absence. The `x-insight-firmware` header rides the whole `/v1/ota` path
 * family (the SDK attaches it by prefix — see `InsightDevice.h`).
 */
export const OTA_IMAGE = {
  method: "GET",
  path: "/v1/ota/image",
  implemented: false, // M3 / A18c
  auth: "project-token (bearer)",
  requestHeader: CONTRACT_HEADERS.firmware,
  /** Success status + the exact media type of the body. */
  success: STATUS.ok,
  contentType: "application/octet-stream",
  /** Quota exhausted: status plus the header that schedules the retry. */
  rateLimited: {
    status: STATUS.tooManyRequests,
    header: "retry-after",
    /** Body/behaviour on a 429 is unspecified beyond these two facts. */
  },
  /** The image is gone: deleted or never uploaded. */
  notFound: {
    status: STATUS.notFound,
  },
} as const;

// ---------------------------------------------------------------------------
// Convenience aggregate
// ---------------------------------------------------------------------------

/** All OTA routes this lock covers (both pending until M3). */
export const OTA_ROUTES = {
  offer: OTA_OFFER,
  image: OTA_IMAGE,
} as const;

/**
 * Verbatim strings the SDK mirror must reproduce byte-for-byte. Kept together
 * so the mirror test can enumerate them without reaching into each route.
 */
export const OTA_LOCK_STRINGS = {
  offerPath: OTA_OFFER.path,
  imagePath: OTA_IMAGE.path,
  firmwareHeader: OTA_OFFER.requestHeader,
  envelopeField: OTA_OFFER.envelopeField,
  contentType: OTA_IMAGE.contentType,
  retryAfterHeader: OTA_IMAGE.rateLimited.header,
} as const;
