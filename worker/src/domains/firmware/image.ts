/**
 * firmware/image — OTA image download: `GET /v1/ota/image` (spec §6.5, A18c).
 *
 * This is the *read* half of OTA and the mirror of `firmware/upload.ts` (A18):
 * the upload puts bytes at a deterministic key and records a row; this module
 * streams those bytes back to a device. Like every other domain module it is a
 * **pure service over injected seams** — it reaches for no binding, no ambient
 * clock and no `env` — so its rules are pinned by a unit test rather than
 * through `createApp`.
 *
 * ## Three seams
 *
 *   1. {@link ImageReader} — the object store (R2 in production), the `get`
 *      that mirrors the upload's `put`. It returns either the bytes **or** the
 *      object's content type (the shape R2 itself returns), so the route never
 *      invents a media type for an object it did not write.
 *   2. {@link FirmwareLookup} — D1's `firmware` table (the same
 *      `(projectId, version)` row the upload writes), so the route resolves a
 *      version to its `r2Key` without re-deriving it.
 *   3. {@link ImageQuota} — the per-principal/hour budget (D2.8). The route asks
 *      it *before* it reads a single byte, so an over-quota request never
 *      touches the store.
 *
 * ## Ordering: quota → row → store. Nothing is streamed on a refusal.
 *
 * The order is load-bearing and observable at the wire:
 *
 *   * **Quota first.** The principal's hourly budget is charged before the bytes are
 *     fetched, so an exhausted principal cannot use the route to probe the store
 *     (or to burn bandwidth) — it gets `429` + `retry-after` and, crucially,
 *     **no body** (`Content-Length: 0`, zero bytes). A denied request is *free*:
 *     {@link ImageQuota.consume} is consulted exactly once and a denial records
 *     no new sample, so hammering a throttled route cannot extend the penalty.
 *   * **Then the row.** A version with no `firmware` row is `404` — the image
 *     does not exist for this project.
 *   * **Then the store.** A row whose object is gone (deleted out of band) is
 *     likewise `404`: the reader's rule is the upload's promise inverted — *a
 *     row implies a retrievable image*, and when it does not, the honest answer
 *     is "not found", never a `200` with an empty body and never a `500`.
 *
 * A quota is spent even when the image turns out to be missing (`404`): the
 * budget meters *attempts to download*, which is what D2.8 protects, and paying
 * for a lookup that found nothing is the same cost the store would have borne.
 * The order above is what makes that the case — the charge precedes the lookup.
 *
 * ## Success is the RAW bytes, not JSON
 *
 * A `200` carries the image verbatim, `Content-Type: application/octet-stream`
 * and an exact `Content-Length` (§6.5): the device buffers the body and verifies
 * `size`/`sha256` from the offer, so a re-encoded or enveloped body would fail
 * the check. Error paths (`404`, `429`) carry the frozen `{ error, message }`
 * body every other device route emits.
 *
 * ## Failure and quota bookkeeping never leak a `500`
 *
 * A store `get` that *throws* is treated as "not found" (fail closed to the
 * honest `404`), and a quota that throws is treated as "denied" (fail closed to
 * `429`) — the same posture the ingest route takes toward a broken rate limiter:
 * a guard that cannot be evaluated never opens the gate.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { readBearerToken, type Principal } from "../../platform/middleware/resolve-project";
import { imageQuotaKey } from "../../platform/quota/ota-quota";
import {
  DEFAULT_OTA_QUOTA_PER_HOUR,
  OTA_QUOTA_WINDOW_MS,
  type QuotaDecision,
} from "../../platform/quota/ota-quota";

// ---------------------------------------------------------------------------
// Frozen wire constants (mirror test/contracts/ota-lock.ts — the tripwire)
// ---------------------------------------------------------------------------

/** The media type of a streamed firmware image (spec §6.5). */
export const OTA_IMAGE_CONTENT_TYPE = "application/octet-stream";

/** The header a `429` carries to schedule the device's retry (RFC 9110). */
export const RETRY_AFTER_HEADER = "retry-after";

/** Frozen `429` — the per-device/hour quota is exhausted. */
export const IMAGE_RATE_LIMITED_STATUS = 429 as const;

/** Frozen `404` — the image was deleted or never uploaded. */
export const IMAGE_NOT_FOUND_STATUS = 404 as const;

/** Frozen `200` — the image bytes. */
export const IMAGE_OK_STATUS = 200 as const;

/** Frozen error code for an exhausted quota (matches the contract lock). */
export const IMAGE_RATE_LIMITED_CODE = "rate_limited" as const;

/** Frozen error code for a missing image. */
export const IMAGE_NOT_FOUND_CODE = "not_found" as const;

/**
 * Default quota: admitted image downloads per principal per hour.
 *
 * Re-exported from the ONE quota module (`platform/quota/ota-quota.ts`), so the
 * DO path and this route cannot drift to two different numbers for the same
 * hour.
 */
export const DEFAULT_OTA_IMAGE_QUOTA_PER_HOUR = DEFAULT_OTA_QUOTA_PER_HOUR;

/** One hour in milliseconds — the quota's window (D2.8), from the one module. */
export const OTA_IMAGE_QUOTA_WINDOW_MS = OTA_QUOTA_WINDOW_MS;

/** Header naming the requesting device; mirrors the ingest and control routes. */
export const DEVICE_HEADER = "x-insight-device";

/**
 * Device key applied when {@link DEVICE_HEADER} is absent or blank.
 *
 * NOTE: this header is used ONLY for the `ota_status`/`x-insight-device`
 * reporting concern, **never** for the quota. The quota key is derived from the
 * verified principal ({@link imageQuotaKey}), so a caller cannot mint a fresh
 * budget by rotating this client-controlled header.
 */
export const DEFAULT_DEVICE_KEY = "unknown";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The read side of the object-store seam — the `get` mirroring
 * {@link ImageStore.put} in `firmware/upload.ts`.
 *
 * `body` is the stored bytes and `contentType` the media type the object was
 * put with (R2 records both); a missing object resolves to `null`, never a
 * throw — the store's "not found" is data, not an error, so the route can tell
 * it apart from a transport failure.
 */
export interface ImageReader {
  get(
    key: string,
  ): Promise<{ body: Uint8Array; contentType: string } | null>;
}

/**
 * Metadata seam: D1's `firmware` table, reduced to the one lookup the route
 * needs — the object key for a `(projectId, version)`.
 *
 * Declared as its own minimal interface (rather than importing
 * {@link FirmwareRepo}) so the route is coupled only to the operation it uses
 * and a test can hand it a two-line stub. The production adapter forwards to
 * the repo's `find`.
 */
export interface FirmwareLookup {
  /** The `r2Key` for `(projectId, version)`, or `null` when no such row. */
  findKey(projectId: string, version: string): Promise<string | null>;
}

/** A quota denial, with the ready-to-send `retry-after` in whole seconds. */
export interface QuotaExceeded {
  readonly allowed: false;
  /** Whole seconds until the budget frees; `>= 1`, safe as `retry-after`. */
  readonly retryAfter: number;
}

/** A quota admission; nothing else is needed to serve the request. */
export interface QuotaAllowed {
  readonly allowed: true;
}

/** Discriminated outcome of {@link ImageQuota.consume}. */
export type { QuotaDecision };

/**
 * Per-principal/hour quota seam (D2.8 / INV-O2).
 *
 * `consume` is consulted exactly once per request, *before* the image is read;
 * it charges the **principal's** budget on admission and returns a denial (with
 * a `retry-after`) when the hour is spent.
 *
 * The key MUST be derived from the verified principal
 * ({@link imageQuotaKey}), never from a request header: a header is
 * client-controlled, so keying on it would let a caller rotate the value and
 * obtain a fresh budget at will. The one implementation of this seam is
 * {@link ../../platform/quota/ota-quota!MemoryOtaQuota} (in-memory) and the
 * `ProjectControl.checkAndConsumeOtaQuota` adapter (DO-backed); both are the
 * *same* algorithm — there is no second budget implementation here.
 */
export interface ImageQuota {
  /**
   * Charge one unit to `key` (a principal key), or deny with a `retry-after`.
   */
  consume(key: string): Promise<QuotaDecision>;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Verifies a presented token and resolves the credential's {@link Principal}.
 * Production wraps the D1-backed device-token verifier; tests pass a stub.
 * Returning `null` (or throwing) means "not usable" and the route answers `401`.
 */
export type VerifyImageToken = (token: string) => Promise<Principal | null>;

/** Everything `GET /v1/ota/image` needs, injectable end-to-end for tests. */
export interface ImageDeps {
  /** Object-store read seam (`R2`'s `get` in production). */
  readonly images: ImageReader;
  /** Metadata seam: `(projectId, version)` → `r2Key`. */
  readonly firmware: FirmwareLookup;
  /** Per-device/hour quota seam (D2.8). */
  readonly quota: ImageQuota;
  /** Verify the presented bearer token → {@link Principal}, or `null`. */
  readonly verifyToken: VerifyImageToken;
  /**
   * Resolve the requested firmware version. Defaults to reading the
   * `x-insight-firmware` header (the shared `/v1/ota` path family's header,
   * `OTA_IMAGE.requestHeader`); injected so a caller can pin a version another
   * way without re-implementing the route.
   */
  readonly version?: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** The handler shape, named so consumers can hold a reference. */
export type ImageHandler = (c: Context) => Promise<Response>;

/** Frozen `{ error, message }` body carried by a `429` / `404`. */
export interface ImageErrorBody {
  readonly error: string;
  readonly message: string;
}

/** The `{ error: "unauthorized" }` body; stable and non-probing. */
const UNAUTHORIZED_BODY: ImageErrorBody = {
  error: "unauthorized",
  message: "a valid project token is required",
};

/** The two frozen rejection bodies, built once. */
function rateLimitedBody(): ImageErrorBody {
  return { error: IMAGE_RATE_LIMITED_CODE, message: "OTA image quota exhausted; retry later" };
}

function notFoundBody(): ImageErrorBody {
  return { error: IMAGE_NOT_FOUND_CODE, message: "no firmware image for the requested version" };
}

/**
 * Authenticate the request, or return the `401` to answer it with.
 *
 * The credential is parsed with the SHARED strict Bearer grammar (a bare or
 * scheme-less `Authorization` is not a credential) then verified through the
 * injected seam; a verifier that *throws* is a refusal, not a `500`, so the
 * route fails closed rather than leaking an unenforceable mistake.
 */
async function authorise(c: Context, deps: ImageDeps): Promise<Principal | Response> {
  const token = readBearerToken(c);
  if (token === null) return c.json(UNAUTHORIZED_BODY, 401);

  let principal: Principal | null;
  try {
    principal = await deps.verifyToken(token);
  } catch {
    principal = null;
  }
  if (principal === null) return c.json(UNAUTHORIZED_BODY, 401);

  // Expose the verified tenant exactly the way `resolveProject` does, never one
  // derived from the URL.
  c.set("principal", principal);
  return principal;
}

/**
 * Build the `GET /v1/ota/image` handler.
 *
 * Order, each step's failure mapped to the frozen status:
 *   1. auth                       → `401` (fail closed)
 *   2. quota (per principal, per hour) → `429` + `retry-after`, **zero bytes**
 *   3. the `(projectId, version)` row → `404`
 *   4. the object itself           → `404` when gone, else `200` octet-stream
 */
export function createImageHandler(deps: ImageDeps): ImageHandler {
  return async function imageHandler(c: Context): Promise<Response> {
    // 1. AUTH — before anything is measured or fetched.
    const principal = await authorise(c, deps);
    if (principal instanceof Response) return principal;

    const projectId = principal.projectId;
    const version = deps.version ?? (c.req.header(OTA_IMAGE_REQUEST_HEADER) ?? "").trim();

    // 2. QUOTA — charged before the store is touched. The key is the VERIFIED
    //    PRINCIPAL (token/user id), never the `x-insight-device` header: that
    //    header is client-controlled, so keying on it would let a caller rotate
    //    it and mint a fresh budget on every request. A quota that throws is an
    //    unenforceable guard, so it fails closed to 429.
    const quotaKey = imageQuotaKey(principal);
    let decision: QuotaDecision;
    try {
      decision = await deps.quota.consume(quotaKey);
    } catch {
      decision = { allowed: false, retryAfter: 1 };
    }
    if (!decision.allowed) {
      return c.json(rateLimitedBody(), IMAGE_RATE_LIMITED_STATUS, {
        [RETRY_AFTER_HEADER]: String(decision.retryAfter),
      });
    }

    // 3. ROW — a version with no firmware row does not exist for this project.
    if (version === "") return c.json(notFoundBody(), IMAGE_NOT_FOUND_STATUS);
    const key = await deps.firmware.findKey(projectId, version);
    if (key === null) return c.json(notFoundBody(), IMAGE_NOT_FOUND_STATUS);

    // 4. STORE — a row whose object is gone is honestly "not found". A throwing
    //    read is treated the same way, never surfaced as a 500.
    let object: { body: Uint8Array; contentType: string } | null;
    try {
      object = await deps.images.get(key);
    } catch {
      object = null;
    }
    if (object === null) return c.json(notFoundBody(), IMAGE_NOT_FOUND_STATUS);

    // 5. SERVE — the RAW bytes, exactly as stored. The media type is the
    //    frozen octet-stream (§6.5); `Content-Length` is the exact byte count.
    const body = new Uint8Array(object.body).slice();
    return c.body(body, IMAGE_OK_STATUS, {
      "Content-Type": OTA_IMAGE_CONTENT_TYPE,
      "Content-Length": String(body.byteLength),
    });
  };
}

/** The request header carrying the running firmware version (shared family). */
export const OTA_IMAGE_REQUEST_HEADER = "x-insight-firmware";

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

/**
 * Build a ready-to-mount Hono app exposing `GET /v1/ota/image`.
 *
 * Mount with `app.route("/v1/ota/image", createOtaImage(deps))`; the handler
 * sits at `/`. Kept as its own router (like `createControl`) so a deploy wires
 * the OTA surface without inventing a path here.
 */
export function createOtaImage(deps: ImageDeps): Hono {
  const app = new Hono();
  app.get("/", createImageHandler(deps));
  return app;
}

export default createOtaImage;
