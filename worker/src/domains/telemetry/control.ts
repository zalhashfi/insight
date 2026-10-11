/**
 * Device control (downlink) routes — `GET /v1/control` and `POST /v1/control/ack`.
 *
 * These are the *device-facing* half of the project control plane: the surface a
 * device polls to learn what a project is asking of it, and the one it calls to
 * confirm it acted. The lifecycle itself — pending → acked, and pending →
 * expired past the TTL — is owned *entirely* by
 * {@link ../../platform/durable-objects/project-control!ProjectControl}; this
 * module re-implements none of it. It is a thin HTTP adapter over that seam:
 *
 *   | route                  | behaviour                                       |
 *   |------------------------|-------------------------------------------------|
 *   | `GET  /v1/control`     | `200 { control: [{ id, variable, value }] }`     |
 *   | `POST /v1/control/ack` | `204` (idempotent)                               |
 *
 * ## Only the pending, live commands are ever returned
 *
 * The read route asks {@link ProjectControl.pendingControls} for this device's
 * commands and projects each row down to exactly `{ id, variable, value }` — the
 * fields the frozen contract names ({@link CONTROL_COMMAND_FIELDS}). Because the
 * seam drops acked rows and *persists* any row past its TTL as `expired` before
 * returning, an acknowledged command disappears and a command past its TTL is
 * never delivered (INV-T6 / ST-T6) — not on this poll and not on a later one.
 * Neither rule is restated here; both are the seam's, so the two can never
 * disagree.
 *
 * ## Acknowledgement is idempotent, by construction
 *
 * {@link ProjectControl.ackControls} treats a re-ack, an unknown id and an
 * already-expired id as no-ops, never errors. The route therefore simply hands
 * the ids over and answers `204`; a device that retries its acknowledgement —
 * because its `204` was lost — is not punished for it.
 *
 * ## Auth: a device project token, fail closed
 *
 * The credential is parsed by the SHARED strict Bearer parser
 * ({@link readBearerToken} from `resolve-project.ts`) and verified through the
 * injected {@link VerifyControlToken} seam. No token, a non-Bearer header, or a
 * token the verifier rejects is `401 { error: "unauthorized" }` — the code the
 * frozen contract names (`GET_CONTROL.errors` / `CONTRACT_ERRORS.unauthorized`).
 * The resolved principal's project scopes every call, so one project's token can
 * never observe or acknowledge another project's commands.
 *
 * ## Everything non-deterministic is injected
 *
 * The {@link ControlPlane} seam (the `ProjectControl` in production, an
 * in-memory fake in tests) and the {@link VerifyControlToken} verifier arrive
 * through {@link ControlDeps}; the module reaches for no binding, no ambient
 * clock and no `env`.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { readBearerToken, type Principal } from "../../platform/middleware/resolve-project";
import type { PendingControl } from "../../platform/durable-objects/project-control";

// ---------------------------------------------------------------------------
// Frozen wire field names (mirrors test/contracts/contract-lock.ts)
// ---------------------------------------------------------------------------

/** Envelope field of `GET /v1/control`: `{ "control": [ ... ] }`. */
export const CONTROL_RESPONSE_FIELDS = ["control"] as const;

/** Field names of one delivered command: exactly these three, in this order. */
export const CONTROL_COMMAND_FIELDS = ["id", "variable", "value"] as const;

/** Request field of `POST /v1/control/ack`: `{ "ids": [ ... ] }`. */
export const CONTROL_ACK_REQUEST_FIELDS = ["ids"] as const;

/** Header carrying the credential, mirroring every other device route. */
export const AUTHORIZATION_HEADER = "authorization";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The control plane this route is a transport for.
 *
 * A structural subset of the `ProjectControl` class in
 * `platform/durable-objects/project-control.ts`, named here (rather than
 * importing the concrete class as the type) so a test can hand in a plain fake
 * and the route still composes. `ProjectControl` satisfies
 * this shape as-is, so production injects the real instance and tests inject a
 * fake with exactly these two methods.
 */
export interface ControlPlane {
  /**
   * The commands a device should act on right now: pending only, never acked,
   * never expired. Omitted `device` means "every device" — see
   * {@link ControlDeps.scopeToDevice} for why the route always passes one.
   */
  pendingControls(device?: string): Promise<readonly PendingControl[]>;
  /**
   * Acknowledge commands by id. Idempotent: an already-acked, expired or
   * never-enqueued id is a no-op, never an error.
   */
  ackControls(ids: readonly string[]): Promise<readonly string[]>;
}

/**
 * Verifies a presented plaintext token and resolves it to the credential's
 * {@link Principal}.
 *
 * Production wraps the D1-backed project-token verifier (which returns a
 * `DevicePrincipal` carrying its `projectId` and `scopes`); tests pass a stub.
 * Returning `null` (or throwing) means "not usable" and the route answers `401`.
 * The two are deliberately indistinguishable to the client, so a caller cannot
 * probe *why* a token failed.
 */
export type VerifyControlToken = (token: string) => Promise<Principal | null>;

/** Everything the downlink routes need, injectable end-to-end for tests. */
export interface ControlDeps {
  /** The project control plane (`ProjectControl` in production). */
  readonly control: ControlPlane;
  /** Verify the presented bearer token -> {@link Principal}, or `null`. */
  readonly verifyToken: VerifyControlToken;
  /**
   * Bind each call to the *device that made it*, so a poll returns only the
   * commands addressed to it. `false` lists every device's pending commands in
   * the project — the seam's own default — and is useful for a project-level
   * admin view, but is never what a device-facing deploy should serve.
   */
  readonly scopeToDevice?: boolean;
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/** Header naming the sending device; mirrors the ingest route. */
export const DEVICE_HEADER = "x-insight-device";

/** Device key applied when the header is absent or blank. */
export const DEFAULT_DEVICE_KEY = "unknown";

/** One command as the wire carries it: exactly `{ id, variable, value }`. */
export interface ControlCommandBody {
  readonly id: string;
  readonly variable: string;
  readonly value: string | null;
}

/** Body of `GET /v1/control`. */
export interface ControlBody {
  readonly control: readonly ControlCommandBody[];
}

/** The `{ error, message }` body every rejection carries. */
export interface ControlErrorBody {
  readonly error: "unauthorized";
  readonly message: string;
}

/**
 * Authenticate a device request, or return the `401` to answer it with.
 *
 * The credential is parsed with the SHARED strict Bearer grammar — a bare or
 * scheme-less `Authorization` is not a credential at all — then verified through
 * the injected seam; a verifier that *throws* is a refusal, not a `500`, so the
 * route fails closed rather than leaking an unenforceable mistake.
 */
async function authorise(c: Context, deps: ControlDeps): Promise<Principal | Response> {
  const deny = (): Response =>
    c.json(
      { error: "unauthorized", message: "a valid project token is required" } satisfies ControlErrorBody,
      401,
    );

  const token = readBearerToken(c);
  if (token === null) return deny();

  let principal: Principal | null;
  try {
    principal = await deps.verifyToken(token);
  } catch {
    principal = null;
  }
  if (principal === null) return deny();

  // Expose the resolved principal exactly the way `resolveProject` does, so a
  // downstream reader sees the *verified* tenant, never one derived from the URL.
  c.set("principal", principal);
  return principal;
}

/**
 * Parse and validate the `{ ids: [...] }` acknowledgement body.
 *
 * Returns the id list, or `null` when the body is not an object carrying an
 * array of strings. A malformed body is a `400` rather than a silent
 * "nothing to ack", so a device learns its request was not understood.
 */
async function readAckIds(c: Context): Promise<readonly string[] | null> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const ids = (parsed as Record<string, unknown>)[CONTROL_ACK_REQUEST_FIELDS[0]];
  if (!Array.isArray(ids)) return null;
  if (!ids.every((id): id is string => typeof id === "string")) return null;
  return ids;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** The handler shape, named so consumers can hold a reference. */
export type ControlHandler = (c: Context) => Promise<Response>;

/**
 * Build the `GET /v1/control` handler.
 *
 * Auth first (so an anonymous poll never reaches the store), then the device's
 * pending commands read from the injected seam and projected down to
 * `{ id, variable, value }`. Acked and expired commands are already excluded by
 * `pendingControls`, so nothing additional is filtered here.
 */
export function createControlHandler(deps: ControlDeps): ControlHandler {
  const scopeToDevice = deps.scopeToDevice ?? true;
  return async function controlHandler(c: Context): Promise<Response> {
    const principal = await authorise(c, deps);
    if (principal instanceof Response) return principal;
    void principal.projectId; // scopes the call to the credential's tenant

    // Absent/blank device header collapses to the default key, so a caller can
    // never be nameless; `scopeToDevice: false` asks for every device's pending
    // commands (the seam's own default) instead.
    const header = (c.req.header(DEVICE_HEADER) ?? "").trim();
    const device = scopeToDevice
      ? header === ""
        ? DEFAULT_DEVICE_KEY
        : header
      : undefined;

    const rows = await deps.control.pendingControls(device);
    // Project each stored row down to exactly the contract's three fields; the
    // seam has already excluded acked and expired commands.
    const body: ControlBody = {
      control: rows.map((row) => ({ id: row.id, variable: row.variable, value: row.value })),
    };
    return c.json(body, 200);
  };
}

/**
 * Build the `POST /v1/control/ack` handler.
 *
 * Auth first, then a batch acknowledgement handed straight to the idempotent
 * seam. A malformed body is `400`; anything else is `204 No Content`, because
 * re-acking a command — or acking one that never existed — is a no-op by
 * contract, not an error.
 */
export function createControlAckHandler(deps: ControlDeps): ControlHandler {
  return async function controlAckHandler(c: Context): Promise<Response> {
    const principal = await authorise(c, deps);
    if (principal instanceof Response) return principal;
    void principal.projectId;

    const ids = await readAckIds(c);
    if (ids === null) {
      return c.json(
        { error: "invalid_json", message: "the ack body must be { ids: [ ... ] }" },
        400,
      );
    }

    // Idempotent by construction: a re-ack, an unknown id and an already-expired
    // id are all no-ops inside `ackControls`, so the retry is always a `204`.
    await deps.control.ackControls(ids);
    return c.body(null, 204);
  };
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

/**
 * Build a ready-to-mount Hono app exposing both downlink routes.
 *
 * Mount with `app.route("/v1/control", createControl(deps))`; the two handlers
 * sit at `/` and `/ack`.
 */
export function createControl(deps: ControlDeps): Hono {
  const app = new Hono();
  app.get("/", createControlHandler(deps));
  app.post("/ack", createControlAckHandler(deps));
  return app;
}

export default createControl;
