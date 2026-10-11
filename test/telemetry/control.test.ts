import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  AUTHORIZATION_HEADER,
  CONTROL_ACK_REQUEST_FIELDS,
  CONTROL_COMMAND_FIELDS,
  CONTROL_RESPONSE_FIELDS,
  DEFAULT_DEVICE_KEY,
  DEVICE_HEADER,
  createControl,
  createControlAckHandler,
  createControlHandler,
  type ControlDeps,
  type ControlHandler,
  type ControlPlane,
  type VerifyControlToken,
} from "../../worker/src/domains/telemetry/control";
import {
  InMemoryProjectControlStorage,
  ProjectControl,
} from "../../worker/src/platform/durable-objects/project-control";
import type { DevicePrincipal } from "../../worker/src/platform/middleware/resolve-project";

// The FROZEN cross-repo contract lock — the tripwire this suite asserts against.
import {
  CONTRACT_ERRORS,
  CONTROL_ACK_REQUEST_FIELDS as LOCK_ACK_FIELDS,
  CONTROL_COMMAND_FIELDS as LOCK_COMMAND_FIELDS,
  CONTROL_RESPONSE_FIELDS as LOCK_RESPONSE_FIELDS,
  ERROR_BODY_FIELDS,
  GET_CONTROL,
  POST_CONTROL_ACK,
  STATUS,
} from "../contracts/contract-lock";

/**
 * Spec tests for the device control (downlink) routes — `GET /v1/control` and
 * `POST /v1/control/ack`.
 *
 * Every dependency is injected (the control-plane seam plus a token verifier),
 * and the seam is the REAL `ProjectControl` over its in-memory storage, so each
 * contract is asserted against behaviour we own outright — no mocking of the
 * code under test:
 *
 *   1. **Delivery** — an enqueued command is returned as `{id, variable, value}`.
 *   2. **Ack** — a `204`; the command disappears; re-acking (even an unknown or
 *      already-expired id) is a no-op, never an error.
 *   3. **Expiry** (INV-T6 / ST-T6) — moving the clock past the 24h TTL drops the
 *      command; it is never returned again.
 *   4. **Auth** — no token, a non-Bearer header, or a rejected token is `401`
 *      with the frozen `{ error, message }` body.
 *   5. **Contract** — the live response shape matches `test/contracts/contract-lock.ts`.
 */

const PROJECT = "proj_control";
const TOKEN = "pt_control_token";
const DEVICE = "dev_alpha";
const VARIABLE = "setpoint";

/** The exactly-knowable instant every request runs against. */
const FIXED_NOW = 1_700_000_000_123;
/** The default command lifetime the route inherits: 24h. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** A well-formed device principal for {@link PROJECT}, scoped `read write`. */
const DEVICE_PRINCIPAL: DevicePrincipal = {
  kind: "device",
  projectId: PROJECT,
  tokenId: "tok_control",
  scopes: "read write",
};

interface Harness {
  /** Mounted app: `GET /v1/control` + `POST /v1/control/ack`. */
  app: Hono;
  /** The REAL control plane over in-memory storage. */
  control: ProjectControl;
  /** Advance the control plane's clock (the route shares it). */
  advance: (ms: number) => void;
  /** Enqueue one command, defaulting to DEVICE / setpoint / "21.5". */
  enqueue: (
    overrides?: Partial<{ id: string; device: string; variable: string; value: string | null; ttlMs: number }>,
  ) => Promise<void>;
}

/**
 * Build a fully-injected downlink surface.
 *
 * `verifyToken` accepts exactly {@link TOKEN} by default; pass an override to
 * exercise the refusal paths. The control plane is the real {@link ProjectControl}
 * over `InMemoryProjectControlStorage`, with a clock the test drives, so a
 * command's TTL is arithmetic the test owns rather than wall-clock luck.
 */
async function harness(
  overrides: Partial<ControlDeps> & { verifyToken?: VerifyControlToken } = {},
): Promise<Harness> {
  const storage = new InMemoryProjectControlStorage();
  let now = FIXED_NOW;
  const control = new ProjectControl({ storage, now: () => now });
  await control.init();

  const verifyToken: VerifyControlToken =
    overrides.verifyToken ?? (async (token) => (token === TOKEN ? DEVICE_PRINCIPAL : null));

  const app = createControl({ control, verifyToken, ...overrides });

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
    control,
    advance: (ms) => {
      now += ms;
    },
    enqueue,
  };
}

/** GET `/v1/control` with the given headers and device. */
function getControl(app: Hono, headers: Record<string, string> = {}, device?: string): Promise<Response> {
  const h: Record<string, string> = {
    [AUTHORIZATION_HEADER]: `Bearer ${TOKEN}`,
    ...headers,
  };
  if (device !== undefined) h[DEVICE_HEADER] = device;
  return Promise.resolve(app.request("/", { method: "GET", headers: h }));
}

/** POST `/v1/control/ack` with a body and the given headers. */
function postAck(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request("/ack", {
      method: "POST",
      headers: { "content-type": "application/json", [AUTHORIZATION_HEADER]: `Bearer ${TOKEN}`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** The `control` array of a `GET /v1/control` response. */
async function controlArray(res: Response): Promise<Record<string, unknown>[]> {
  const body = (await res.json()) as Record<string, unknown>;
  return body[CONTROL_RESPONSE_FIELDS[0]] as Record<string, unknown>[];
}

/** Read a `{ error, message }` body from a rejected response. */
async function errorOf(res: Response): Promise<{ error: string; message: string }> {
  const parsed = (await res.json()) as { error?: unknown; message?: unknown };
  if (typeof parsed.error !== "string" || typeof parsed.message !== "string") {
    throw new Error(`unexpected error body: ${JSON.stringify(parsed)}`);
  }
  return { error: parsed.error, message: parsed.message };
}

// ---------------------------------------------------------------------------
// Contract lock — the wire field names are the lock's, not a second copy
// ---------------------------------------------------------------------------

describe("control route — contract lock agreement", () => {
  it("uses the frozen envelope and command field names", () => {
    expect(CONTROL_RESPONSE_FIELDS).toEqual(LOCK_RESPONSE_FIELDS);
    expect(CONTROL_RESPONSE_FIELDS).toEqual(["control"]);
    expect(CONTROL_COMMAND_FIELDS).toEqual(LOCK_COMMAND_FIELDS);
    expect(CONTROL_COMMAND_FIELDS).toEqual(["id", "variable", "value"]);
    expect(CONTROL_ACK_REQUEST_FIELDS).toEqual(LOCK_ACK_FIELDS);
    expect(CONTROL_ACK_REQUEST_FIELDS).toEqual(["ids"]);
    expect(AUTHORIZATION_HEADER).toBe(GET_CONTROL.headers[0]);
  });

  it("matches the frozen response shape for one pending command", async () => {
    const h = await harness();
    await h.enqueue();

    const res = await getControl(h.app, {}, DEVICE);
    expect(res.status).toBe(GET_CONTROL.success);
    expect(res.status).toBe(STATUS.ok);

    const control = await controlArray(res);
    expect(control).toHaveLength(1);
    // Each element carries EXACTLY the contract's three fields, in that order.
    expect(Object.keys(control[0])).toEqual([...CONTROL_COMMAND_FIELDS]);
    expect(control[0]).toEqual({ id: "cmd_1", variable: VARIABLE, value: "21.5" });
  });

  it("returns an empty array — a valid success — when nothing is pending", async () => {
    const h = await harness();
    const res = await getControl(h.app, {}, DEVICE);

    expect(res.status).toBe(GET_CONTROL.success);
    const body = (await res.json()) as Record<string, unknown>;
    // The envelope key is present and holds exactly GET_CONTROL's empty value.
    expect(Object.keys(body)).toEqual([...CONTROL_RESPONSE_FIELDS]);
    expect(body[CONTROL_RESPONSE_FIELDS[0]]).toEqual([...GET_CONTROL.emptyValue]);
  });

  it("returns 204 with no body on ack, as the lock freezes", async () => {
    const h = await harness();
    await h.enqueue();
    const res = await postAck(h.app, { [CONTROL_ACK_REQUEST_FIELDS[0]]: ["cmd_1"] });

    expect(res.status).toBe(POST_CONTROL_ACK.success);
    expect(res.status).toBe(STATUS.noContent);
    expect(await res.text()).toBe("");
    // The lock freezes an EMPTY success body for a 204.
    expect(POST_CONTROL_ACK.successBodyFields).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Delivery and acknowledgement
// ---------------------------------------------------------------------------

describe("GET /v1/control — pending delivery", () => {
  it("returns a pending command with its id, variable and value", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_7", variable: "heater", value: "on" });

    const control = await controlArray(await getControl(h.app, {}, DEVICE));
    expect(control).toEqual([{ id: "cmd_7", variable: "heater", value: "on" }]);
  });

  it("carries a null value opaquely", async () => {
    const h = await harness();
    await h.enqueue({ value: null });

    const control = await controlArray(await getControl(h.app, {}, DEVICE));
    expect(control[0].value).toBeNull();
  });

  it("returns commands oldest first", async () => {
    const h = await harness();
    await h.enqueue({ id: "first" });
    h.advance(1_000);
    await h.enqueue({ id: "second" });
    h.advance(1_000);
    await h.enqueue({ id: "third" });

    const control = await controlArray(await getControl(h.app, {}, DEVICE));
    expect(control.map((c) => c.id)).toEqual(["first", "second", "third"]);
  });

  it("scopes delivery to the polling device", async () => {
    const h = await harness();
    await h.enqueue({ id: "mine", device: DEVICE });
    await h.enqueue({ id: "theirs", device: "dev_other" });

    const control = await controlArray(await getControl(h.app, {}, DEVICE));
    expect(control.map((c) => c.id)).toEqual(["mine"]);
  });

  it("delivers commands for the default key when the device header is absent", async () => {
    const h = await harness();
    await h.enqueue({ id: "anon", device: DEFAULT_DEVICE_KEY });

    const control = await controlArray(await getControl(h.app));
    expect(control.map((c) => c.id)).toEqual(["anon"]);
  });
});

describe("POST /v1/control/ack — idempotence", () => {
  it("makes an acked command disappear from the next poll", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(1);

    const ack = await postAck(h.app, { ids: ["cmd_1"] });
    expect(ack.status).toBe(204);

    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(0);
  });

  it("re-acking the same id is a no-op, not an error", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });

    expect((await postAck(h.app, { ids: ["cmd_1"] })).status).toBe(204);
    const second = await postAck(h.app, { ids: ["cmd_1"] });
    expect(second.status).toBe(204);
    expect(await second.text()).toBe("");

    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(0);
  });

  it("acking an unknown id is a no-op, not an error", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });

    const res = await postAck(h.app, { ids: ["never_enqueued"] });
    expect(res.status).toBe(204);
    // The real command is untouched by the unrelated ack.
    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(1);
  });

  it("accepts an empty id list as a no-op", async () => {
    const h = await harness();
    await h.enqueue();
    expect((await postAck(h.app, { ids: [] })).status).toBe(204);
    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(1);
  });

  it("acks a batch, ignoring ids that are already terminal", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_1" });
    await h.enqueue({ id: "cmd_2" });
    await h.enqueue({ id: "cmd_3" });
    await h.control.ackControls(["cmd_2"]);

    const res = await postAck(h.app, { ids: ["cmd_1", "cmd_2", "cmd_3", "ghost"] });
    expect(res.status).toBe(204);
    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(0);
  });

  it("rejects a malformed ack body with 400", async () => {
    const h = await harness();
    const res = await postAck(h.app, { notIds: ["cmd_1"] });
    expect(res.status).toBe(STATUS.badRequest);
    expect((await errorOf(res)).error).toBe("invalid_json");
  });
});

// ---------------------------------------------------------------------------
// Expiry — INV-T6 / ST-T6
// ---------------------------------------------------------------------------

describe("GET /v1/control — TTL expiry (INV-T6 / ST-T6)", () => {
  it("returns a command right up to the deadline and never one millisecond past", async () => {
    const h = await harness();
    await h.enqueue({ ttlMs: ONE_DAY_MS });

    // Live exactly at the deadline...
    h.advance(ONE_DAY_MS);
    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(1);

    // ...and gone one millisecond later — never delivered.
    h.advance(1);
    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(0);
  });

  it("never returns an expired command again, even after more time passes", async () => {
    const h = await harness();
    await h.enqueue({ ttlMs: 60_000 });

    h.advance(60_000 + 1);
    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(0);

    h.advance(ONE_DAY_MS);
    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(0);
  });

  it("expires per command, leaving live commands deliverable", async () => {
    const h = await harness();
    await h.enqueue({ id: "short", ttlMs: 1_000 });
    await h.enqueue({ id: "long", ttlMs: ONE_DAY_MS });

    h.advance(1_001);
    const control = await controlArray(await getControl(h.app, {}, DEVICE));
    expect(control.map((c) => c.id)).toEqual(["long"]);
  });

  it("does not resurrect an expired command when it is acked", async () => {
    const h = await harness();
    await h.enqueue({ ttlMs: 1_000 });

    h.advance(1_001);
    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(0);

    // Acking an expired row is a no-op — terminal states are terminal.
    expect((await postAck(h.app, { ids: ["cmd_1"] })).status).toBe(204);
    expect(await controlArray(await getControl(h.app, {}, DEVICE))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Authentication — missing / invalid token => 401
// ---------------------------------------------------------------------------

describe("control routes — authentication", () => {
  it("rejects a missing Authorization header on GET with 401 + frozen body", async () => {
    const h = await harness();
    const res = await h.app.request("/", { method: "GET" });

    expect(res.status).toBe(STATUS.unauthorized);
    expect(res.status).toBe(CONTRACT_ERRORS.unauthorized.status);
    const body = await errorOf(res);
    expect(Object.keys(body).sort()).toEqual([...ERROR_BODY_FIELDS].sort());
    expect(body.error).toBe("unauthorized");
  });

  it("rejects an invalid token on GET with 401", async () => {
    const h = await harness();
    const res = await getControl(h.app, { [AUTHORIZATION_HEADER]: "Bearer nope" }, DEVICE);
    expect(res.status).toBe(STATUS.unauthorized);
  });

  it("rejects a non-Bearer Authorization header (not a credential at all)", async () => {
    const h = await harness();
    const res = await getControl(h.app, { [AUTHORIZATION_HEADER]: TOKEN }, DEVICE);
    expect(res.status).toBe(STATUS.unauthorized);
  });

  it("rejects a missing Authorization header on ack with 401", async () => {
    const h = await harness();
    const res = await h.app.request("/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["cmd_1"] }),
    });
    expect(res.status).toBe(STATUS.unauthorized);
  });

  it("rejects an invalid token on ack with 401", async () => {
    const h = await harness();
    const res = await postAck(h.app, { ids: ["cmd_1"] }, { [AUTHORIZATION_HEADER]: "Bearer bad" });
    expect(res.status).toBe(STATUS.unauthorized);
  });

  it("fails closed (401) when the verifier throws", async () => {
    const h = await harness({
      verifyToken: async () => {
        throw new Error("store unavailable");
      },
    });
    const res = await getControl(h.app, {}, DEVICE);
    expect(res.status).toBe(STATUS.unauthorized);
  });

  it("does not reach the store on an unauthenticated poll", async () => {
    let calls = 0;
    const spy: ControlPlane = {
      pendingControls: async () => {
        calls += 1;
        return [];
      },
      ackControls: async () => [],
    };
    const app = createControl({ control: spy, verifyToken: async () => null });

    const res = await app.request("/", { method: "GET" });
    expect(res.status).toBe(STATUS.unauthorized);
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Handler seam — mountable on an arbitrary path
// ---------------------------------------------------------------------------

describe("control handlers — mountable units", () => {
  it("mounts a bare GET handler on any path", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_x" });

    const app = new Hono<{ Variables: { principal: DevicePrincipal } }>();
    app.get("/v1/control", createControlHandler({ control: h.control, verifyToken: async () => DEVICE_PRINCIPAL }));

    const res = await app.request("/v1/control", {
      headers: { [AUTHORIZATION_HEADER]: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { control: { id: string }[] };
    expect(body.control.map((c) => c.id)).toEqual([]);
  });

  it("mounts a bare ack handler on any path", async () => {
    const h = await harness();
    await h.enqueue({ id: "cmd_y" });

    const app = new Hono<{ Variables: { principal: DevicePrincipal } }>();
    const handler: ControlHandler = createControlAckHandler({
      control: h.control,
      verifyToken: async () => DEVICE_PRINCIPAL,
    });
    app.post("/v1/control/ack", handler);

    const res = await app.request("/v1/control/ack", {
      method: "POST",
      headers: { "content-type": "application/json", [AUTHORIZATION_HEADER]: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ids: ["cmd_y"] }),
    });
    expect(res.status).toBe(204);
    expect(await h.control.pendingControls(DEVICE)).toHaveLength(0);
  });

  it("can list every device's commands when device scoping is disabled", async () => {
    const h = await harness();
    await h.enqueue({ id: "a", device: "dev_a" });
    await h.enqueue({ id: "b", device: "dev_b" });

    const app = new Hono();
    app.get(
      "/v1/control",
      createControlHandler({
        control: h.control,
        verifyToken: async () => DEVICE_PRINCIPAL,
        scopeToDevice: false,
      }),
    );

    const res = await app.request("/v1/control", {
      headers: { [AUTHORIZATION_HEADER]: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { control: { id: string }[] };
    expect(body.control.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
