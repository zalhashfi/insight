import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  AUTHORIZATION_HEADER,
  CONTROL_ACK_REQUEST_FIELDS,
  CONTROL_COMMAND_FIELDS,
  CONTROL_RESPONSE_FIELDS,
  DEVICE_HEADER,
  createControl,
  type ControlDeps,
} from "../../worker/src/domains/telemetry/control";
import {
  CONTROL_WS_ACK_FRAME,
  CONTROL_WS_COMMAND_FRAME,
  CONTROL_WS_DEVICE_PARAM,
  CONTROL_WS_EMPTY_FRAME,
  CONTROL_WS_PATH,
  CONTROL_WS_TOKEN_PARAM,
  createControlWsHandler,
  handleControlWsFrame,
  readAckFrame,
  resolveToken,
  type ControlPlane,
  type ControlSocketPair,
  type ControlWsDeps,
  type WebSocketLike,
  type WebSocketRuntime,
} from "../../worker/src/domains/telemetry/control-ws";
import {
  InMemoryProjectControlStorage,
  ProjectControl,
} from "../../worker/src/platform/durable-objects/project-control";
import type { DevicePrincipal } from "../../worker/src/platform/middleware/resolve-project";

// The FROZEN cross-repo contract lock — the tripwire this suite asserts against.
import {
  CONTROL_ACK_REQUEST_FIELDS as LOCK_ACK_FIELDS,
  CONTROL_COMMAND_FIELDS as LOCK_COMMAND_FIELDS,
  CONTROL_RESPONSE_FIELDS as LOCK_RESPONSE_FIELDS,
  GET_CONTROL,
  STATUS,
} from "../contracts/contract-lock";

/**
 * Spec tests for device control over WebSocket — `GET /v1/control/ws`.
 *
 * `control-ws.ts` is a third transport over the *same* control seam the HTTP
 * routes use, and the claims are the acceptance list, asserted against the REAL
 * `ProjectControl` over in-memory storage and a fake socket the test owns (no
 * Cloudflare runtime anywhere):
 *
 *   1. **No-polling delivery** — a connected device receives its pending
 *      commands as soon as it connects, without asking for them.
 *   2. **Ack over WS** — an ack frame removes the command, so it is gone from
 *      both the socket's next delivery and the HTTP poll.
 *   3. **HTTP fallback** — after the socket disconnects, `GET /v1/control`
 *      still serves the pending commands, because the socket never owned that
 *      state.
 *   4. **Auth** — no token, or one the verifier rejects, is `401` with the
 *      frozen `{ error, message }` body; a header token and a query token are
 *      the same credential.
 */

const PROJECT = "proj_control_ws";
const TOKEN = "pt_control_ws_token";
const DEVICE = "dev_alpha";
const VARIABLE = "setpoint";

/** The exactly-knowable instant every request runs against. */
const FIXED_NOW = 1_700_000_000_123;

/** A well-formed device principal for {@link PROJECT}, scoped `read write`. */
const DEVICE_PRINCIPAL: DevicePrincipal = {
  kind: "device",
  projectId: PROJECT,
  tokenId: "tok_control_ws",
  scopes: "read write",
};

// ---------------------------------------------------------------------------
// The socket seam — a recording fake, so no runtime is needed
// ---------------------------------------------------------------------------

/**
 * A fake socket pair plus the runtime that mints it.
 *
 * `client` records every frame the server sends (so a test reads exactly what a
 * device would see), and `feed`/`drop` let a test drive the server end the way
 * the platform would — delivering an inbound frame and firing the close event.
 * The runtime is the injected seam, so the module under test never constructs a
 * real `WebSocketPair`.
 */
interface SocketHarness {
  /** The runtime to inject into {@link ControlWsDeps}. */
  runtime: WebSocketRuntime;
  /** Frames the server pushed, in order, as raw JSON text. */
  frames(): string[];
  /** The last frame pushed, parsed — or `null` when nothing was pushed. */
  lastFrame(): Record<string, unknown> | null;
  /** Every `type` pushed, in order. */
  types(): string[];
  /** Deliver one inbound frame to the server socket (as a device would send). */
  feed(raw: string): void;
  /**
   * Deliver an ack frame and settle the acknowledgement it triggers.
   *
   * The `runtime.onMessage` seam is typed `(raw) => void`, so an ack's async
   * write is not awaited for us. Rather than guess a delay, this drives the
   * *same* {@link handleControlWsFrame} the connection uses, so awaiting its
   * promise is awaiting the real acknowledgement — no timer, no race.
   */
  ack(raw: string): Promise<void>;
  /** Drop the connection, firing the close hook. */
  drop(): void;
  /** How many times the runtime was asked to upgrade. */
  upgrades(): number;
  /** Whether a close hook was registered for the open connection. */
  closeRegistered(): boolean;
}

function socketHarness(controlPlane: ControlPlane): SocketHarness {
  const pushed: string[] = [];
  const messageHandlers: ((raw: string) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  // The last connection's server socket, so `ack()` can drive the real handler.
  let opened: ControlSocketPair | null = null;
  let upgradeCount = 0;
  let closed = false;

  const stepClose = (): void => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler();
  };

  const server: WebSocketLike = {
    send: (data: string) => pushed.push(data),
    close: () => stepClose(),
  };
  const client: WebSocketLike = {
    send: () => {},
    close: () => stepClose(),
  };

  const runtime: WebSocketRuntime = {
    upgrade: () => {
      upgradeCount += 1;
      opened = { server, client };
      // The response is irrelevant to these assertions; a bare 101 stands in.
      return { pair: opened, response: new Response(null, { status: 101 }) };
    },
    onMessage: (socket, handler) => {
      if (socket === server) messageHandlers.push(handler);
    },
    onClose: (socket, handler) => {
      if (socket === server) closeHandlers.push(handler);
    },
  };

  return {
    runtime,
    frames: () => [...pushed],
    lastFrame: () => {
      const last = pushed[pushed.length - 1];
      return last === undefined ? null : (JSON.parse(last) as Record<string, unknown>);
    },
    types: () => pushed.map((f) => String((JSON.parse(f) as Record<string, unknown>).type)),
    feed: (raw) => {
      if (opened === null) throw new Error("no open connection to feed");
      for (const handler of messageHandlers) handler(raw);
    },
    ack: async (raw) => {
      if (opened === null) throw new Error("no open connection to ack on");
      await handleControlWsFrame(controlPlane, raw, opened.server);
    },
    drop: () => stepClose(),
    upgrades: () => upgradeCount,
    closeRegistered: () => closeHandlers.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Harness — the REAL control plane plus both transports
// ---------------------------------------------------------------------------

interface Harness {
  /** `GET /v1/control/ws` mounted at the contract path. */
  app: Hono;
  /** `GET /v1/control` + `POST /v1/control/ack`, for the fallback claims. */
  http: Hono;
  /** The REAL control plane over in-memory storage. */
  control: ProjectControl;
  /** The fake socket seam. */
  sockets: SocketHarness;
  /** Advance the shared clock (both transports read it). */
  advance: (ms: number) => void;
  /** Enqueue one command, defaulting to DEVICE / setpoint / "21.5". */
  enqueue: (
    overrides?: Partial<{
      id: string;
      device: string;
      variable: string;
      value: string | null;
      ttlMs: number;
    }>,
  ) => Promise<void>;
}

/**
 * Build a fully-injected control surface: the WS route and the HTTP routes
 * sharing one {@link ProjectControl} over `InMemoryProjectControlStorage`, with
 * a clock the test drives and a socket seam the test owns.
 *
 * `verifyToken` accepts exactly {@link TOKEN} by default; pass an override to
 * exercise the refusal paths.
 */
async function harness(
  overrides: Partial<ControlWsDeps> & { verifyToken?: ControlWsDeps["verifyToken"] } = {},
): Promise<Harness & { deps: ControlWsDeps; httpDeps: ControlDeps }> {
  const storage = new InMemoryProjectControlStorage();
  let now = FIXED_NOW;
  const control = new ProjectControl({ storage, now: () => now });
  await control.init();

  const verifyToken =
    overrides.verifyToken ?? (async (token: string) => (token === TOKEN ? DEVICE_PRINCIPAL : null));

  const sockets = socketHarness(control);
  const deps: ControlWsDeps = { control, verifyToken, runtime: sockets.runtime, ...overrides };
  const httpDeps: ControlDeps = { control, verifyToken };

  const app = new Hono();
  app.get(CONTROL_WS_PATH, createControlWsHandler(deps));

  const enqueue: Harness["enqueue"] = async (o = {}) => {
    await control.enqueueControl({
      id: o.id ?? "cmd_1",
      device: o.device ?? DEVICE,
      variable: o.variable ?? VARIABLE,
      // `??` would erase an explicit `null`, which is a valid payload.
      value: "value" in o ? o.value : "21.5",
      ttlMs: o.ttlMs,
    });
  };

  return {
    app,
    http: createControl(httpDeps),
    control,
    sockets,
    deps,
    httpDeps,
    advance: (ms) => {
      now += ms;
    },
    enqueue,
  };
}

/** Open the socket at the contract path, with the given headers/query. */
function openSocket(
  app: Hono,
  {
    headers = {},
    token = TOKEN,
    device,
  }: { headers?: Record<string, string>; token?: string | null; device?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams();
  if (token !== null) params.set(CONTROL_WS_TOKEN_PARAM, token);
  if (device !== undefined) params.set(CONTROL_WS_DEVICE_PARAM, device);
  const query = params.toString();
  const h: Record<string, string> = { ...headers };
  if (device !== undefined) h[DEVICE_HEADER] = device;
  return Promise.resolve(
    app.request(query === "" ? CONTROL_WS_PATH : `${CONTROL_WS_PATH}?${query}`, {
      method: "GET",
      headers: h,
    }),
  );
}

/** GET `/v1/control` over HTTP — the fallback path. */
function getControlHttp(h: Harness, headers: Record<string, string> = {}, device?: string): Promise<Response> {
  const headersOut: Record<string, string> = {
    [AUTHORIZATION_HEADER]: `Bearer ${TOKEN}`,
    ...headers,
  };
  if (device !== undefined) headersOut[DEVICE_HEADER] = device;
  return Promise.resolve(h.http.request("/", { method: "GET", headers: headersOut }));
}

/** POST `/v1/control/ack` over HTTP. */
function postAckHttp(h: Harness, body: unknown): Promise<Response> {
  return Promise.resolve(
    h.http.request("/ack", {
      method: "POST",
      headers: { "content-type": "application/json", [AUTHORIZATION_HEADER]: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),
  );
}

/** The `control` array of a `GET /v1/control` response. */
async function httpControl(res: Response): Promise<Record<string, unknown>[]> {
  const body = (await res.json()) as Record<string, unknown>;
  return body[CONTROL_RESPONSE_FIELDS[0]] as Record<string, unknown>[];
}

/** The `control` array of a `control` socket frame. */
function frameControl(frame: Record<string, unknown> | null): Record<string, unknown>[] {
  return (frame?.[CONTROL_RESPONSE_FIELDS[0]] ?? []) as Record<string, unknown>[];
}

/** Read a `{ error, message }` body from a rejected response. */
async function errorOf(res: Response): Promise<{ error: string; message: string }> {
  return (await res.json()) as { error: string; message: string };
}

// ---------------------------------------------------------------------------
// Contract lock agreement
// ---------------------------------------------------------------------------

describe("control-ws — contract lock agreement", () => {
  it("carries the frozen command field names in a socket frame", () => {
    expect([...CONTROL_COMMAND_FIELDS]).toEqual([...LOCK_COMMAND_FIELDS]);
    expect([...CONTROL_ACK_REQUEST_FIELDS]).toEqual([...LOCK_ACK_FIELDS]);
    expect([...CONTROL_RESPONSE_FIELDS]).toEqual([...LOCK_RESPONSE_FIELDS]);
  });

  it("delivers exactly the three frozen fields, in order", async () => {
    const h = await harness();
    await h.enqueue({ variable: VARIABLE, value: "21.5" });
    await openSocket(h.app, { device: DEVICE });

    const command = frameControl(h.sockets.lastFrame())[0];
    expect(Object.keys(command)).toEqual([...LOCK_COMMAND_FIELDS]);
    expect(command).toMatchObject({ id: "cmd_1", variable: VARIABLE, value: "21.5" });
  });

  it("uses an `unauthorized` 401 body shaped like the frozen lock's", async () => {
    const h = await harness();
    const res = await openSocket(h.app, { token: null });
    expect(res.status).toBe(GET_CONTROL.errors[0].status);
    expect(GET_CONTROL.errors[0].code).toBe("unauthorized");
    expect((await errorOf(res)).error).toBe("unauthorized");
  });

  it("serves the frozen control path", () => {
    expect(CONTROL_WS_PATH).toBe("/v1/control/ws");
  });

  it("routes the socket frame type through the shared envelope key", () => {
    expect(CONTROL_WS_COMMAND_FRAME).toBe(CONTROL_RESPONSE_FIELDS[0]);
  });
});

// ---------------------------------------------------------------------------
// 1. No-polling delivery
// ---------------------------------------------------------------------------

describe("GET /v1/control/ws — pending delivery without polling", () => {
  it("pushes a pending command the moment the device connects", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });

    // Nothing has polled: the enqueue is the only prior interaction.
    let polls = 0;
    const counting = {
      pendingControls: async (device?: string) => {
        polls += 1;
        return h.control.pendingControls(device);
      },
      ackControls: async (ids: readonly string[]) => h.control.ackControls(ids),
    };
    const app = new Hono();
    app.get(
      CONTROL_WS_PATH,
      createControlWsHandler({ ...h.deps, control: counting }),
    );

    const res = await openSocket(app, { device: DEVICE });
    expect(res.status).toBe(101);
    // Exactly one seam read — the connect itself. No polling loop, no interval.
    expect(polls).toBe(1);

    const frame = h.sockets.lastFrame();
    expect(frame?.type).toBe(CONTROL_WS_COMMAND_FRAME);
    expect(frameControl(frame).map((c) => c.id)).toEqual(["cmd_1"]);
  });

  it("carries a null value opaquely, as the HTTP route does", async () => {
    const h = await harness();
    await h.enqueue({ value: null });
    await openSocket(h.app, { device: DEVICE });

    expect(frameControl(h.sockets.lastFrame())[0].value).toBeNull();
  });

  it("pushes every pending command for the device, oldest first", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    h.advance(5);
    await h.enqueue({ id: "cmd_2" });
    h.advance(5);
    await h.enqueue({ id: "cmd_3" });
    await openSocket(h.app, { device: DEVICE });

    expect(frameControl(h.sockets.lastFrame()).map((c) => c.id)).toEqual([
      "cmd_1",
      "cmd_2",
      "cmd_3",
    ]);
  });

  it("scopes delivery to the connecting device", async () => {
    const h = await harness();
    await h.enqueue({ id: "mine", device: DEVICE });
    await h.enqueue({ id: "theirs", device: "dev_beta" });
    await openSocket(h.app, { device: DEVICE });

    expect(frameControl(h.sockets.lastFrame()).map((c) => c.id)).toEqual(["mine"]);
  });

  it("scopes via the device query parameter too (a browser cannot set a header)", async () => {
    const h = await harness();
    await h.enqueue({ id: "mine", device: DEVICE });
    await h.enqueue({ id: "theirs", device: "dev_beta" });
    await openSocket(h.app, { device: DEVICE });

    expect(frameControl(h.sockets.lastFrame()).map((c) => c.id)).toEqual(["mine"]);
  });

  it("addresses the default device key when no device is named", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1", device: "unknown" });
    await openSocket(h.app);

    expect(frameControl(h.sockets.lastFrame()).map((c) => c.id)).toEqual(["cmd_1"]);
  });

  it("sends an explicit empty frame — not silence — when nothing is pending", async () => {
    const h = await harness();
    await openSocket(h.app, { device: DEVICE });

    expect(h.sockets.types()).toEqual([CONTROL_WS_EMPTY_FRAME]);
    expect(h.sockets.lastFrame()).toEqual({ type: CONTROL_WS_EMPTY_FRAME });
  });

  it("delivers right up to the TTL deadline and never one millisecond past", async () => {
    const h = await harness();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    await h.enqueue({ ttlMs: ONE_DAY_MS });

    h.advance(ONE_DAY_MS);
    await openSocket(h.app, { device: DEVICE });
    expect(frameControl(h.sockets.lastFrame())).toHaveLength(1);

    // A second connection, one millisecond past the deadline: never delivered.
    const late = await harness();
    await late.enqueue({ ttlMs: ONE_DAY_MS });
    late.advance(ONE_DAY_MS + 1);
    await openSocket(late.app, { device: DEVICE });
    expect(late.sockets.types()).toEqual([CONTROL_WS_EMPTY_FRAME]);
  });

  it("registers the inbound-frame and close hooks on connect", async () => {
    const h = await harness();
    await openSocket(h.app, { device: DEVICE });
    expect(h.sockets.upgrades()).toBe(1);
    expect(h.sockets.closeRegistered()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Ack over the socket
// ---------------------------------------------------------------------------

describe("GET /v1/control/ws — acknowledgement over the socket", () => {
  it("removes an acked command from the next connection", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await openSocket(h.app, { device: DEVICE });

    await h.sockets.ack(JSON.stringify({ [CONTROL_ACK_REQUEST_FIELDS[0]]: ["cmd_1"] }));

    expect(await h.control.pendingControls(DEVICE)).toHaveLength(0);

    const second = await harness();
    await second.enqueue({ id: "cmd_1" });
    await openSocket(second.app, { device: DEVICE });
    await second.sockets.ack(JSON.stringify({ ids: ["cmd_1"] }));
    await openSocket(second.app, { device: DEVICE });
    expect(second.sockets.types()).toContain(CONTROL_WS_EMPTY_FRAME);
  });

  it("answers an ack with the ids it actually transitioned", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await openSocket(h.app, { device: DEVICE });

    await h.sockets.ack(JSON.stringify({ ids: ["cmd_1"] }));

    const ackFrame = h.sockets
      .frames()
      .map((f) => JSON.parse(f) as Record<string, unknown>)
      .find((f) => f.type === CONTROL_WS_ACK_FRAME);
    expect(ackFrame).toBeDefined();
    expect(ackFrame?.acked).toEqual(["cmd_1"]);
  });

  it("accepts the framed spelling `{type, ids}` as well as the HTTP body", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await openSocket(h.app, { device: DEVICE });

    await h.sockets.ack(JSON.stringify({ type: CONTROL_WS_ACK_FRAME, ids: ["cmd_1"] }));

    expect(await h.control.pendingControls(DEVICE)).toHaveLength(0);
  });

  it("is idempotent: re-acking over the socket is a no-op, never an error", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await openSocket(h.app, { device: DEVICE });

    await h.sockets.ack(JSON.stringify({ ids: ["cmd_1"] }));
    await h.sockets.ack(JSON.stringify({ ids: ["cmd_1"] }));

    const acks = h.sockets
      .frames()
      .map((f) => JSON.parse(f) as Record<string, unknown>)
      .filter((f) => f.type === CONTROL_WS_ACK_FRAME);
    expect(acks).toHaveLength(2);
    // The second ack transitioned nothing — the terminal state stayed terminal.
    expect(acks[1].acked).toEqual([]);
  });

  it("acking an unknown id is a no-op, not an error", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await openSocket(h.app, { device: DEVICE });

    await h.sockets.ack(JSON.stringify({ ids: ["never_enqueued"] }));

    expect(await h.control.pendingControls(DEVICE)).toHaveLength(1);
  });

  it("ignores an unreadable frame rather than dropping the device", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await openSocket(h.app, { device: DEVICE });

    h.sockets.feed("not json at all");
    h.sockets.feed(JSON.stringify({ notIds: ["cmd_1"] }));

    // Nothing was acked, and no close was driven by a bad frame.
    expect(await h.control.pendingControls(DEVICE)).toHaveLength(1);
  });

  it("readAckFrame reads the HTTP body shape and rejects everything else", () => {
    expect(readAckFrame(JSON.stringify({ ids: ["a", "b"] }))).toEqual(["a", "b"]);
    expect(readAckFrame(JSON.stringify({ ids: [] }))).toEqual([]);
    expect(readAckFrame("}{")).toBeNull();
    expect(readAckFrame(JSON.stringify({ ids: [1, 2] }))).toBeNull();
    expect(readAckFrame(JSON.stringify({ nope: [] }))).toBeNull();
    expect(readAckFrame(JSON.stringify(["ids"]))).toBeNull();
  });

  it("the socket ack and the HTTP ack address one command", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await openSocket(h.app, { device: DEVICE });

    // Ack over the socket...
    await h.sockets.ack(JSON.stringify({ ids: ["cmd_1"] }));

    // ...and the HTTP poll agrees it is gone.
    expect(await httpControl(await getControlHttp(h, {}, DEVICE))).toHaveLength(0);

    // And an HTTP ack of a socket-acked id is a 204 no-op.
    expect((await postAckHttp(h, { ids: ["cmd_1"] })).status).toBe(STATUS.noContent);
  });
});

// ---------------------------------------------------------------------------
// 3. HTTP fallback after a disconnect
// ---------------------------------------------------------------------------

describe("disconnect — HTTP polling still works (fallback)", () => {
  it("serves the still-pending command over HTTP after the socket drops", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await openSocket(h.app, { device: DEVICE });

    h.sockets.drop();

    const res = await getControlHttp(h, {}, DEVICE);
    expect(res.status).toBe(STATUS.ok);
    expect(await httpControl(res)).toMatchObject([{ id: "cmd_1", variable: VARIABLE, value: "21.5" }]);
  });

  it("keeps serving a command the socket pushed but the device never acked", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await openSocket(h.app, { device: DEVICE });
    h.sockets.drop();

    // Two polls later it is still deliverable: the socket owned no state.
    expect(await httpControl(await getControlHttp(h, {}, DEVICE))).toHaveLength(1);
    expect(await httpControl(await getControlHttp(h, {}, DEVICE))).toHaveLength(1);
  });

  it("excludes a command acked before the disconnect", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await openSocket(h.app, { device: DEVICE });
    await h.sockets.ack(JSON.stringify({ ids: ["cmd_1"] }));

    h.sockets.drop();

    expect(await httpControl(await getControlHttp(h, {}, DEVICE))).toHaveLength(0);
  });

  it("a fresh HTTP ack after disconnect removes the command", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await openSocket(h.app, { device: DEVICE });
    h.sockets.drop();

    expect((await postAckHttp(h, { ids: ["cmd_1"] })).status).toBe(STATUS.noContent);
    expect(await httpControl(await getControlHttp(h, {}, DEVICE))).toHaveLength(0);
    // And the seam agrees directly.
    expect(await h.control.pendingControls(DEVICE)).toHaveLength(0);
  });

  it("still expires unacked commands on the HTTP path after a disconnect", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1", ttlMs: 1_000 });
    await openSocket(h.app, { device: DEVICE });
    h.sockets.drop();

    h.advance(1_001);
    expect(await httpControl(await getControlHttp(h, {}, DEVICE))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Authentication
// ---------------------------------------------------------------------------

describe("GET /v1/control/ws — authentication", () => {
  it("rejects a connection with no token at all with 401", async () => {
    const h = await harness();
    const res = await openSocket(h.app, { token: null });
    expect(res.status).toBe(STATUS.unauthorized);
    expect((await errorOf(res)).error).toBe("unauthorized");
    // No upgrade happened, so no command could have been leaked.
    expect(h.sockets.upgrades()).toBe(0);
  });

  it("rejects a token the verifier does not know with 401", async () => {
    const h = await harness();
    const res = await openSocket(h.app, { token: "pt_nope" });
    expect(res.status).toBe(STATUS.unauthorized);
    expect(h.sockets.upgrades()).toBe(0);
  });

  it("rejects a blank query token with 401", async () => {
    const h = await harness();
    const res = await openSocket(h.app, { token: "   " });
    expect(res.status).toBe(STATUS.unauthorized);
  });

  it("accepts the token from the Authorization header (the machine path)", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    const res = await openSocket(h.app, {
      token: null,
      headers: { [AUTHORIZATION_HEADER]: `Bearer ${TOKEN}` },
      device: DEVICE,
    });
    expect(res.status).toBe(101);
    expect(frameControl(h.sockets.lastFrame()).map((c) => c.id)).toEqual(["cmd_1"]);
  });

  it("rejects a non-Bearer Authorization header (not a credential at all)", async () => {
    const h = await harness();
    const res = await openSocket(h.app, {
      token: null,
      headers: { [AUTHORIZATION_HEADER]: TOKEN },
    });
    expect(res.status).toBe(STATUS.unauthorized);
  });

  it("fails closed (401) when the verifier throws", async () => {
    const h = await harness({
      verifyToken: async () => {
        throw new Error("store unavailable");
      },
    });
    const res = await openSocket(h.app, { token: TOKEN });
    expect(res.status).toBe(STATUS.unauthorized);
  });

  it("does not reach the store on an unauthenticated upgrade", async () => {
    let calls = 0;
    const h = await harness();
    const spy = {
      pendingControls: async () => {
        calls += 1;
        return [];
      },
      ackControls: async () => [],
    };
    const app = new Hono();
    app.get(CONTROL_WS_PATH, createControlWsHandler({ ...h.deps, control: spy }));

    const res = await openSocket(app, { token: "pt_wrong" });
    expect(res.status).toBe(STATUS.unauthorized);
    expect(calls).toBe(0);
  });

  it("prefers the header token over the query token", async () => {
    const h = await harness();
    const seen: string[] = [];
    const app = new Hono();
    app.get(
      CONTROL_WS_PATH,
      createControlWsHandler({
        ...h.deps,
        verifyToken: async (token: string) => {
          seen.push(token);
          return token === TOKEN ? DEVICE_PRINCIPAL : null;
        },
      }),
    );

    await openSocket(app, {
      token: "pt_query",
      headers: { [AUTHORIZATION_HEADER]: `Bearer ${TOKEN}` },
    });
    expect(seen).toEqual([TOKEN]);
  });

  it("resolveToken reads the header first, then the query, else null", async () => {
    const observed: (string | null)[] = [];
    const app = new Hono();
    const capture = (c: Context) => {
      observed.push(resolveToken(c));
      return c.text("ok");
    };
    app.get("/probe", capture);

    await app.request("/probe", { headers: { [AUTHORIZATION_HEADER]: `Bearer pt_header` } });
    await app.request("/probe?token=pt_query");
    await app.request("/probe");

    expect(observed).toEqual(["pt_header", "pt_query", null]);
  });
});

// ---------------------------------------------------------------------------
// Handler seam — mountable units
// ---------------------------------------------------------------------------

describe("control-ws — mountable units", () => {
  it("mounts a bare handler on an arbitrary path", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });

    const app = new Hono<{ Variables: { principal: DevicePrincipal } }>();
    app.get("/control/socket", createControlWsHandler(h.deps));

    const res = await app.request(`/control/socket?token=${TOKEN}&device=${DEVICE}`);
    expect(res.status).toBe(101);
    expect(frameControl(h.sockets.lastFrame()).map((c) => c.id)).toEqual(["cmd_1"]);
  });

  it("can push every device's commands when device scoping is disabled", async () => {
    const h = await harness({ scopeToDevice: false });
    await h.enqueue({ id: "a", device: "dev_a" });
    await h.enqueue({ id: "b", device: "dev_b" });

    const app = new Hono();
    app.get(CONTROL_WS_PATH, createControlWsHandler(h.deps));
    await openSocket(app);

    expect(frameControl(h.sockets.lastFrame()).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("sets the verified principal on the context", async () => {
    const h = await harness();
    let observed: unknown = null;
    const app = new Hono();
    app.get(CONTROL_WS_PATH, async (c) => {
      const res = await createControlWsHandler(h.deps)(c);
      observed = (c as Context).get("principal");
      return res;
    });

    await openSocket(app, { device: DEVICE });
    expect(observed).toEqual(DEVICE_PRINCIPAL);
  });
});
