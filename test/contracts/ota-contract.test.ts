/**
 * OTA CONTRACT SUITE — freezes the shape of `GET /v1/ota` + `GET /v1/ota/image`
 * (spec §6.4/§6.5) against `./ota-lock.ts`.
 *
 * E03's whole point: the OTA shape must be pinned on BOTH sides of the wire, so
 * neither the server nor the SDK can drift unobserved. This suite owns the
 * `insight` (server) half:
 *
 *   * SELF-CONSISTENCY — the lock's constants agree with each other and with
 *     the parent lock (`contract-lock.ts`), which `contract.test.ts` already
 *     proves matches the live server. Editing an OTA value here therefore
 *     detaches it from the server and fails below.
 *   * SHAPE — the frozen bodies are exactly `{update:null}` and
 *     `{update:{version,size,sha256,url}}`; the image body is
 *     `application/octet-stream`; a 429 carries `retry-after`; a missing image
 *     is `404`; the offer request header is `x-insight-firmware`.
 *   * ABSENCE — neither OTA route is wired server-side yet (tickets A18b /
 *     A18c), so the REAL composed app (`createApp(fakeDeps)`) 404s the path
 *     while its sibling routes still answer. This asserts the routes do NOT
 *     exist; it never fabricates one to satisfy a shape, and it never uses a
 *     bare `new Hono()` (which 404s everything and would prove nothing).
 *
 * The cross-repo half lives in `mirror.test.ts`, which asserts these same
 * values against the SDK's C++ mirror.
 */

import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../../worker/src/app";
import {
  CONTRACT_HEADERS,
  GET_OTA,
  OTA_RESPONSE_FIELDS,
  OTA_UPDATE_FIELDS,
  STATUS,
} from "./contract-lock";
import {
  OTA_IMAGE,
  OTA_LOCK_STRINGS,
  OTA_OFFER,
  OTA_ROUTES,
  OTA_SHA256_HEX_LENGTH,
} from "./ota-lock";

// ---------------------------------------------------------------------------
// Concrete frozen bodies — built from the lock's field names so a rename in
// the lock makes these disagree, exactly as `contract.test.ts` does for the
// live routes. These are SHAPE fixtures (spec §6.4): the route is not live.
// ---------------------------------------------------------------------------

const [ENVELOPE, VERSION, SIZE, SHA256, URL] = [
  OTA_RESPONSE_FIELDS[0],
  ...OTA_UPDATE_FIELDS,
] as [string, string, string, string, string];

/** A representative `200 {update:null}` body. */
const NO_UPDATE_BODY: Record<string, unknown> = { [ENVELOPE]: OTA_OFFER.noUpdateValue };

/** A representative `200 {update:{version,size,sha256,url}}` body. */
const UPDATE_BODY: Record<string, unknown> = {
  [ENVELOPE]: {
    [VERSION]: "1.2.0",
    [SIZE]: 1024,
    [SHA256]: "e".repeat(OTA_SHA256_HEX_LENGTH),
    [URL]: "/v1/ota/image/1.2.0",
  },
};

// ---------------------------------------------------------------------------
// The REAL composed app — the absence probes run against production wiring.
// ---------------------------------------------------------------------------

/**
 * The composed production surface (`createApp`) with honest, in-memory seams.
 *
 * The absence probes below MUST drive this app, not a bare `new Hono()`: a bare
 * Hono has no routes at all, so it 404s every path and would "prove" the OTA
 * routes are absent even if `createApp` had wired them. `createApp` mounts the
 * real middleware and routers, so a genuine `/v1/ota` (or `/v1/ota/image`)
 * handler appearing in `worker/src/app.ts` makes these probes observe a
 * non-404 and FAIL — the tripwire is load-bearing.
 *
 * Every seam is a minimal in-memory stand-in; nothing here is the code under
 * test, and no OTA route is ever fabricated.
 */
function fakeDeps(): AppDeps {
  return {
    deviceTokens: async (token) =>
      token.startsWith("pt_") ? { kind: "device", projectId: "proj_contract", scopes: "read write" } : null,
    sessions: async () => null,
    ingest: {
      verifyToken: async (token) =>
        token.startsWith("pt_") ? { kind: "device", projectId: "proj_contract", scopes: "read write" } : null,
      sink: { record: async () => undefined },
      devices: { register: () => undefined, has: () => false },
      now: () => 1_700_000_000_000,
    },
    query: {
      credentials: async () => null,
      projects: { state: async () => [] },
      shards: { ring: async () => [] },
    },
  };
}

// ---------------------------------------------------------------------------
// Lock self-consistency
// ---------------------------------------------------------------------------

describe("ota-lock self-consistency", () => {
  it("reuses the parent lock's OTA constants without drift", () => {
    // The OTA lock must not hold its own copy of a value the parent lock owns.
    expect(OTA_OFFER.path).toBe(GET_OTA.path);
    expect(OTA_OFFER.method).toBe(GET_OTA.method);
    expect(OTA_OFFER.success).toBe(GET_OTA.success);
    expect(OTA_OFFER.envelopeField).toBe(OTA_RESPONSE_FIELDS[0]);
    expect(OTA_OFFER.updateFields).toBe(OTA_UPDATE_FIELDS);
    expect(OTA_OFFER.requestHeader).toBe(CONTRACT_HEADERS.firmware);
  });

  it("freezes the exact header names and paths", () => {
    expect(CONTRACT_HEADERS.firmware).toBe("x-insight-firmware");
    expect(OTA_OFFER.path).toBe("/v1/ota");
    expect(OTA_IMAGE.path).toBe("/v1/ota/image");
    expect(OTA_LOCK_STRINGS).toEqual({
      offerPath: "/v1/ota",
      imagePath: "/v1/ota/image",
      firmwareHeader: "x-insight-firmware",
      envelopeField: "update",
      contentType: "application/octet-stream",
      retryAfterHeader: "retry-after",
    });
  });

  it("freezes the status codes the OTA routes return", () => {
    expect(OTA_OFFER.success).toBe(200);
    expect(OTA_IMAGE.success).toBe(200);
    expect(OTA_IMAGE.rateLimited.status).toBe(429);
    expect(OTA_IMAGE.notFound.status).toBe(404);
    // And they are the parent lock's statuses, not bare literals.
    expect(OTA_IMAGE.rateLimited.status).toBe(STATUS.tooManyRequests);
    expect(OTA_IMAGE.notFound.status).toBe(STATUS.notFound);
  });

  it("marks both OTA routes as not implemented yet (M3 / A18b, A18c)", () => {
    expect(OTA_OFFER.implemented).toBe(false);
    expect(OTA_IMAGE.implemented).toBe(false);
    expect(GET_OTA.implemented).toBe(false);
  });

  it("exposes both routes through the aggregate", () => {
    expect(OTA_ROUTES.offer).toBe(OTA_OFFER);
    expect(OTA_ROUTES.image).toBe(OTA_IMAGE);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/ota — shape
// ---------------------------------------------------------------------------

describe("GET /v1/ota offer shape", () => {
  it("sends the running firmware version in x-insight-firmware", () => {
    expect(OTA_OFFER.requestHeader).toBe("x-insight-firmware");
    expect(GET_OTA.headers).toContain(CONTRACT_HEADERS.firmware);
  });

  it("up-to-date is exactly {update: null}", () => {
    const body = NO_UPDATE_BODY;
    expect(Object.keys(body)).toEqual([ENVELOPE]);
    expect(body[ENVELOPE]).toBeNull();
    expect(ENVELOPE).toBe("update");
    // And that is precisely what JSON serialises to, byte-for-byte.
    expect(JSON.stringify(body)).toBe('{"update":null}');
  });

  it("an available update nests exactly version/size/sha256/url under `update`", () => {
    const body = UPDATE_BODY;
    expect(Object.keys(body)).toEqual(["update"]);
    const update = body.update as Record<string, unknown>;
    expect(Object.keys(update)).toEqual(["version", "size", "sha256", "url"]);
    // `version` lives under `update`, never at the top level.
    expect(Object.keys(body)).not.toContain("version");
  });

  it("the sha256 field is a lowercase 64-hex digest", () => {
    expect(OTA_SHA256_HEX_LENGTH).toBe(64);
    const digest = (UPDATE_BODY.update as Record<string, unknown>)[SHA256] as string;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("frozen error set is authorization + quota only", () => {
    expect(OTA_OFFER.errors).toEqual([
      { code: "unauthorized", status: 401 },
      { code: "rate_limited", status: 429 },
    ]);
  });

  it("does NOT double as the image route (path family is distinct)", () => {
    // The image route is a child path, not the offer path: the offer's own
    // path must never be reachable at `/v1/ota/image`.
    expect(OTA_OFFER.path).not.toBe(OTA_IMAGE.path);
    expect(OTA_IMAGE.path.startsWith(OTA_OFFER.path + "/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/ota/image — shape
// ---------------------------------------------------------------------------

describe("GET /v1/ota/image shape", () => {
  it("serves the bytes as application/octet-stream", () => {
    expect(OTA_IMAGE.contentType).toBe("application/octet-stream");
    expect(OTA_IMAGE.success).toBe(STATUS.ok);
  });

  it("quota exhaustion is 429 with a retry-after header", () => {
    expect(OTA_IMAGE.rateLimited.status).toBe(429);
    expect(OTA_IMAGE.rateLimited.header).toBe("retry-after");
  });

  it("a missing image is 404", () => {
    expect(OTA_IMAGE.notFound.status).toBe(404);
  });

  it("carries the firmware header like the offer (shared /v1/ota family)", () => {
    expect(OTA_IMAGE.requestHeader).toBe(OTA_OFFER.requestHeader);
    expect(OTA_IMAGE.requestHeader).toBe(CONTRACT_HEADERS.firmware);
  });
});

// ---------------------------------------------------------------------------
// Not-yet-implemented routes — asserted ABSENT, never invented
// ---------------------------------------------------------------------------

describe("OTA routes are absent from the REAL composed app (M3 / A18b, A18c)", () => {
  // The composed app mounts `securityHeaders` on `*`, the ingest router and the
  // read router — everything production wires. A bare `new Hono()` would 404
  // these paths no matter what `createApp` mounts, so it could never catch the
  // OTA routes being wired: that is the vacuous 404 this suite must not use.
  const app = createApp(fakeDeps());

  it("GET /v1/ota is NOT wired into createApp", async () => {
    expect(OTA_OFFER.implemented).toBe(false);
    const res = await app.request(OTA_OFFER.path, {
      method: OTA_OFFER.method,
      headers: {
        [CONTRACT_HEADERS.authorization]: "Bearer pt_test",
        [OTA_OFFER.requestHeader]: "1.0.0",
      },
    });
    // Absent at the framework edge of the composed app — not at a route-less stub.
    expect(res.status).toBe(STATUS.notFound);
  });

  it("GET /v1/ota/image is NOT wired into createApp", async () => {
    expect(OTA_IMAGE.implemented).toBe(false);
    const res = await app.request(OTA_IMAGE.path, {
      method: OTA_IMAGE.method,
      headers: {
        [CONTRACT_HEADERS.authorization]: "Bearer pt_test",
        [OTA_IMAGE.requestHeader]: "1.0.0",
      },
    });
    expect(res.status).toBe(STATUS.notFound);
  });

  it("the /v1/ota family is genuinely unrouted (a control path resolves first)", async () => {
    // The 404s above are the framework edge, not a blanket "nothing answers":
    // a sibling `/v1` route the composed app DOES mount proves the app routes
    // requests at all, so the OTA 404s are about OTA being unwired, not about a
    // dead app. `/v1/version` is constant and needs no credential.
    const known = await app.request("/v1/version", { method: "GET" });
    expect(known.status).toBe(STATUS.ok);
    // And a path one segment under the offer path is likewise absent.
    const deeper = await app.request(`${OTA_OFFER.path}/anything`, { method: "GET" });
    expect(deeper.status).toBe(STATUS.notFound);
  });

  it("the frozen 429 and 404 are what the routes WILL return once wired", () => {
    // Encoded here as constants (not live responses) so the shape is frozen
    // even while the route is absent. A18c's acceptance names exactly these.
    expect(OTA_IMAGE.rateLimited.status).toBe(STATUS.tooManyRequests);
    expect(OTA_IMAGE.notFound.status).toBe(STATUS.notFound);
    // A 429 and a 404 are distinct, and neither is a success.
    expect(OTA_IMAGE.rateLimited.status).not.toBe(OTA_IMAGE.notFound.status);
    expect(OTA_IMAGE.rateLimited.status).not.toBe(OTA_IMAGE.success);
    expect(OTA_IMAGE.notFound.status).not.toBe(OTA_IMAGE.success);
  });
});
