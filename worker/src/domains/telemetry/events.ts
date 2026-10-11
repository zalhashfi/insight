/**
 * Discrete device events — `POST /v1/events` (spec §6.6, FR-TEL-10).
 *
 * A device (or anything holding a project token) reports that *something
 * happened*: `{ "event": "…", "payload": { … } }`. Unlike telemetry — a stream
 * of {@link ../../shared/validation!ValidTelemetry} samples that lands in a
 * series — a discrete event is a **trigger**: it is what wakes the automation
 * engine's `event` trigger (FR-AUT-02) and lets a stored rule react (set a
 * variable, call an integration, emit a child event).
 *
 * The wire contract is deliberately tiny (spec §6.6):
 *
 *   | aspect    | value                                                     |
 *   |-----------|-----------------------------------------------------------|
 *   | request   | `{"event":"…","payload":{…}}`                              |
 *   | success   | `204 No Content` — empty body, dispatch is in the background |
 *   | auth      | device (project) token, `Authorization: Bearer …`         |
 *   | errors    | `400 {error:"invalid_json"}` · `401 {error:"unauthorized"}`|
 *
 * ## The response never waits on the engine
 *
 * The whole point of a background dispatch is that the *device* is not coupled
 * to how many automations its event wakes, nor to how long they take. So the
 * handler validates, hands the dispatch to the injected {@link EventDispatcher}
 * seam **without awaiting the engine run**, and answers `204` at once. §6.6 says
 * exactly this: "→ 204; dispatch background".
 *
 * The seam is the honest way to express that. `waitUntil` is a *platform*
 * capability (a Cloudflare Worker's `ExecutionContext`), not a wire behaviour,
 * so this route does not reach for a binding: {@link EventDispatcher} may
 * resolve the instant the work is *accepted* (the production `waitUntil`
 * adapter), and the route still proceeds to `204` — it holds no promise to the
 * engine. A test injects a dispatcher that records the trigger and resolves at
 * leisure, which is how "204 without waiting" becomes observable.
 *
 * ## What the route owns, and what it does not
 *
 * It owns exactly three things: parse-and-rule the body, authenticate the
 * credential, and hand a {@link Trigger} to the seam. It owns **no** rule
 * storage, **no** engine and **no** clock — the candidate rules a trigger
 * selects are the engine's caller's business (the engine's own `run` takes the
 * rules it was given). `projectId` is threaded from the *verified* principal, so
 * an event can only ever trigger the tenant it was authorised for.
 *
 * The two rejections are the frozen device-contract codes (see
 * `test/contracts/contract-lock.ts`): a body that is not `{ event, payload }`
 * is `400 invalid_json`; a missing, non-Bearer or unverifiable token is
 * `401 unauthorized`. Everything that would be a `4xx` for telemetry — rate
 * limits, per-key validation — is **not** part of this route's contract; an
 * event's `payload` is opaque and is never inspected.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import {
  readBearerToken,
  requireScope,
  type DevicePrincipal,
} from "../../platform/middleware/resolve-project";
import type { Trigger } from "../../platform/engine/run";

// ---------------------------------------------------------------------------
// Frozen wire field names (mirror `test/contracts/contract-lock.ts`)
// ---------------------------------------------------------------------------

/**
 * The two request fields of `POST /v1/events`, in order.
 *
 * Frozen here as the route's single source of truth and asserted against the
 * shared lock in the spec test, so a rename cannot silently drift between the
 * published SDK shape and the server.
 */
export const EVENT_REQUEST_FIELDS = ["event", "payload"] as const;

/** The name field: the `event` a rule's `event` trigger matches on. */
export const EVENT_NAME_FIELD = "event" as const;

/** The opaque data field carried alongside the event name. */
export const EVENT_PAYLOAD_FIELD = "payload" as const;

/** Header carrying the credential, mirroring every other device route. */
export const AUTHORIZATION_HEADER = "authorization";

/** Frozen `400` code for a body that is not `{ event: string, payload: … }`. */
export const INVALID_JSON_CODE = "invalid_json" as const;

/** Frozen `401` code for a missing/invalid/unusable credential. */
export const UNAUTHORIZED_CODE = "unauthorized" as const;

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The one thing this route needs from the platform: a way to hand an event to
 * the automation engine **in the background**.
 *
 * The seam takes the already-authenticated {@link Trigger} and returns once the
 * dispatch has been *accepted* — it is deliberately not `Promise<RunReport>`.
 * Whether the engine actually runs before or after the `204` is the adapter's
 * concern (`waitUntil` in production; a recorded invocation in tests), and the
 * route never observes it, which is what keeps the response off the engine's
 * critical path.
 *
 * An implementation that *throws* is treated as "the dispatch could not be
 * started" and the route fails loudly rather than answering `204` for work it
 * silently dropped; an implementation that resolves is the honest "accepted"
 * acknowledgement the `204` promises.
 */
export type EventDispatcher = (trigger: Trigger) => Promise<void> | void;

/**
 * Verifies a presented device token and resolves it to a
 * {@link DevicePrincipal}.
 *
 * Production wraps the D1-backed project-token verifier; tests pass a stub.
 * Returning `null`, a **user** principal, or anything that throws means "not a
 * usable device credential" — the route answers the same `401` for all three,
 * so a caller cannot probe *why* a token failed.
 */
export type VerifyEventToken = (
  token: string,
  c: Context,
) => Promise<DevicePrincipal | null>;

/** Everything the events route needs, injectable end-to-end for tests. */
export interface EventDeps {
  /** Verify the presented bearer token → a device principal, or `null`. */
  readonly verifyToken: VerifyEventToken;
  /** Hand the trigger to the automation engine in the background. */
  readonly dispatch: EventDispatcher;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * The `POST /v1/events` request, after parsing.
 *
 * `payload` is `unknown` **by design**: an event's data is opaque to this
 * route. It is passed through verbatim to the engine, which is the only layer
 * that could care what an automation does with it.
 */
export interface EventRequestBody {
  readonly event: string;
  readonly payload: unknown;
}

/** The `{ error, message }` body every rejection carries. */
export interface EventErrorBody {
  readonly error: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse and rule the request body.
 *
 * Returns the event name and its payload, or `null` when the body is not a JSON
 * object carrying a non-blank string `event`. The `payload` is *required to be
 * present* but its value is unconstrained — `null`, a number, a nested object
 * and an absent key are all accepted, because an event with no data is a
 * perfectly ordinary event ("the door opened") and the field is opaque besides.
 *
 * A body that fails to parse at all and a body of the wrong shape are
 * deliberately indistinguishable: both are {@link INVALID_JSON_CODE}, so a
 * caller learns "this was not an event" and nothing more.
 */
async function readEvent(c: Context): Promise<EventRequestBody | null> {
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

  const record = parsed as Record<string, unknown>;
  const event = record[EVENT_NAME_FIELD];
  if (typeof event !== "string" || event.trim() === "") return null;

  // `payload` is opaque; it is carried through exactly as received, with an
  // absent key normalised to `null` so a downstream consumer never has to
  // distinguish "no payload" from "explicit null".
  const payload = EVENT_PAYLOAD_FIELD in record ? record[EVENT_PAYLOAD_FIELD] : null;
  return { event, payload };
}

/**
 * Authenticate a device request, or return the `401` to answer it with.
 *
 * The credential is parsed by the SHARED strict Bearer grammar
 * ({@link readBearerToken}) — a bare or scheme-less header is not a credential
 * at all — then verified through the injected seam. A verifier that *throws* or
 * that resolves to a **user** principal is a refusal, not a `500`: this route is
 * device-facing, so it fails closed on anything but a device credential.
 *
 * The resolved principal's `projectId` scopes every dispatch, so one project's
 * token can never fire another project's automations.
 */
async function authorise(c: Context, deps: EventDeps): Promise<DevicePrincipal | null> {
  const token = readBearerToken(c);
  if (token === null) return null;

  let principal: DevicePrincipal | null;
  try {
    principal = await deps.verifyToken(token, c);
  } catch {
    principal = null;
  }
  if (principal === null || principal.kind !== "device") return null;

  return principal;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** The handler shape, named so consumers can hold a reference. */
export type EventHandler = (c: Context) => Promise<Response>;

/**
 * Build the `POST /v1/events` handler.
 *
 * Order is deliberate and is the order the contract is observable in: **auth
 * first** (an anonymous caller never has its body read or measured), then the
 * body rule, then the background dispatch. The dispatch is deliberately *not*
 * awaited — the handler calls {@link EventDeps.dispatch} and proceeds — but it
 * does await the *acceptance* the seam returns, so a dispatcher that refuses to
 * start is never disguised as a `204`. In production that acceptance is
 * instantaneous (`waitUntil` hands the work off), so the device sees a `204` at
 * the edge while the engine runs behind it.
 */
export function createEventHandler(deps: EventDeps): EventHandler {
  return async function eventsHandler(c: Context): Promise<Response> {
    // 1. AUTH — before the body is touched, so an unauthenticated payload is
    //    never parsed. A missing/unknown/non-device credential is the frozen 401.
    const principal = await authorise(c, deps);
    if (principal === null) {
      const body: EventErrorBody = {
        error: UNAUTHORIZED_CODE,
        message: "a valid project token is required",
      };
      return c.json(body, 401);
    }

    // 1b. AUTHORIZATION — events are a WRITE surface (they fire automations), so
    //     the shared scope gate is applied exactly as elsewhere: a device token
    //     without `write` is refused. `requireScope` reads `principal` off the
    //     context, so expose the *verified* one first.
    c.set("principal", principal);
    const refused = requireScope(c, "write");
    if (refused !== null) return refused;

    // 2. BODY — a non-`{ event, payload }` body is a 400, and nothing is
    //    dispatched for it.
    const body = await readEvent(c);
    if (body === null) {
      const error: EventErrorBody = {
        error: INVALID_JSON_CODE,
        message: `the body must be { ${EVENT_REQUEST_FIELDS.join(", ")} }`,
      };
      return c.json(error, 400);
    }

    // 3. DISPATCH — background, against the credential's OWN project. The
    //    `event` name is what a rule's `event` trigger matches; `depth: 0` marks
    //    a root run, so the engine's depth cap measures the cascade from here.
    await deps.dispatch({
      projectId: principal.projectId,
      event: body.event,
      depth: 0,
    });

    // 4. 204 — accepted. Empty body, per §6.6 and the frozen contract.
    return c.body(null, 204);
  };
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

/**
 * Build a ready-to-mount Hono app exposing the events route.
 *
 * Mount with `app.route("/v1/events", createEvents(deps))`; the handler sits at
 * `/`.
 */
export function createEvents(deps: EventDeps): Hono {
  const app = new Hono();
  app.post("/", createEventHandler(deps));
  return app;
}

export default createEvents;
