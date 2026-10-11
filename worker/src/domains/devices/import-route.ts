/**
 * devices/import-route — the admin device-import surface (A34 / FR-DEV-06).
 *
 * `POST /v1/admin/projects/:proj/devices/import` is the *transport* half of the
 * bulk import: it does no lexing, no validation and no storage of its own. It
 * only
 *
 *   1. reads the principal pinned by the upstream {@link resolveAdminProject}
 *      gate and refuses a missing/wrong-kind one (fail closed, `401`);
 *   2. authorizes `project:update` (admin+) through the membership table —
 *      BEFORE the body is read, so a member cannot use the route to probe;
 *   3. selects the wire format from `?format=` (or the `Content-Type`) and hands
 *      the raw body to the real {@link DeviceImportService};
 *   4. maps the service's typed outcome — the created/failed report, or a
 *      whole-file {@link DeviceImportError} such as the size gate's `413` —
 *      onto the frozen HTTP contract.
 *
 * The service is the SINGLE source of truth for every business rule (required
 * fields, the lifecycle vocabulary, duplicate policy, tenant scoping, the byte
 * cap). This route never re-implements one: it is wiring, exactly as the rest of
 * the app is. An imported device is therefore indistinguishable from one created
 * through the single-device API, because both commit through the same
 * {@link DeviceMetadataService}.
 *
 * ## Why admin-gated, and why the gate is the shared one
 *
 * A bulk import is a *mutation of project state en masse* — the same class of
 * action as the OTA upload (A18) and the automation manual-run (A21c), and it
 * sits behind the SAME shared admin gate (M3's convention):
 *
 *   * {@link resolveAdminProject} authenticates the session, separates the
 *     credential families (a device token is a wrong-kind `401`) and matches a
 *     `:proj` claim against the session — all at the middleware;
 *   * the handler then enforces the `project:update` capability (admin+) through
 *     the membership table, so a `member` session is `403` before any bytes are
 *     read.
 *
 * The delegate `DeviceImportService.importDevices` is injected, so the route is
 * a pure function of its seams and tests drive it with real in-memory stores.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import {
  DeviceImportService,
  DeviceImportError,
  isDeviceImportError,
  parseImportFormat,
  IMPORT_FORMAT_PARAM,
  type DeviceImportFormat,
  type DeviceImportResult,
} from "./import";
import { isMembershipError, type MembershipService } from "../projects/membership";
import {
  resolveAdminProject,
  type CredentialLookup,
  type Principal,
} from "../../platform/middleware/resolve-project";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The capability a bulk import requires: `project:update`, i.e. the `admin`
 * tier of the membership table. Importing creates devices en masse, so a
 * `member` cannot do it — the route is a mutation, not a read.
 */
export const IMPORT_PERMISSION = "project:update" as const;

/** Hono context key the upstream admin gate uses to pin the principal. */
export const PRINCIPAL_CONTEXT_KEY = "principal";

/** The mount path of the import surface, frozen so a route/test agree. */
export const DEVICE_IMPORT_PATH = "/:proj/devices/import";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Everything the import route needs, injectable end-to-end for tests. */
export interface DeviceImportRouteDeps {
  /**
   * The bulk import operation — the domain service, or any object shaped like
   * it. Injected rather than constructed so a test drives the route over an
   * in-memory store, and a deploy can widen `limits` without a second service.
   */
  readonly imports: DeviceImportService;
  /** Membership service used for the admin+ (`403`) gate. */
  readonly membership: MembershipService;
  /**
   * Default format when neither `?format=` nor the `Content-Type` names one.
   * Defaults to `"csv"` — the format a field engineer's spreadsheet arrives in.
   */
  readonly defaultFormat?: DeviceImportFormat;
}

/** Body of a successful `POST …/devices/import`. */
export type DeviceImportBody = DeviceImportResult;

/** The `{ error, message }` body every rejection carries. */
export interface DeviceImportRouteErrorBody {
  readonly error: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Format selection
// ---------------------------------------------------------------------------

/**
 * Pick the wire format from the request: an explicit `?format=` wins, then the
 * `Content-Type`, then the configured default. An explicit but unusable token
 * returns `null` so the caller can answer `400` rather than silently guessing —
 * a caller who said `?format=xml` should be told, not handed a CSV parse.
 */
function selectFormat(c: Context, fallback: DeviceImportFormat): DeviceImportFormat | null {
  const explicit = c.req.query(IMPORT_FORMAT_PARAM);
  if (explicit !== undefined) return parseImportFormat(explicit);
  const contentType = c.req.header("content-type");
  return parseImportFormat(contentType) ?? fallback;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** The handler shape, named so a consumer can hold a reference. */
export type DeviceImportHandler = (c: Context) => Promise<Response>;

/**
 * Build the `POST /:proj/devices/import` handler.
 *
 * Steps, in order (fail closed):
 *   1. read the pinned principal (missing/wrong kind → `401`);
 *   2. authorize `project:update` (member → `403`);
 *   3. select the format (`?format=`/`Content-Type`/default; unusable → `400`);
 *   4. read the raw body and import; a `DeviceImportError` (including the size
 *      gate's `413`) maps to its frozen status, otherwise `200` with the report.
 */
export function createDeviceImportHandler(
  deps: DeviceImportRouteDeps,
): DeviceImportHandler {
  const defaultFormat = deps.defaultFormat ?? "csv";

  return async function deviceImportHandler(c: Context): Promise<Response> {
    // 1. The principal is pinned upstream by resolveAdminProject. Read it
    //    defensively: a missing principal means a mis-mount, and a device
    //    principal never belongs on this admin surface — both fail closed.
    const principal = c.get(PRINCIPAL_CONTEXT_KEY) as Principal | undefined;
    if (principal === undefined || principal === null || principal.kind !== "user") {
      const body: DeviceImportRouteErrorBody = {
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
        IMPORT_PERMISSION,
      );
    } catch (err) {
      if (isMembershipError(err)) {
        if (err.code === "project_not_found") {
          const body: DeviceImportRouteErrorBody = {
            error: "project_not_found",
            message: `no project ${principal.projectId}`,
          };
          return c.json(body, 404);
        }
        const body: DeviceImportRouteErrorBody = {
          error: "insufficient_scope",
          message: `importing devices requires the "${IMPORT_PERMISSION}" capability (admin or owner)`,
        };
        return c.json(body, 403);
      }
      throw err;
    }

    // 3. Format selection. An explicit-but-unusable `?format=` is a `400`, not a
    //    silent fallback to CSV — the caller asked for something we do not do.
    const format = selectFormat(c, defaultFormat);
    if (format === null) {
      const body: DeviceImportRouteErrorBody = {
        error: "invalid_format",
        message: `unsupported import format (expected csv or json)`,
      };
      return c.json(body, 400);
    }

    // 4. Reject an oversized upload BEFORE buffering it when the client declares
    //    a `Content-Length`: the service's own byte cap (413) would otherwise only
    //    run after the whole body is already in memory. A chunked upload (no
    //    Content-Length) still falls through to the service cap, which gates
    //    parsing; this pre-check additionally bounds the buffered body.
    const maxBytes = deps.imports.limits.maxBytes;
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      const body: DeviceImportRouteErrorBody = {
        error: "payload_too_large",
        message: `import body exceeds the ${maxBytes}-byte limit`,
      };
      return c.json(body, 413);
    }

    // Read the raw body, then import. The service re-checks the byte cap against
    // the ACTUAL length (`payload_too_large`, 413) before it lexes, so a body
    // that lies about its Content-Length — or has none — is still refused.
    const data = await c.req.text();

    try {
      const result = await deps.imports.importDevices({
        projectId: principal.projectId,
        data,
        format,
      });
      return c.json(result, 200);
    } catch (err) {
      if (isDeviceImportError(err)) {
        const body: DeviceImportRouteErrorBody = { error: err.code, message: err.message };
        return c.json(body, err.status as 400 | 413);
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

/** Options for {@link createDeviceImportRoute}. */
export interface DeviceImportRouteOptions extends DeviceImportRouteDeps {
  /**
   * The credential seam the built-in admin gate uses to resolve a session. Omit
   * (the default in tests) to expose the handler with no gate, assuming an
   * upstream one; supply it so the route is fail-closed on its own.
   */
  readonly credentials?: CredentialLookup;
}

/**
 * Build a ready-to-mount Hono app exposing `POST /:proj/devices/import`.
 *
 * Mount with `app.route("/v1/admin/projects", createDeviceImportRoute({...}))`.
 * When {@link DeviceImportRouteOptions.credentials} is supplied the shared
 * {@link resolveAdminProject} gate is mounted on the sub-tree first, so a
 * missing/unknown/wrong-kind credential is a fail-closed `401` and a `:proj`
 * claim that contradicts the session is `403` — before the handler runs. When
 * it is omitted the app assumes an upstream gate (the harness supplies one),
 * which is what keeps this module's own tests free of a credential fixture.
 */
export function createDeviceImportRoute(options: DeviceImportRouteOptions): Hono {
  const app = new Hono();
  if (options.credentials !== undefined) {
    app.use(
      DEVICE_IMPORT_PATH,
      resolveAdminProject({
        deviceTokens: options.credentials.deviceTokens,
        sessions: options.credentials.sessions,
      }),
    );
  }
  app.post(DEVICE_IMPORT_PATH, createDeviceImportHandler(options));
  return app;
}

export default createDeviceImportRoute;

// Re-exported so a consumer wiring this route needs one import, not two.
export { DeviceImportService, DeviceImportError, isDeviceImportError };
