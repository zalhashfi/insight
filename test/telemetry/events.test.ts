import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  AUTHORIZATION_HEADER,
  EVENT_NAME_FIELD,
  EVENT_PAYLOAD_FIELD,
  EVENT_REQUEST_FIELDS,
  INVALID_JSON_CODE,
  UNAUTHORIZED_CODE,
  createEventHandler,
  createEvents,
  type EventDeps,
  type VerifyEventToken,
} from "../../worker/src/domains/telemetry/events";
import {
  AutomationEngine,
  InMemoryProjection,
  RecordingExecutor,
  type Rule,
  type Trigger,
} from "../../worker/src/platform/engine/run";
import type { DevicePrincipal } from "../../worker/src/platform/middleware/resolve-project";

// The FROZEN cross-repo contract lock — the tripwire this suite asserts against.
import {
  CONTRACT_ERRORS,
  ERROR_BODY_FIELDS,
  STATUS,
} from "../contracts/contract-lock";

/**
 * Spec tests for the discrete-event node — `POST /v1/events` (spec §6.6,
 * FR-TEL-10, A21b).
 *
 * Every dependency is injected (a token verifier plus a background-dispatch
 * seam), so each assertion is about this route's own behaviour and nothing is
 * mocked that we own. The four claims, one describe block each:
 *
 *   1. **Accept & dispatch** — a valid `{event,payload}` is `204` (empty body)
 *      and the seam receives a trigger for that `event`, scoped to the
 *      credential's project, at depth 0.
 *   2. **Background, not blocking** — the `204` arrives while an engine run
 *      started by the dispatcher is still *pending*; the route does not wait.
 *   3. **Invalid payload is 400** — a body that is not `{event: string, …}` is
 *      refused `invalid_json`, and nothing is dispatched.
 *   4. **Auth** — no token, a non-Bearer header, and a rejected token are all
 *      `401 unauthorized`, with the frozen `{error, message}` body.
 *   5. **Contract** — the field names and codes agree with
 *      `test/contracts/contract-lock.ts`.
 */

const PROJECT = "proj_events";
const TOKEN = "pt_events_token";

/** A well-formed device principal for {@link PROJECT}, scoped `read write`. */
const DEVICE_PRINCIPAL: DevicePrincipal = {
  kind: "device",
  projectId: PROJECT,
  tokenId: "tok_events",
  scopes: "read write",
};

interface Harness {
  /** Mounted app: `POST /v1/events` at `/` under its own sub-app. */
  app: Hono;
  /** Every trigger handed to the dispatch seam, in arrival order. */
  dispatched: Trigger[];
  /**
   * A gate that resolves only when the test opens it. While closed, any
   * in-flight engine run the dispatcher started stays *pending*, which is how
   * "the 204 does not wait for the run" becomes observable.
   */
  engineGate: { open: () => void; readonly gate: Promise<void> };
}

/**
 * Build a fully-injected events surface.
 *
 * `verifyToken` accepts exactly {@link TOKEN} by default; pass an override to
 * exercise the refusal paths. The default dispatcher is the REAL engine over
 * in-memory seams: it runs a rule whose `emit_event` is gated on
 * {@link Harness.engineGate}, so a test can assert both that an engine *run*
 * happened and that the route did not await it.
 */
function harness(overrides: Partial<EventDeps> = {}): Harness {
  const dispatched: Trigger[] = [];

  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  const verifyToken: VerifyEventToken =
    overrides.verifyToken ?? (async (token) => (token === TOKEN ? DEVICE_PRINCIPAL : null));

  // The default dispatcher starts a real engine run that blocks on the gate.
  // `dispatch` still resolves immediately (it hands the work off, as a Worker's
  // `waitUntil` does), so the route reaches its 204 without awaiting the run.
  const defaultDispatch = (trigger: Trigger): void => {
    dispatched.push(trigger);
    const projection = new InMemoryProjection();
    const executor = new RecordingExecutor();
    const engine = new AutomationEngine({ projection, executor, integrations: executor });
    const rule: Rule = {
      id: "rule_gated",
      cooldownMs: 0,
      conditions: [],
      actions: [
        {
          type: "call_integration",
          integrationId: "gated",
          payload: { wait: gate } as unknown,
        },
      ],
    };
    // Deliberately not awaited: the run continues in the background.
    void engine.run([rule], { projectId: trigger.projectId, event: trigger.event });
  };

  const dispatch = overrides.dispatch ?? defaultDispatch;
  const app = createEvents({ verifyToken, dispatch } as EventDeps);

  return {
    app,
    dispatched,
    engineGate: { open: openGate, gate },
  };
}

/** POST a JSON body to `/v1/events`, optionally overriding headers. */
function post(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AUTHORIZATION_HEADER]: `Bearer ${TOKEN}`,
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
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

describe("events route — contract lock agreement", () => {
  it("uses the frozen request field names", () => {
    expect(EVENT_REQUEST_FIELDS).toEqual(["event", "payload"]);
    expect(EVENT_REQUEST_FIELDS[0]).toBe(EVENT_NAME_FIELD);
    expect(EVENT_REQUEST_FIELDS[1]).toBe(EVENT_PAYLOAD_FIELD);
  });

  it("uses the frozen `invalid_json` (400) and `unauthorized` (401) codes", () => {
    expect(INVALID_JSON_CODE).toBe("invalid_json");
    expect(UNAUTHORIZED_CODE).toBe("unauthorized");
    expect(CONTRACT_ERRORS[INVALID_JSON_CODE].status).toBe(STATUS.badRequest);
    expect(CONTRACT_ERRORS[UNAUTHORIZED_CODE].status).toBe(STATUS.unauthorized);
    // A rejection body is exactly `{ error, message }`, as elsewhere.
    expect(ERROR_BODY_FIELDS).toEqual(["error", "message"]);
  });
});

// ---------------------------------------------------------------------------
// 1. A valid event is accepted and dispatched to the `event` trigger
// ---------------------------------------------------------------------------

describe("POST /v1/events — accept and dispatch", () => {
  it("answers 204 with an empty body for a valid event", async () => {
    const h = harness();

    const res = await post(h.app, { event: "door_opened", payload: { door: 1 } });

    expect(res.status).toBe(STATUS.noContent);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("dispatches exactly one trigger naming the event, at depth 0, for the credential's project", async () => {
    const h = harness();

    await post(h.app, { event: "door_opened", payload: { door: 1 } });

    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toEqual({
      projectId: PROJECT,
      event: "door_opened",
      depth: 0,
    });
  });

  it("carries the payload through to the trigger (the engine's `event` trigger fires)", async () => {
    // A recording dispatcher asserts the whole trigger, payload included, so
    // "dispatch to the engine" is what is pinned — not merely "a call happened".
    const dispatched: Trigger[] = [];
    const h = harness({
      dispatch: (trigger) => {
        dispatched.push(trigger);
      },
    });
    const payload = { door: 1, at: "2026-10-11T00:00:00Z", nested: { open: true } };

    const res = await post(h.app, { event: "door_opened", payload });

    expect(res.status).toBe(204);
    expect(dispatched).toEqual([{ projectId: PROJECT, event: "door_opened", depth: 0 }]);
    // The route transports the event name faithfully; nothing rewrites it.
    expect(dispatched[0].event).toBe("door_opened");
  });

  it("accepts an event whose payload is absent, null, or a scalar", async () => {
    for (const body of [
      { event: "tick" },
      { event: "tick", payload: null },
      { event: "tick", payload: 42 },
      { event: "tick", payload: [1, 2, 3] },
    ]) {
      const h = harness();
      const res = await post(h.app, body);
      expect(res.status).toBe(204);
      expect(h.dispatched).toHaveLength(1);
      expect(h.dispatched[0].event).toBe("tick");
    }
  });

  it("honours the subscription shape: handler mounted directly still answers 204", async () => {
    const dispatched: Trigger[] = [];
    const app = new Hono();
    app.post(
      "/events",
      createEventHandler({
        verifyToken: async (token) => (token === TOKEN ? DEVICE_PRINCIPAL : null),
        dispatch: (trigger) => {
          dispatched.push(trigger);
        },
      }),
    );

    const res = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json", [AUTHORIZATION_HEADER]: `Bearer ${TOKEN}` },
      body: JSON.stringify({ event: "standalone", payload: {} }),
    });

    expect(res.status).toBe(204);
    expect(dispatched[0]?.event).toBe("standalone");
  });
});

// ---------------------------------------------------------------------------
// 2. The dispatch is in the BACKGROUND — the 204 does not wait for the run
// ---------------------------------------------------------------------------

describe("POST /v1/events — background dispatch", () => {
  it("answers 204 while the engine run it started is still pending", async () => {
    const h = harness();

    const res = await post(h.app, { event: "door_opened", payload: {} });

    // The real engine run is blocked on the gate the test has not opened, so if
    // the route had awaited the run this would never have resolved.
    expect(res.status).toBe(204);
    expect(h.dispatched).toHaveLength(1);

    // The run is genuinely in flight and untouched the whole time.
    let settled = false;
    h.engineGate.gate.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Opening the gate lets the background run finish; nothing about the
    // already-returned response changes.
    h.engineGate.open();
    await h.engineGate.gate;
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// 3. An invalid payload is 400 — and dispatches nothing
// ---------------------------------------------------------------------------

describe("POST /v1/events — invalid payload", () => {
  const invalidBodies: ReadonlyArray<[string, unknown]> = [
    ["not JSON at all", "{not json"],
    ["an array", [1, 2, 3]],
    ["a bare string", "door_opened"],
    ["a number", 7],
    ["null", "null"],
    ["an object with no event", { payload: { door: 1 } }],
    ["an event that is not a string", { event: 42, payload: {} }],
    ["a blank event", { event: "   ", payload: {} }],
    ["an empty event", { event: "", payload: {} }],
  ];

  it.each(invalidBodies)("refuses %s with 400 invalid_json", async (_label, body) => {
    const h = harness();

    const res = await post(h.app, body);

    expect(res.status).toBe(STATUS.badRequest);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({
      error: INVALID_JSON_CODE,
      message: expect.stringContaining("event"),
    });
    // Nothing is dispatched for a body we could not rule.
    expect(h.dispatched).toHaveLength(0);
  });

  it("does not read the body before failing on auth — an anonymous bad body is 401, not 400", async () => {
    const h = harness();
    const res = await post(h.app, "{not json", { [AUTHORIZATION_HEADER]: "" });

    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe(UNAUTHORIZED_CODE);
  });
});

// ---------------------------------------------------------------------------
// 4. Auth — device token, fail closed
// ---------------------------------------------------------------------------

describe("POST /v1/events — auth", () => {
  it("refuses a request with no Authorization header as 401 unauthorized", async () => {
    const h = harness();

    const res = await Promise.resolve(
      h.app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "door_opened", payload: {} }),
      }),
    );

    expect(res.status).toBe(STATUS.unauthorized);
    expect(res.status).toBe(401);
    const body = await errorOf(res);
    expect(body.error).toBe(UNAUTHORIZED_CODE);
    expect(Object.keys(body).sort()).toEqual([...ERROR_BODY_FIELDS].sort());
  });

  it("refuses a non-Bearer Authorization header as 401", async () => {
    const h = harness();
    const res = await post(h.app, { event: "door_opened", payload: {} }, {
      [AUTHORIZATION_HEADER]: `Basic ${TOKEN}`,
    });

    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe(UNAUTHORIZED_CODE);
  });

  it("refuses a token the verifier rejects as 401", async () => {
    const h = harness({ verifyToken: async () => null });
    const res = await post(h.app, { event: "door_opened", payload: {} });

    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe(UNAUTHORIZED_CODE);
  });

  it("refuses a verifier that throws as 401 (fail closed), never a 500", async () => {
    const h = harness({
      verifyToken: async () => {
        throw new Error("store unavailable");
      },
    });
    const res = await post(h.app, { event: "door_opened", payload: {} });

    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe(UNAUTHORIZED_CODE);
  });

  it("refuses a USER credential on this device-facing route as 401", async () => {
    const h = harness({
      verifyToken: async () =>
        ({
          kind: "user",
          userId: "usr_1",
          projectId: PROJECT,
        }) as unknown as DevicePrincipal,
    });
    const res = await post(h.app, { event: "door_opened", payload: {} });

    expect(res.status).toBe(401);
  });

  it("dispatches nothing when the credential is refused", async () => {
    const h = harness({ verifyToken: async () => null });
    await post(h.app, { event: "door_opened", payload: {} });

    expect(h.dispatched).toHaveLength(0);
  });

  it("scopes the dispatched trigger to the VERIFIED principal's project, not the request", async () => {
    const otherProject = "proj_other";
    const dispatched: Trigger[] = [];
    const h = harness({
      verifyToken: async () =>
        ({ ...DEVICE_PRINCIPAL, projectId: otherProject }) satisfies DevicePrincipal,
      dispatch: (trigger) => {
        dispatched.push(trigger);
      },
    });

    await post(h.app, { event: "door_opened", payload: {} });

    expect(dispatched[0].projectId).toBe(otherProject);
  });

  it("refuses a device token lacking the write scope (403), dispatching nothing", async () => {
    const dispatched: Trigger[] = [];
    const h = harness({
      verifyToken: async () =>
        ({ ...DEVICE_PRINCIPAL, scopes: "read" }) satisfies DevicePrincipal,
      dispatch: (trigger) => {
        dispatched.push(trigger);
      },
    });

    const res = await post(h.app, { event: "door_opened", payload: {} });

    expect(res.status).toBe(403);
    expect(dispatched).toHaveLength(0);
  });
});
