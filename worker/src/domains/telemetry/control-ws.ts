/**
 * Device control over WebSocket — `GET /v1/control/ws` (upgrade).
 *
 * This module is the *push* twin of {@link ./control}: the same device-facing
 * control plane, delivered over a socket instead of a poll. `control.ts` owns
 * `GET /v1/control` and `POST /v1/control/ack`; this module owns one route,
 * `/v1/control/ws`, and re-implements **none** of the control lifecycle. It is
 * a third transport over the *same* {@link ControlPlane} seam:
 *
 *   | transport                    | delivery           | ack               |
 *   |------------------------------|--------------------|-------------------|
 *   | `GET  /v1/control`           | device polls       | —                 |
 *   | `POST /v1/control/ack`       | —                  | `{ ids }` → 204   |
 *   | `GET  /v1/control/ws`        | server pushes      | `{ ids }` frame   |
 *
 * ## Why a socket at all
 *
 * A device that polls learns about a command one poll-interval late, and every
 * poll that finds nothing is wasted traffic. A connected device instead
 * receives its pending commands **the moment it connects** — no poll, no
 * interval, no "is it there yet?" latency. That is the whole of the win here,
 * and it is exactly the first acceptance claim: *a connected device receives a
 * pending command without polling*.
 *
 * The socket carries no new state. Pending-ness, acknowledgement and expiry are
 * still owned *entirely* by {@link ControlPlane}: a socket connect is a read
 * ({@link ControlPlane.pendingControls}) and an ack frame is the same write the
 * HTTP ack route makes ({@link ControlPlane.ackControls}). So a command acked
 * over the socket disappears from the next HTTP poll and vice versa — the two
 * transports cannot disagree, because they share one seam and one lifecycle.
 *
 * ## Ack is idempotent, over either transport
 *
 * {@link ControlPlane.ackControls} is idempotent by contract (a re-ack, an
 * unknown id and an already-expired id are no-ops, never errors). The socket
 * therefore hands the ids over and, for the device's convenience, reports what
 * it actually transitioned (`{type:"control_ack", acked:[...]}`). A device that
 * acks over the socket *and* retries over HTTP is never punished for it: the
 * second is a `204` no-op.
 *
 * ## Disconnect is a fallback, not a failure
 *
 * A dropped socket is not an error state — it is the device returning to the
 * transport it always had. This module writes **no** state on disconnect: the
 * commands that were pushed are still pending in the seam (unless acked), so a
 * disconnected device's HTTP `GET /v1/control` keeps serving them unchanged.
 * That is the third acceptance claim (*after disconnect the HTTP route still
 * serves pending commands*), and it holds *by construction* precisely because
 * the socket never owned that state to begin with.
 *
 * ## Auth: a device token, from a header or a query parameter, fail closed
 *
 * The credential is verified through the *same* {@link VerifyControlToken} seam
 * `control.ts` uses, so both transports accept exactly the token set and reject
 * exactly the rest. It may be presented either way a real client must:
 *
 *   * `Authorization: Bearer <pt_…>` — the machine path, parsed by the SHARED
 *     strict Bearer grammar ({@link readBearerToken}); a non-Bearer header is
 *     not a credential at all.
 *   * `?token=<pt_…>` — because the browser `WebSocket` constructor cannot set
 *     request headers, so a header-only rule would make this route unusable
 *     from a browser. The token is still verified identically; only *where it
 *     was read from* differs. A blank/absent token, or one the verifier rejects
 *     (or that makes the verifier throw — a refusal, not a `500`), is
 *     `401 { error: "unauthorized", message }`, the same body and code the
 *     frozen contract names for `GET /v1/control`
 *     (`GET_CONTROL.errors` / `CONTRACT_ERRORS.unauthorized`).
 *
 * The resolved principal's project scopes every call, so one project's token
 * can never observe or acknowledge another project's commands.
 *
 * ## Everything non-deterministic is injected
 *
 * The {@link ControlPlane} seam, the {@link VerifyControlToken} verifier and the
 * {@link WebSocketRuntime} that performs the upgrade all arrive through
 * {@link ControlWsDeps}. This module reaches for no binding, no ambient clock
 * and no `env`; it never constructs a real `WebSocketPair`, so it is entirely
 * exercisable — acceptance tests included — without a Cloudflare runtime.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { readBearerToken, type Principal } from "../../platform/middleware/resolve-project";
import type { PendingControl } from "../../platform/durable-objects/project-control";
// The wire field names, the seam types and the device-header policy have ONE
// home — `control.ts` — and are READ from there rather than restated, so the
// two transports cannot drift apart.
import {
  AUTHORIZATION_HEADER,
  CONTROL_ACK_REQUEST_FIELDS,
  CONTROL_COMMAND_FIELDS,
  CONTROL_RESPONSE_FIELDS,
  DEFAULT_DEVICE_KEY,
  DEVICE_HEADER,
  type ControlPlane,
  type VerifyControlToken,
} from "./control";

// ---------------------------------------------------------------------------
// Path & protocol constants
// ---------------------------------------------------------------------------

/** The route this module serves, as it appears in the frozen contract surface. */
export const CONTROL_WS_PATH = "/v1/control/ws";

/**
 * Query parameter carrying the token when a header cannot be set.
 *
 * The browser `WebSocket(url)` constructor takes no options, so a header-only
 * rule would leave this route unreachable from a browser. The parameter is a
 * *carrier* for the same credential, verified by the same seam — it is not a
 * second, weaker auth path.
 */
export const CONTROL_WS_TOKEN_PARAM = "token";

/** Query parameter naming the device, mirroring the {@link DEVICE_HEADER} header. */
export const CONTROL_WS_DEVICE_PARAM = "device";

/**
 * Frame `type` the server pushes for a batch of pending commands.
 *
 * One frame per delivery, whose `control` array is exactly the shape
 * `GET /v1/control` returns — the field names come from
 * {@link CONTROL_COMMAND_FIELDS}, so a device parses both transports with one
 * decoder.
 */
export const CONTROL_WS_COMMAND_FRAME = "control" as const;

/**
 * Frame `type` an acknowledgement receives, carrying the ids actually
 * transitioned. Purely informational: acking is idempotent, so a device that
 * ignores this frame loses nothing.
 */
export const CONTROL_WS_ACK_FRAME = "control_ack" as const;

/** Frame `type` pushed when a connect finds nothing pending. */
export const CONTROL_WS_EMPTY_FRAME = "control_empty" as const;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One command as the socket carries it — the contract's three fields. */
export interface ControlWsCommand {
  readonly id: string;
  readonly variable: string;
  readonly value: string | null;
}

/** The server→device frame delivering pending commands. */
export interface ControlWsCommandFrame {
  readonly type: typeof CONTROL_WS_COMMAND_FRAME;
  readonly control: readonly ControlWsCommand[];
}

/** The server→device frame sent when a connect finds nothing pending. */
export interface ControlWsEmptyFrame {
  readonly type: typeof CONTROL_WS_EMPTY_FRAME;
}

/** The server→device frame answering an ack. */
export interface ControlWsAckFrame {
  readonly type: typeof CONTROL_WS_ACK_FRAME;
  readonly acked: readonly string[];
}

/** Any frame this module pushes to a device. */
export type ControlWsServerFrame =
  | ControlWsCommandFrame
  | ControlWsEmptyFrame
  | ControlWsAckFrame;

/** The device→server ack frame body: exactly `{ ids: [...] }`, as over HTTP. */
export interface ControlWsAckRequest {
  readonly ids: readonly string[];
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The minimum of a WebSocket this module needs.
 *
 * Structural and tiny on purpose: production passes a real `WebSocket` (which
 * satisfies this as-is) and a test passes a recording fake, so the module is
 * drivable without a Cloudflare runtime. Only the three operations the protocol
 * actually uses are named — send a frame, close the connection, and accept.
 */
export interface WebSocketLike {
  /** Send one frame (already serialized to text). */
  send(data: string): void;
  /** Close the connection, optionally with a status and reason. */
  close(code?: number, reason?: string): void;
}

/**
 * The upgrade produced by the runtime: the socket handed to the device, and the
 * server-side socket this module drives.
 *
 * Mirrors `WebSocketPair` (`{ 0: server, 1: client }`) so the production
 * adapter is a one-line mapping, but is expressed as two named fields so it can
 * be constructed by a test without the platform's pair semantics.
 */
export interface ControlSocketPair {
  /** The server end — the side this module sends on. */
  readonly server: WebSocketLike;
  /** The client end — what a device (or a test) reads. */
  readonly client: WebSocketLike;
}

/**
 * The runtime seam performing the protocol upgrade.
 *
 * In production this is `WebSocketPair` + `Response` + `webSocket.accept()`;
 * in a test it is a fake that records the pair it minted. It is injected so
 * this module never touches a real Cloudflare WebSocket and never assumes the
 * runtime is present.
 */
export interface WebSocketRuntime {
  /**
   * Mint a connected socket pair and return the `101` response carrying the
   * client end, plus the server end to drive.
   */
  upgrade(): { readonly pair: ControlSocketPair; readonly response: Response };
  /**
   * Register a handler for frames arriving on the server socket. Called once,
   * immediately after a successful upgrade, with the raw text of each frame.
   */
  onMessage(server: WebSocketLike, handler: (raw: string) => void): void;
  /** Register a handler for the socket closing (device disconnect / drop). */
  onClose(server: WebSocketLike, handler: () => void): void;
}

/**
 * Content of the ack frame, or `null` when the frame is not an ack.
 *
 * Accepts the two shapes a device may plausibly send for the same thing — the
 * HTTP ack body `{ ids: [...] }` and a framed
 * `{ type: "control_ack", ids: [...] }` — because a device that already speaks
 * the HTTP ack should not need a second encoder. Anything else is `null` and is
 * ignored (never a disconnect: an unreadable frame is not an error a device
 * should be dropped for).
 */
export function readAckFrame(raw: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const ids = record[CONTROL_ACK_REQUEST_FIELDS[0]];
  if (!Array.isArray(ids)) return null;
  if (!ids.every((id): id is string => typeof id === "string")) return null;
  return ids;
}

/**
 * Everything the socket route needs, injectable end-to-end for tests.
 *
 * `control` and `verifyToken` are the *same two seams* `control.ts` takes
 * ({@link ControlPlane} and {@link VerifyControlToken}), so a deploy passes one
 * object to both transports and the two can never authenticate or deliver
 * differently. `runtime` is the only socket-specific seam.
 */
export interface ControlWsDeps {
  /** The project control plane (`ProjectControl` in production). */
  readonly control: ControlPlane;
  /** Verify the presented token → {@link Principal}, or `null`. */
  readonly verifyToken: VerifyControlToken;
  /** The upgrade seam (`WebSocketPair` in production, a fake in tests). */
  readonly runtime: WebSocketRuntime;
  /**
   * Bind each connection to the *device it names*, so only that device's
   * commands are pushed. `false` pushes every device's pending commands (the
   * seam's own default) — a project-level view, never a device-facing deploy.
   */
  readonly scopeToDevice?: boolean;
}

/** The `{ error, message }` body every rejection carries. */
export interface ControlWsErrorBody {
  readonly error: "unauthorized";
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Device resolution & serialization
// ---------------------------------------------------------------------------

/**
 * The device key a connection speaks for.
 *
 * The header is the machine path (mirroring every other device route); the
 * query parameter is the browser path (a browser cannot set the header, and a
 * socket URL is where it can put a claim). A blank value from either collapses
 * to {@link DEFAULT_DEVICE_KEY}, so a connection can never be nameless — the
 * same rule `control.ts` applies to a poll.
 */
export function resolveDevice(
  c: Context,
  scopeToDevice: boolean,
): string | undefined {
  if (!scopeToDevice) return undefined;
  const header = (c.req.header(DEVICE_HEADER) ?? "").trim();
  const query = (c.req.query(CONTROL_WS_DEVICE_PARAM) ?? "").trim();
  const device = header !== "" ? header : query;
  return device === "" ? DEFAULT_DEVICE_KEY : device;
}

/** The token presented to the upgrade: header first, then query parameter. */
export function resolveToken(c: Context): string | null {
  const viaHeader = readBearerToken(c);
  if (viaHeader !== null) return viaHeader;
  const viaQuery = (c.req.query(CONTROL_WS_TOKEN_PARAM) ?? "").trim();
  return viaQuery === "" ? null : viaQuery;
}

/**
 * Project one stored row down to exactly the contract's three fields.
 *
 * A named export rather than an inline arrow because the field *pin* is the
 * contract: the socket must offer the same three fields, in the same order, as
 * `GET /v1/control` and as {@link CONTROL_COMMAND_FIELDS}, and a test pins it.
 */
export function toCommand(row: PendingControl): ControlWsCommand {
  return { id: row.id, variable: row.variable, value: row.value };
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/**
 * Deliver a newly connected device its pending commands — the push that makes
 * polling unnecessary.
 *
 * Reads {@link ControlPlane.pendingControls} for the connection's device and
 * sends one {@link ControlWsCommandFrame}. A connect with nothing pending sends
 * {@link CONTROL_WS_EMPTY_FRAME} instead of silence, so a device can tell "the
 * server saw me and I have no work" from "my frame was lost" without waiting
 * for a timeout.
 *
 * Acked and expired commands are already excluded by the seam; nothing is
 * filtered here, so this function cannot disagree with `GET /v1/control` about
 * what is pending.
 */
export async function deliverPending(
  control: ControlPlane,
  device: string | undefined,
  socket: WebSocketLike,
): Promise<readonly ControlWsCommand[]> {
  const rows = await control.pendingControls(device);
  const commands = rows.map(toCommand);
  if (commands.length === 0) {
    socket.send(JSON.stringify({ type: CONTROL_WS_EMPTY_FRAME }));
    return commands;
  }
  socket.send(JSON.stringify({ type: CONTROL_WS_COMMAND_FRAME, control: commands }));
  return commands;
}

/**
 * Handle one inbound frame from a device.
 *
 * Returns the ack work as a promise (or `null` when the frame was not an ack),
 * so a caller — production, or a test — can *await the actual acknowledgement*
 * instead of guessing how long it takes. Awaiting the real work is what lets
 * the socket tests stay timer-free: the settled promise is the signal, so there
 * is no "long enough" sleep to flake under load.
 *
 * An unreadable frame is ignored, never fatal — a device is not disconnected
 * for sending something we did not understand.
 */
export function handleControlWsFrame(
  control: ControlPlane,
  raw: string,
  socket: WebSocketLike,
): Promise<void> | null {
  const ids = readAckFrame(raw);
  if (ids === null) return null;
  // Idempotent by contract, so the socket writes no state of its own: it only
  // reports what the seam transitioned, and a re-ack reports an empty list.
  return control.ackControls(ids).then((acked) => {
    socket.send(JSON.stringify({ type: CONTROL_WS_ACK_FRAME, acked }));
  });
}

/**
 * Open a control connection: push pending commands, then handle acks.
 *
 * The sequence is deliberately two-phase:
 *
 *   1. **On connect** — {@link deliverPending} pushes the device's pending
 *      commands. This is the no-polling delivery (acceptance claim 1).
 *   2. **On each frame** — {@link handleControlWsFrame} hands an ack
 *      (`{ ids }`, in either spelling) to {@link ControlPlane.ackControls} and
 *      answers it with {@link CONTROL_WS_ACK_FRAME} (acceptance claim 2).
 *
 * Registration of the frame handler happens *before* the delivery read, so an
 * ack that races the initial push cannot be dropped. A device that disconnects
 * is simply done: no teardown, because the seam — not the socket — owns whether
 * a command is still pending, which is what lets the HTTP poll keep working
 * afterwards (acceptance claim 3).
 *
 * Returns the client end of the pair and the `101` response to answer the
 * upgrade with, so the caller composes the `Response`.
 */
export async function startControlConnection(
  deps: ControlWsDeps,
  device: string | undefined,
): Promise<{ readonly pair: ControlSocketPair; readonly response: Response }> {
  const { pair, response } = deps.runtime.upgrade();

  // (2) Register first, so an ack racing the initial push is never lost.
  deps.runtime.onMessage(pair.server, (raw) => {
    void handleControlWsFrame(deps.control, raw, pair.server);
  });

  // A disconnect is the device leaving the push channel — nothing to unwind:
  // the seam still holds every unacked command, so HTTP polling (the fallback)
  // serves them unchanged. The hook exists so a deploy can observe the drop.
  deps.runtime.onClose(pair.server, () => {});

  // (1) The no-polling delivery.
  await deliverPending(deps.control, device, pair.server);

  return { pair, response };
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

/**
 * Build the `GET /v1/control/ws` handler.
 *
 * Auth first — so an anonymous upgrade never reaches the store — then the
 * connection. The credential comes from the header or the query parameter, in
 * that order, and is verified through the injected seam; a verifier that
 * *throws* is a refusal, not a `500`, so the route fails closed rather than
 * leaking an unenforceable mistake.
 */
export function createControlWsHandler(deps: ControlWsDeps) {
  const scopeToDevice = deps.scopeToDevice ?? true;
  return async function controlWsHandler(c: Context): Promise<Response> {
    const deny = (): Response =>
      c.json(
        {
          error: "unauthorized",
          message: "a valid project token is required",
        } satisfies ControlWsErrorBody,
        401,
      );

    const token = resolveToken(c);
    if (token === null) return deny();

    let principal: Principal | null;
    try {
      principal = await deps.verifyToken(token);
    } catch {
      principal = null;
    }
    if (principal === null) return deny();

    // Expose the resolved principal exactly the way `resolveProject` does, so a
    // downstream reader sees the *verified* tenant, never one from the URL.
    c.set("principal", principal);
    void principal.projectId; // scopes the call to the credential's tenant

    const { response } = await startControlConnection(deps, resolveDevice(c, scopeToDevice));
    return response;
  };
}

/**
 * Build a ready-to-mount Hono app exposing the socket route.
 *
 * Mount with `app.get("/v1/control/ws", ...)` or `app.route("/", createControlWs(deps))`.
 */
export function createControlWs(deps: ControlWsDeps): Hono {
  const app = new Hono();
  app.get("/", createControlWsHandler(deps));
  return app;
}

export {
  AUTHORIZATION_HEADER,
  CONTROL_ACK_REQUEST_FIELDS,
  CONTROL_COMMAND_FIELDS,
  CONTROL_RESPONSE_FIELDS,
  DEFAULT_DEVICE_KEY,
  DEVICE_HEADER,
  type ControlPlane,
  type VerifyControlToken,
};
export default createControlWs;
