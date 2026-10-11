/**
 * E04 — end-to-end M3 evidence: two-way control, discrete-event automation and
 * OTA delivery, all driven through the REAL composed worker (`createApp`).
 *
 * Ticket E04 (`.planning/01-02-PLAN.md`, M3 · lane INT). The milestone's gate is
 * behavioural, so this suite drives the *whole* wired surface rather than any
 * module in isolation: every seam below is the module's own honest in-memory
 * fake, and the app is the one `createApp` builds when `AppDeps.m3` supplies the
 * control, events and OTA groups. Nothing here is a second implementation of a
 * route — the assertions observe what the composed app answers.
 *
 * The three scenarios the gate names:
 *
 *   1. **UI sets a variable → device → ACK → gone.** The UI enqueues a command
 *      into the control plane (`ProjectControl.enqueueControl` — the write the
 *      UI performs server-side); the device receives it via `GET /v1/control`
 *      AND, in a second case, unprompted over `GET /v1/control/ws`; the device
 *      acknowledges (HTTP `POST /v1/control/ack` and the socket `{ids}` frame);
 *      the command is gone from both transports afterwards. (FR-CTL-01/02/03/05)
 *
 *   2. **A `temp > 30 → set_variable` automation fires.** A device posts a
 *      discrete event to `POST /v1/events`; the background dispatcher runs the
 *      REAL `AutomationEngine` over a projection whose `temp` is above the
 *      threshold, and the engine's `set_variable` action is recorded. The
 *      threshold is asserted two-sided: below it, nothing is written.
 *      (FR-AUT-01/02/03/04)
 *
 *   3. **OTA offer → image serves the frozen shape.** A stale device's
 *      `GET /v1/ota` returns `{update:{version,size,sha256,url}}`; the
 *      `url` names `GET /v1/ota/image`, which streams the EXACT bytes, and the
 *      digest the offer advertised matches a fresh SHA-256 of those bytes — the
 *      device-side verify the SDK performs. (FR-OTA-02/03/04)
 *
 * The frozen wire shape is asserted against `test/contracts/contract-lock.ts`
 * (the tripwire), so a rename there fails here rather than drifting silently.
 */

import { describe, expect, it } from "vitest";
import { createApp, type App, type AppDeps } from "../../worker/src/app";
import {
  DEFAULT_CONTROL_TTL_MS,
  InMemoryProjectControlStorage,
  ProjectControl,
} from "../../worker/src/platform/durable-objects/project-control";
import {
  CONTROL_WS_ACK_FRAME,
  CONTROL_WS_COMMAND_FRAME,
  CONTROL_WS_DEVICE_PARAM,
  CONTROL_WS_EMPTY_FRAME,
  CONTROL_WS_PATH,
  type ControlSocketPair,
  type WebSocketLike,
  type WebSocketRuntime,
} from "../../worker/src/domains/telemetry/control-ws";
import {
  AutomationEngine,
  InMemoryProjection,
  RecordingExecutor,
  type Rule,
} from "../../worker/src/platform/engine/run";
import {
  InMemoryAutomations,
  InMemoryRunLog,
} from "../../worker/src/platform/engine/manual-run";
import { MembershipService } from "../../worker/src/domains/projects/membership";
import type { ProjectRepo } from "../../worker/src/domains/projects/membership";
import {
  InMemoryFirmwareRepo,
  InMemoryImageStore,
  firmwareKey,
  sha256Hex,
} from "../../worker/src/domains/firmware/upload";
import type { DevicePrincipal } from "../../worker/src/platform/middleware/resolve-project";
import type {
  DashboardLayout,
  Point,
  Share,
  ShareResolver,
} from "../../worker/src/domains/dashboards/public";
import {
  CONTRACT_HEADERS,
  CONTROL_COMMAND_FIELDS,
  CONTROL_RESPONSE_FIELDS,
  GET_CONTROL,
  OTA_RESPONSE_FIELDS,
  OTA_UPDATE_FIELDS,
  STATUS,
} from "../contracts/contract-lock";
import { OTA_IMAGE, OTA_OFFER } from "../contracts/ota-lock";

// ---------------------------------------------------------------------------
// Fixtures — one project, one device token, one automation.
// ---------------------------------------------------------------------------

const PROJECT = "proj_m3_demo";
const TOKEN = "pt_m3_demo_token";
const DEVICE = "iot-sim-m3";
const VARIABLE = "led";
const SETPOINT = "1";

/** The exactly-knowable instant every request runs against. */
const FIXED_NOW = 1_700_000_000_000;

/** A well-formed device principal for {@link PROJECT}, scoped `read write`. */
const DEVICE_PRINCIPAL: DevicePrincipal = {
  kind: "device",
  projectId: PROJECT,
  tokenId: "tok_m3_demo",
  scopes: "read write",
};

/** Accept exactly the demo token; refuse everything else. */
const verifyDevice = async (token: string): Promise<DevicePrincipal | null> =>
  token === TOKEN ? DEVICE_PRINCIPAL : null;

const BEARER = { [CONTRACT_HEADERS.authorization]: `Bearer ${TOKEN}` } as const;

// ---------------------------------------------------------------------------
// The socket seam — a recording fake (no Cloudflare runtime anywhere).
// ---------------------------------------------------------------------------

interface SocketHarness {
  readonly runtime: WebSocketRuntime;
  /** Frames the server pushed, in order, as raw text. */
  frames(): string[];
  /** Deliver one inbound frame to the open connection. */
  feed(raw: string): void;
  /** The last frame pushed, parsed. */
  lastFrame(): Record<string, unknown>;
}

function socketHarness(): SocketHarness {
  const pushed: string[] = [];
  const messageHandlers: ((raw: string) => void)[] = [];
  let opened: ControlSocketPair | null = null;

  const server: WebSocketLike = {
    send: (data: string) => pushed.push(data),
    close: () => {},
  };
  const client: WebSocketLike = { send: () => {}, close: () => {} };

  const runtime: WebSocketRuntime = {
    upgrade: () => {
      opened = { server, client };
      return { pair: opened, response: new Response(null, { status: 101 }) };
    },
    onMessage: (socket, handler) => {
      if (socket === server) messageHandlers.push(handler);
    },
    onClose: () => {},
  };

  return {
    runtime,
    frames: () => [...pushed],
    feed: (raw) => {
      for (const handler of messageHandlers) handler(raw);
    },
    lastFrame: () => JSON.parse(pushed[pushed.length - 1] as string) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Harness — the whole M3 worker, wired exactly as a deploy binds it.
// ---------------------------------------------------------------------------

interface Harness {
  /** The composed app: control + events + OTA, all behind their own contracts. */
  app: App;
  /** The REAL control plane over in-memory storage (the UI's write target). */
  control: ProjectControl;
  /** Advance the control plane's clock (the route shares it). */
  advance: (ms: number) => void;
  /** The automation engine's projection; seed a variable's value here. */
  projection: InMemoryProjection;
  /** The engine's action journal; assert `set_variable` writes here. */
  executor: RecordingExecutor;
  /** The socket seam driving `GET /v1/control/ws`. */
  sockets: SocketHarness;
  /** The OTA seams (firmware rows + object store) the offer/image read. */
  firmware: InMemoryFirmwareRepo;
  images: InMemoryImageStore;
  /** Enqueue an automation that runs when the `event` trigger fires. */
  addAutomation: (rule: Rule, event: string) => void;
  /** Register a public share (plaintext token → layout) for the public route. */
  addShare: (token: string, layout: DashboardLayout) => void;
  /** Seed the projection the public snapshot reads (newest first not required). */
  setPoint: (point: Point) => void;
}

/**
 * A {@link ProjectRepo} with no projects or members.
 *
 * Every mutation throws so an accidental use in this suite is loud. The run
 * route's gate consults it only for an authenticated session; the wiring probe
 * below sends none, so these bodies are never reached — the fake exists to
 * satisfy the seam, not to model membership (that is `manual-run.test.ts`).
 */
const emptyProjectRepo: ProjectRepo = {
  createProject: async () => {
    throw new Error("not used in this suite");
  },
  getProject: async () => null,
  getMember: async () => null,
  listMembers: async () => [],
  addMember: async () => {
    throw new Error("not used in this suite");
  },
  removeMember: async () => {
    throw new Error("not used in this suite");
  },
};

/**
 * Build the composed M3 worker over honest, injected in-memory seams.
 *
 * The control plane is shared by the HTTP routes and the socket, exactly as a
 * deploy wires them, so "the two transports agree" is a property of the object
 * under test rather than of two fixtures. The dispatcher runs the REAL engine,
 * so an event's consequence is the engine's own behaviour.
 */
function harness(): Harness {
  let now = FIXED_NOW;
  const control = new ProjectControl({
    storage: new InMemoryProjectControlStorage(),
    now: () => now,
  });

  const projection = new InMemoryProjection();
  const executor = new RecordingExecutor();
  const engine = new AutomationEngine({
    projection,
    executor,
    integrations: executor,
    now: () => now,
  });

  // The event→rule router the dispatcher owns: `event` name → the rules it runs.
  const rulesByEvent = new Map<string, Rule[]>();
  const sockets = socketHarness();
  const firmware = new InMemoryFirmwareRepo();
  const images = new InMemoryImageStore();

  // The public dashboard's three seams: share token → layout → projection.
  const layoutsById = new Map<string, DashboardLayout>();
  const shareTokenByLayout = new Map<string, string>();
  const points: Point[] = [];
  const shares: ShareResolver = async (presented) => {
    const layoutId = shareTokenByLayout.get(presented);
    if (layoutId === undefined) return null;
    // A resolver returns a row indexed by digest; the service re-checks it, so
    // the fake returns a share whose `tokenHash` is the token's real digest.
    const share: Share = {
      id: `shr_${layoutId}`,
      tokenHash: await sha256Hex(new TextEncoder().encode(presented)),
      projectId: PROJECT,
      layoutId,
      expiresAt: null,
      revokedAt: null,
    };
    return share;
  };

  const deps: AppDeps = {
    deviceTokens: verifyDevice,
    sessions: async () => null,
    ingest: {
      verifyToken: async (token) =>
        token === TOKEN
          ? { kind: "device", projectId: PROJECT, scopes: "read write" }
          : null,
      sink: { record: async () => undefined },
      devices: { register: () => undefined, has: () => false },
      now: () => now,
    },
    query: {
      credentials: async () => null,
      projects: { state: async () => [] },
      shards: { ring: async () => [] },
    },
    m3: {
      control: { plane: control, verifyToken: verifyDevice, ws: sockets.runtime },
      events: {
        verifyToken: async (token, _c) => (token === TOKEN ? DEVICE_PRINCIPAL : null),
        dispatch: async (trigger) => {
          const rules = rulesByEvent.get(trigger.event ?? "") ?? [];
          if (rules.length > 0) await engine.run(rules, trigger);
        },
      },
      ota: {
        offer: {
          firmware,
          targets: {
            assigned: async () => OTA_VERSION,
            latest: async () => OTA_VERSION,
          },
          verifyToken: verifyDevice,
          now: () => now,
        },
        image: {
          images: { get: async (key) => images.get(key) ?? null },
          firmware: {
            findKey: async (projectId, version) =>
              (await firmware.find(projectId, version))?.r2Key ?? null,
          },
          quota: { consume: async () => ({ allowed: true as const }) },
          verifyToken: verifyDevice,
        },
      },
      publicDashboard: {
        shares,
        layouts: async (layoutId) => layoutsById.get(layoutId) ?? null,
        projection: {
          snapshot: async (_projectId, limit) => points.slice(0, limit),
        },
        now: () => now,
      },
      manualRun: {
        deps: {
          engine,
          automations: new InMemoryAutomations(),
          runLog: new InMemoryRunLog({ genId: () => "run_m3", now: () => now }),
          membership: new MembershipService(emptyProjectRepo),
        },
        // No session is resolvable here, so the gate is fail-closed: a request
        // without a valid session is the gate's own 401, never the handler's.
        credentials: { deviceTokens: async () => null, sessions: async () => null },
      },
    },
  };

  return {
    app: createApp(deps),
    control,
    advance: (ms) => {
      now += ms;
    },
    projection,
    executor,
    sockets,
    firmware,
    images,
    addAutomation: (rule, event) => {
      rulesByEvent.set(event, [...(rulesByEvent.get(event) ?? []), rule]);
    },
    addShare: (token, layout) => {
      layoutsById.set(layout.id, layout);
      shareTokenByLayout.set(token, layout.id);
    },
    setPoint: (point) => {
      points.unshift(point);
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The `control` array of a `GET /v1/control` response, unwrapped. */
async function controlArray(res: Response): Promise<Record<string, unknown>[]> {
  const body = (await res.json()) as Record<string, unknown>;
  return body[CONTROL_RESPONSE_FIELDS[0]] as Record<string, unknown>[];
}

/** Enqueue one command exactly as the UI's "set variable" action would. */
function uiSetVariable(
  control: ProjectControl,
  value: string,
  overrides: Partial<{ id: string; device: string; variable: string }> = {},
): Promise<unknown> {
  return control.enqueueControl({
    id: overrides.id ?? "cmd_ui_1",
    device: overrides.device ?? DEVICE,
    variable: overrides.variable ?? VARIABLE,
    value,
  });
}

/**
 * Let an async write started by a swallowed promise settle.
 *
 * The socket runtime's `onMessage` seam is typed `(raw) => void`, so the ack's
 * async write is fired but not awaited for us. The write touches only
 * in-memory storage (no timers), so a bounded microtask drain is deterministic:
 * we yield to the event loop a fixed number of times, never sleep.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** The device's current pending commands, read straight from the plane. */
function pending(control: ProjectControl, device: string): Promise<unknown[]> {
  return control.pendingControls(device);
}

// ===========================================================================
// 1. UI sets a variable → device → ACK → gone (HTTP poll)
// ===========================================================================
describe("M3 e2e — UI set variable → device poll → ACK → gone", () => {
  it("delivers the UI's command to the device, then removes it on ACK", async () => {
    const h = harness();

    // The UI action: write a command into the control plane.
    await uiSetVariable(h.control, SETPOINT);

    // The device polls and sees exactly the contract's three fields.
    const polled = await h.app.request(GET_CONTROL.path, {
      method: GET_CONTROL.method,
      headers: { ...BEARER, [CONTRACT_HEADERS.device]: DEVICE },
    });
    expect(polled.status).toBe(GET_CONTROL.success);
    const first = await controlArray(polled);
    expect(first).toHaveLength(1);
    expect(Object.keys(first[0])).toEqual([...CONTROL_COMMAND_FIELDS]);
    expect(first[0][CONTROL_COMMAND_FIELDS[1]]).toBe(VARIABLE);
    expect(first[0][CONTROL_COMMAND_FIELDS[2]]).toBe(SETPOINT);

    // The device applies it and acknowledges by id.
    const id = first[0][CONTROL_COMMAND_FIELDS[0]] as string;
    const acked = await h.app.request("/v1/control/ack", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    });
    expect(acked.status).toBe(STATUS.noContent);

    // The command is gone: the poll is empty.
    const polledAgain = await h.app.request(GET_CONTROL.path, {
      method: GET_CONTROL.method,
      headers: { ...BEARER, [CONTRACT_HEADERS.device]: DEVICE },
    });
    expect(await controlArray(polledAgain)).toEqual([]);

    // Re-acking is a no-op, not an error (FR-CTL-04 idempotence).
    const reAcked = await h.app.request("/v1/control/ack", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    });
    expect(reAcked.status).toBe(STATUS.noContent);
  });

  it("never returns a command past its TTL (INV-T6 / ST-T6)", async () => {
    const h = harness();
    await uiSetVariable(h.control, SETPOINT);

    // Move past the 24h lifetime the route inherits.
    h.advance(DEFAULT_CONTROL_TTL_MS + 1);

    const res = await h.app.request(GET_CONTROL.path, {
      method: GET_CONTROL.method,
      headers: { ...BEARER, [CONTRACT_HEADERS.device]: DEVICE },
    });
    expect(await controlArray(res)).toEqual([]);
  });
});

// ===========================================================================
// 2. UI sets a variable → device → ACK → gone (WebSocket push, no polling)
// ===========================================================================
describe("M3 e2e — UI set variable → device WS push → ack frame → gone", () => {
  it("pushes the pending command on connect and clears it on the socket ack", async () => {
    const h = harness();
    await uiSetVariable(h.control, SETPOINT);

    // The device connects without polling; the server pushes its commands.
    const upgrade = await h.app.request(
      `${CONTROL_WS_PATH}?${CONTROL_WS_DEVICE_PARAM}=${DEVICE}`,
      { headers: BEARER },
    );
    expect(upgrade.status).toBe(101);
    const frame = h.sockets.lastFrame();
    expect(frame.type).toBe(CONTROL_WS_COMMAND_FRAME);
    const commands = frame.control as Record<string, unknown>[];
    expect(Object.keys(commands[0])).toEqual([...CONTROL_COMMAND_FIELDS]);

    // Before the ack the command is present, so "gone" below is not vacuous.
    expect(await pending(h.control, DEVICE)).toHaveLength(1);

    // The device acks over the socket; the frame handler runs the real seam.
    const id = commands[0][CONTROL_COMMAND_FIELDS[0]] as string;
    h.sockets.feed(JSON.stringify({ ids: [id] }));
    await settle();
    // The command is gone from the shared plane the HTTP route reads.
    expect(await pending(h.control, DEVICE)).toEqual([]);
  });

  it("an empty connect is told so explicitly, never left in silence", async () => {
    const h = harness();
    const upgrade = await h.app.request(
      `${CONTROL_WS_PATH}?${CONTROL_WS_DEVICE_PARAM}=${DEVICE}`,
      { headers: BEARER },
    );
    expect(upgrade.status).toBe(101);
    expect(h.sockets.lastFrame().type).toBe(CONTROL_WS_EMPTY_FRAME);
  });

  it("acks echoed on the socket carry the frozen frame type", async () => {
    const h = harness();
    await uiSetVariable(h.control, SETPOINT);
    await h.app.request(`${CONTROL_WS_PATH}?${CONTROL_WS_DEVICE_PARAM}=${DEVICE}`, {
      headers: BEARER,
    });
    const id = (h.sockets.lastFrame().control as Record<string, unknown>[])[0][
      CONTROL_COMMAND_FIELDS[0]
    ] as string;

    h.sockets.feed(JSON.stringify({ ids: [id] }));
    await settle();
    expect(h.sockets.frames().some((f) => JSON.parse(f).type === CONTROL_WS_ACK_FRAME)).toBe(true);
  });
});

// ===========================================================================
// 3. Automation: temp > 30 → set_variable fires (event-triggered)
// ===========================================================================
describe("M3 e2e — automation temp > 30 → set_variable", () => {
  /** The rule the event trigger runs: when `temp > 30`, set `alarm` to 1. */
  function overheatRule(): Rule {
    return {
      id: "aut_overheat",
      cooldownMs: 0,
      conditions: [{ type: "if_variable", key: "temp", op: "gt", value: 30 }],
      actions: [{ type: "set_variable", key: "alarm", value: 1 }],
    };
  }

  it("fires the action when temp is above the threshold", async () => {
    const h = harness();
    h.projection.set("temp", 35);
    h.addAutomation(overheatRule(), "reading");

    const res = await h.app.request("/v1/events", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify({ event: "reading", payload: { temp: 35 } }),
    });
    expect(res.status).toBe(STATUS.noContent);

    // The engine's own journal recorded the `set_variable` write for this tenant.
    const write = h.executor.writes.find((w) => w.kind === "set_variable");
    expect(write).toBeDefined();
    expect(write?.projectId).toBe(PROJECT);
    expect(write?.detail).toMatchObject({ key: "alarm", value: 1 });
  });

  it("does NOT fire when temp is at or below the threshold", async () => {
    const h = harness();
    h.projection.set("temp", 30); // `gt` is strict: 30 is not > 30.
    h.addAutomation(overheatRule(), "reading");

    const res = await h.app.request("/v1/events", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify({ event: "reading", payload: { temp: 30 } }),
    });
    expect(res.status).toBe(STATUS.noContent);
    expect(h.executor.writes).toEqual([]);
  });
});

// ===========================================================================
// 4. OTA: offer → image serves the frozen shape the device verifies
// ===========================================================================
const OTA_VERSION = "1.2.0";
const OTA_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42, 0x00, 0x01]);

/** Seed the project's firmware row + its bytes, as the upload path would. */
async function seedFirmware(h: Harness): Promise<string> {
  const key = firmwareKey(PROJECT, OTA_VERSION);
  await h.images.put(key, OTA_BYTES, "application/octet-stream");
  const sha256 = await sha256Hex(OTA_BYTES);
  await h.firmware.insert({
    id: "fw_m3",
    projectId: PROJECT,
    version: OTA_VERSION,
    size: OTA_BYTES.byteLength,
    sha256,
    r2Key: key,
    createdAt: 0,
    updatedAt: 0,
  });
  return sha256;
}

describe("M3 e2e — OTA offer → image serves the frozen shape", () => {
  it("offers a stale device exactly {version,size,sha256,url} and serves those bytes", async () => {
    const h = harness();
    const sha256 = await seedFirmware(h);

    // The stale device reports an old version and is offered the target.
    const offerRes = await h.app.request(OTA_OFFER.path, {
      method: OTA_OFFER.method,
      headers: { ...BEARER, [OTA_OFFER.requestHeader]: "0.9.0" },
    });
    expect(offerRes.status).toBe(OTA_OFFER.success);
    const offer = (await offerRes.json()) as Record<string, unknown>;
    const update = offer[OTA_RESPONSE_FIELDS[0]] as Record<string, unknown>;
    // Exact field order: the SDK's index scanner depends on it.
    expect(Object.keys(update)).toEqual([...OTA_UPDATE_FIELDS]);
    expect(update[OTA_UPDATE_FIELDS[0]]).toBe(OTA_VERSION);
    expect(update[OTA_UPDATE_FIELDS[1]]).toBe(OTA_BYTES.byteLength);

    // The advertised URL names the image route the device now fetches.
    expect(update[OTA_UPDATE_FIELDS[3]]).toBe(OTA_IMAGE.path);
    const imageRes = await h.app.request(update[OTA_UPDATE_FIELDS[3]] as string, {
      method: OTA_IMAGE.method,
      headers: { ...BEARER, [OTA_IMAGE.requestHeader]: OTA_VERSION },
    });
    expect(imageRes.status).toBe(OTA_IMAGE.success);
    expect(imageRes.headers.get("content-type")).toBe(OTA_IMAGE.contentType);

    const bytes = new Uint8Array(await imageRes.arrayBuffer());
    // The device-side verify: size and SHA-256 both match the offer.
    expect(bytes.byteLength).toBe(update[OTA_UPDATE_FIELDS[1]]);
    expect(await sha256Hex(bytes)).toBe(update[OTA_UPDATE_FIELDS[2]]);
    expect(update[OTA_UPDATE_FIELDS[2]]).toBe(sha256);
  });

  it("a device already on the target is told {\"update\":null}", async () => {
    const h = harness();
    await seedFirmware(h);
    const res = await h.app.request(OTA_OFFER.path, {
      method: OTA_OFFER.method,
      headers: { ...BEARER, [OTA_OFFER.requestHeader]: OTA_VERSION },
    });
    expect(res.status).toBe(OTA_OFFER.success);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body[OTA_RESPONSE_FIELDS[0]]).toBeNull();
  });

  it("requires a credential on both OTA routes (module-owned 401, not 404)", async () => {
    const h = harness();
    const offer = await h.app.request(OTA_OFFER.path, { method: OTA_OFFER.method });
    expect(offer.status).toBe(STATUS.unauthorized);
    const image = await h.app.request(OTA_IMAGE.path, { method: OTA_IMAGE.method });
    expect(image.status).toBe(STATUS.unauthorized);
  });
});

// ===========================================================================
// 5. Public dashboard: the allow-list is enforced server-side, fail-closed
// ===========================================================================
describe("M3 e2e — public dashboard filters to the share's layout", () => {
  it("never exposes a variable outside the layout the share names", async () => {
    const h = harness();
    // The project holds a public `temp` and a private `secret_token`.
    h.setPoint({ device: DEVICE, variable: "temp", value: 21, ts: FIXED_NOW, seq: 1 });
    h.setPoint({ device: DEVICE, variable: "secret_token", value: 42, ts: FIXED_NOW, seq: 2 });
    // The share's layout names ONLY `temp`.
    h.addShare("shr_public_demo", { id: "dash_1", variables: ["temp"] });

    const res = await h.app.request("/v1/public/dashboards/shr_public_demo");
    expect(res.status).toBe(STATUS.ok);

    // The secret's variable AND value are absent from the serialised payload.
    const raw = await res.text();
    expect(raw).not.toContain("secret_token");
    const body = JSON.parse(raw) as { variables: string[]; points: Point[] };
    expect(body.variables).toEqual(["temp"]);
    expect(body.points.map((p) => p.variable)).toEqual(["temp"]);
  });

  it("refuses an unknown share with a uniform 404", async () => {
    const h = harness();
    const res = await h.app.request("/v1/public/dashboards/not_a_share");
    expect(res.status).toBe(STATUS.notFound);
  });
});

// ===========================================================================
// 6. Admin manual-run is mounted behind its session gate
// ===========================================================================
describe("M3 e2e — admin manual-run is wired behind the session gate", () => {
  it("answers a session-less run with the gate's own 401, not a 404", async () => {
    const h = harness();
    const res = await h.app.request(
      `/v1/admin/projects/${PROJECT}/automations/aut_overheat/run`,
      { method: "POST" },
    );
    // The gate (`resolveAdminProject`) refuses before the handler: the route is
    // mounted (not the framework's 404) and fail-closed without a session.
    expect(res.status).toBe(STATUS.unauthorized);
  });
});
