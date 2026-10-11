/**
 * firmware/upload-route — the admin OTA upload surface (A18 / FR-OTA-01).
 *
 * `firmware/upload.ts` (A18) owns the *operation*: size gate → SHA-256 → object
 * store → `firmware` row, in that order so a row never describes bytes that are
 * not stored. It implements **no HTTP route** — and until now nothing mounted
 * it, so an admin had no way to upload an image through the API and the whole
 * OTA family had nothing to serve. This module is the missing wire: the route
 * plus the admin gate that belongs in front of it.
 *
 * ```
 *   POST /v1/admin/projects/:proj/firmware
 *     → 201 { firmware: {...}, key, replaced }   stored
 *     → 400 { error: "invalid_input" }           blank version, bad body
 *     → 403 { error: "insufficient_scope" }      member (admin+ required)
 *     → 409 { error: "firmware_exists" }         conflict policy "reject"
 *     → 413 { error: "payload_too_large" }        body > 8 MiB
 * ```
 *
 * ## Authorization: `project:update` (admin or owner)
 *
 * The route assumes the caller was authenticated upstream by the shared
 * {@link resolveAdminProject} gate (a *user session*) and that `:proj` was
 * matched against the session. It then enforces the **capability** the gate
 * leaves to the handler: uploading firmware is a mutation of project state, so
 * it requires `project:update` (the `admin` tier) through the same membership
 * permission table every other mutating route uses. A `member` is `403`.
 *
 * ## The size gate is the SERVICE's, and its `413` is forwarded verbatim
 *
 * The route does not re-measure the body: {@link FirmwareUploadService.upload}
 * measures the exact bytes and throws {@link FirmwareError} `payload_too_large`
 * (→ 413) for a body strictly greater than 8 MiB, storing nothing. Forwarding
 * that error verbatim keeps one source of truth for the limit.
 *
 * ## Body shapes
 *
 * Two accepted encodings, so both a browser form and a simple client work:
 *
 *   * `multipart/form-data` with a `file` part (the image) and a `version`
 *     field — the shape an admin console sends;
 *   * a raw body with the version in the `x-insight-firmware` header — the
 *     shape a script or the SDK sends.
 *
 * The version is taken from the multipart `version` field when present, else
 * the `x-insight-firmware` header. The bytes are the `file` part, else the raw
 * request body. Either way the bytes handed to the service are a `Uint8Array`
 * of the exact octets, never a re-encoded copy.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import {
  FirmwareUploadService,
  isFirmwareError,
  uploadFirmwareFromBody,
  type Firmware,
} from "./upload";
import { isMembershipError, type MembershipService } from "../projects/membership";
import {
  resolveAdminProject,
  type CredentialLookup,
  type Principal,
} from "../../platform/middleware/resolve-project";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The permission uploading firmware requires (`project:update` — admin+). */
export const UPLOAD_PERMISSION = "project:update" as const;

/** Hono context key the upstream admin gate uses to pin the principal. */
export const PRINCIPAL_CONTEXT_KEY = "principal";

/** The multipart field carrying the firmware image. */
export const UPLOAD_FILE_FIELD = "file";

/** The multipart field carrying the firmware version. */
export const UPLOAD_VERSION_FIELD = "version";

/** The header carrying the version for a raw-body upload (shared OTA family). */
export const UPLOAD_VERSION_HEADER = "x-insight-firmware";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Everything the upload route needs, injectable end-to-end for tests. */
export interface FirmwareUploadRouteDeps {
  /** The upload operation (validate → digest → put → row). */
  readonly uploads: FirmwareUploadService;
  /** Membership service used for the admin+ (`403`) gate. */
  readonly membership: MembershipService;
}

/** Body of a successful `POST .../firmware`. */
export interface FirmwareUploadBody {
  readonly firmware: Firmware;
  readonly key: string;
  readonly replaced: boolean;
}

/** The `{ error, message }` body every rejection carries. */
export interface FirmwareUploadRouteErrorBody {
  readonly error: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

interface ParsedUpload {
  readonly version: string;
  readonly bytes: Uint8Array;
}

/**
 * Read the version + bytes from either supported encoding.
 *
 * Returns `null` only when neither encoding yields bytes at all — a genuinely
 * empty request — which the service would also reject; a blank version is left
 * for the service's own `invalid_input` so the rule lives in one place.
 */
async function parseUpload(c: Context): Promise<ParsedUpload | null> {
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return null;
    }
    const version = form.get(UPLOAD_VERSION_FIELD);
    const file = form.get(UPLOAD_FILE_FIELD);
    const versionText = typeof version === "string" ? version : "";
    if (file === null) {
      // No file part: fall back to the version header and an empty body, which
      // the service refuses as invalid input rather than the route inventing a
      // different code.
      const header = c.req.header(UPLOAD_VERSION_HEADER) ?? "";
      return { version: versionText || header, bytes: new Uint8Array(0) };
    }
    const bytes = await uploadFirmwareFromBody(file as Blob);
    return { version: versionText, bytes };
  }

  // Raw-body encoding: version from the header, bytes from the request body.
  const version = (c.req.header(UPLOAD_VERSION_HEADER) ?? "").trim();
  let bytes: Uint8Array;
  try {
    bytes = await uploadFirmwareFromBody(await c.req.arrayBuffer());
  } catch {
    return null;
  }
  return { version, bytes };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** The handler shape, named so a consumer can hold a reference. */
export type FirmwareUploadHandler = (c: Context) => Promise<Response>;

/**
 * Build the `POST /:proj/firmware` handler.
 *
 * Steps, in order (fail closed):
 *   1. read the pinned principal (missing/wrong kind → `401`);
 *   2. authorize `project:update` (member → `403`);
 *   3. parse the body into `(version, bytes)`;
 *   4. upload; a `FirmwareError` maps to its frozen status + code.
 */
export function createFirmwareUploadHandler(
  deps: FirmwareUploadRouteDeps,
): FirmwareUploadHandler {
  return async function firmwareUploadHandler(c: Context): Promise<Response> {
    // 1. The principal is pinned upstream by resolveAdminProject. Read it
    //    defensively: a missing principal means a mis-mount; fail closed.
    const principal = c.get(PRINCIPAL_CONTEXT_KEY) as Principal | undefined;
    if (principal === undefined || principal === null || principal.kind !== "user") {
      const body: FirmwareUploadRouteErrorBody = {
        error: "unauthorized",
        message: "a user session is required",
      };
      return c.json(body, 401);
    }

    // 2. Authorization FIRST: an admin+ gate through the shared permission
    //    table, so a member is refused before any bytes are read or stored.
    try {
      await deps.membership.assertPermission(
        principal.projectId,
        principal.userId,
        UPLOAD_PERMISSION,
      );
    } catch (err) {
      if (isMembershipError(err)) {
        if (err.code === "project_not_found") {
          const body: FirmwareUploadRouteErrorBody = {
            error: "project_not_found",
            message: `no project ${principal.projectId}`,
          };
          return c.json(body, 404);
        }
        const body: FirmwareUploadRouteErrorBody = {
          error: "insufficient_scope",
          message: `uploading firmware requires the "${UPLOAD_PERMISSION}" capability (admin or owner)`,
        };
        return c.json(body, 403);
      }
      throw err;
    }

    // 3. Parse the body; an unreadable body is a 400, not a 500.
    const parsed = await parseUpload(c);
    if (parsed === null) {
      const body: FirmwareUploadRouteErrorBody = {
        error: "invalid_input",
        message: "a firmware image body is required",
      };
      return c.json(body, 400);
    }

    // 4. Upload. The size gate (413) and every other rule are the service's;
    //    its typed error maps straight onto the frozen wire shape.
    try {
      const result = await deps.uploads.upload({
        projectId: principal.projectId,
        version: parsed.version.trim(),
        body: parsed.bytes,
      });
      const body: FirmwareUploadBody = {
        firmware: result.firmware,
        key: result.key,
        replaced: result.replaced,
      };
      return c.json(body, 201);
    } catch (err) {
      if (isFirmwareError(err)) {
        const body: FirmwareUploadRouteErrorBody = { error: err.code, message: err.message };
        return c.json(body, err.status as 400 | 409 | 413);
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

/** Options for {@link createFirmwareUploadRoute}. */
export interface FirmwareUploadRouteOptions extends FirmwareUploadRouteDeps {
  /**
   * The credential seam the built-in admin gate uses to resolve a session. Omit
   * (the default in tests) to expose the handler with no gate, assuming an
   * upstream one; supply it so the route is fail-closed on its own.
   */
  readonly credentials?: CredentialLookup;
}

/**
 * Build a ready-to-mount Hono app exposing `POST /:proj/firmware`.
 *
 * Mount with `app.route("/v1/admin/projects", createFirmwareUploadRoute({...}))`.
 * When {@link FirmwareUploadRouteOptions.credentials} is supplied the shared
 * {@link resolveAdminProject} gate is mounted on the sub-tree first.
 */
export function createFirmwareUploadRoute(options: FirmwareUploadRouteOptions): Hono {
  const app = new Hono();
  if (options.credentials !== undefined) {
    app.use(
      "/:proj/firmware",
      resolveAdminProject({
        deviceTokens: options.credentials.deviceTokens,
        sessions: options.credentials.sessions,
      }),
    );
  }
  app.post("/:proj/firmware", createFirmwareUploadHandler(options));
  return app;
}

export default createFirmwareUploadRoute;
