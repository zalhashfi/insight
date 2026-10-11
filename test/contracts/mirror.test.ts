/**
 * MIRROR-DRIFT GUARD — the two-sided half of the contract freeze.
 *
 * `contract-lock.ts` is the single source of truth for the device-facing wire
 * shape, but the SDK cannot import TypeScript. It mirrors the lock by hand in
 * `insight-sdk/test/test_contract/test_main.cpp` (namespace `contract`). Nothing
 * stopped the two copies from drifting — each side's own suite only checks
 * itself — so a field/status/header could change on ONE side and both runs
 * stayed green. History did exactly that: the SDK emitted
 * `kHeaderAuthorization = "Authorization"` while the lock says
 * `authorization`, and no test noticed.
 *
 * This suite closes the loop. It reads the SDK's C++ constants TEXTUALLY and
 * asserts them equal to the lock's values, so ANY one-sided edit — to either
 * repo — fails *here*, in the `insight` contract suite.
 *
 * Why textual, not a shared generated artifact: the SDK must build inside
 * PlatformIO with only its own tree, and `insight-sdk` may be committed on its
 * own (its CI cannot see `../insight`). A generated file checked into both
 * repos would itself need a "is it stale?" test on the SDK side, which cannot
 * read the lock either. Parsing the SDK's own constants needs no cross-repo
 * build step and no codegen, and it is what the SDK parses at compile time.
 *
 * Scope: this guard covers the C++ constants the SDK `contract` namespace
 * declares — headers, statuses, error codes. The telemetry/control/OTA body
 * field names are locked against the SDK's byte-exact JSON fixtures (the
 * `kErrorBody` / `kControl*` / `kOta*` strings parsed in the last describe),
 * so a field rename on either side fails too.
 */

import { describe, expect, it } from "vitest";
import {
  CONTRACT_ERRORS,
  CONTRACT_HEADERS,
  METRIC_FIELDS,
  STATUS,
  TELEMETRY_REQUEST_SHAPES,
} from "./contract-lock";
import {
  OTA_IMAGE,
  OTA_LOCK_STRINGS,
  OTA_OFFER,
  OTA_ROUTES,
  OTA_SHA256_HEX_LENGTH,
  OTA_UPDATE_FIELDS,
} from "./ota-lock";
import { dirOf, filePathFromUrl, joinPath, readTextFileSync } from "./node-boundary";

/** The shape of a Node system error thrown by a failed file read. */
interface SysError {
  code?: string;
}

// ---------------------------------------------------------------------------
// Locate the SDK mirror. It lives in a sibling repo; the contract is only
// frozen when BOTH repos are present (and the acceptance command runs from a
// checkout that has them).
// ---------------------------------------------------------------------------

const HERE = dirOf(filePathFromUrl(import.meta.url));
const SDK_TEST_MAIN = joinPath(HERE, "../../../insight-sdk/test/test_contract/test_main.cpp");

const MIRROR = ((): string => {
  try {
    return readTextFileSync(SDK_TEST_MAIN, "utf8");
  } catch (err) {
    if ((err as SysError).code === "ENOENT") {
      throw new Error(
        `contract mirror not found at ${SDK_TEST_MAIN}. The freeze spans two ` +
          `repos: run this suite from a checkout whose parent also contains ` +
          `the 'insight-sdk' repo (cwd insight/ plus sibling insight-sdk/).`,
      );
    }
    throw err;
  }
})();

// ---------------------------------------------------------------------------
// C++ constant extractors — anchored to the SDK's `contract` namespace.
// ---------------------------------------------------------------------------

/** The string value of `const char* const <name> = "<value>";`. */
function cppStringConstant(source: string, name: string): string {
  const re = new RegExp(
    `const\\s+char\\s*\\*\\s*const\\s+${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`,
  );
  const m = re.exec(source);
  if (!m) throw new Error(`SDK mirror is missing C++ constant '${name}'`);
  // C++ escapes used by the mirror: \" and \\. Unescape both so the JSON
  // fixtures compare against real characters.
  return m[1].replace(/\\(["\\])/g, "$1");
}

/** The value of `const int <name> = <int>;`. */
function cppIntConstant(source: string, name: string): number {
  const re = new RegExp(`const\\s+int\\s+${name}\\s*=\\s*(-?\\d+)\\s*;`);
  const m = re.exec(source);
  if (!m) throw new Error(`SDK mirror is missing C++ int constant '${name}'`);
  return Number(m[1]);
}

interface CppError {
  code: string;
  status: number;
  implemented: boolean;
}

/** Parse the `kErrors[]` initializer list. */
function cppErrorEntries(source: string): CppError[] {
  const start = source.indexOf("const ErrorEntry kErrors[] = {");
  if (start < 0) throw new Error("SDK mirror is missing the kErrors[] table");
  const open = source.indexOf("{", start);
  const close = source.indexOf("};", open);
  if (open < 0 || close < 0) throw new Error("could not bracket the kErrors[] table");

  const entries: CppError[] = [];
  const re = /\{\s*"([^"]+)"\s*,\s*([A-Za-z0-9_]+)\s*,\s*(true|false)\s*\}/g;
  const body = source.slice(open, close);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    entries.push({ code: m[1], status: cppIntConstant(source, m[2]), implemented: m[3] === "true" });
  }
  return entries;
}

// The lock's statuses have singular spec names; the SDK uses the same names
// with a `kStatus` prefix and initial capital (ok -> kStatusOk).
const STATUS_CONST_BY_LOCK_KEY: Record<string, string> = {
  ok: "kStatusOk",
  noContent: "kStatusNoContent",
  badRequest: "kStatusBadRequest",
  unauthorized: "kStatusUnauthorized",
  notFound: "kStatusNotFound",
  payloadTooLarge: "kStatusPayloadTooLarge",
  tooManyRequests: "kStatusTooManyRequests",
};

// ---------------------------------------------------------------------------
// Header names — the real drift this guard was written for.
// ---------------------------------------------------------------------------

describe("mirror: header names agree with contract-lock.ts", () => {
  it("authorization header is byte-identical (lock is lowercase)", () => {
    // Regression: the SDK shipped "Authorization" while the lock says
    // "authorization". Asserting against the literal as well as the lock makes
    // the historic drift a named failure instead of a generic mismatch.
    expect(CONTRACT_HEADERS.authorization).toBe("authorization");
    expect(cppStringConstant(MIRROR, "kHeaderAuthorization")).toBe(CONTRACT_HEADERS.authorization);
  });

  it("device header is byte-identical", () => {
    expect(cppStringConstant(MIRROR, "kHeaderDevice")).toBe(CONTRACT_HEADERS.device);
  });

  it("firmware header is byte-identical", () => {
    expect(cppStringConstant(MIRROR, "kHeaderFirmware")).toBe(CONTRACT_HEADERS.firmware);
  });
});

// ---------------------------------------------------------------------------
// Status codes
// ---------------------------------------------------------------------------

describe("mirror: status codes agree with contract-lock.ts", () => {
  it("every frozen status has a matching SDK constant", () => {
    for (const [lockKey, cppName] of Object.entries(STATUS_CONST_BY_LOCK_KEY)) {
      const expected = STATUS[lockKey as keyof typeof STATUS];
      expect(cppIntConstant(MIRROR, cppName), `${cppName} vs STATUS.${lockKey}`).toBe(expected);
    }
  });

  it("no extra or missing statuses", () => {
    // The lock must not silently gain a status the SDK cannot express.
    expect(new Set(Object.keys(STATUS_CONST_BY_LOCK_KEY))).toEqual(new Set(Object.keys(STATUS)));
  });
});

// ---------------------------------------------------------------------------
// Error codes — code, mapped status, and implemented-flag must all agree.
// ---------------------------------------------------------------------------

describe("mirror: error codes agree with contract-lock.ts", () => {
  const entries = cppErrorEntries(MIRROR);

  it("the kErrorCount guard matches the parsed table", () => {
    expect(cppIntConstant(MIRROR, "kErrorCount")).toBe(entries.length);
  });

  it("the lock and the SDK list the same codes in the same order", () => {
    expect(entries.map((e) => e.code)).toEqual(Object.keys(CONTRACT_ERRORS));
  });

  it("each code maps to the lock's status and implemented flag", () => {
    for (const entry of entries) {
      const spec = CONTRACT_ERRORS[entry.code as keyof typeof CONTRACT_ERRORS];
      expect(spec, `lock has no error code '${entry.code}'`).toBeDefined();
      expect(entry.status, `${entry.code} status`).toBe(spec.status);
      expect(entry.implemented, `${entry.code} implemented`).toBe(spec.implemented);
    }
  });
});

// ---------------------------------------------------------------------------
// Body field names — covered via the SDK's own byte-exact JSON fixtures, which
// are what the SDK parses at runtime. Renaming a field in the lock (or in a
// fixture) makes these disagree.
// ---------------------------------------------------------------------------

describe("mirror: body field names agree with contract-lock.ts", () => {
  it("rejection bodies carry exactly {error, message}", () => {
    const body = JSON.parse(cppStringConstant(MIRROR, "kErrorBody")) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error", "message"]);
  });

  it("control envelope is {control: [{id, variable, value}]}", () => {
    const command = JSON.parse(cppStringConstant(MIRROR, "kControlCommand")) as {
      control: Record<string, unknown>[];
    };
    expect(Object.keys(command)).toEqual(["control"]);
    expect(command.control).toHaveLength(1);
    expect(Object.keys(command.control[0]).sort()).toEqual(["id", "value", "variable"]);
  });

  it("OTA up-to-date envelope is {update: null}", () => {
    const noUpdate = JSON.parse(cppStringConstant(MIRROR, "kOtaNoUpdate")) as Record<string, unknown>;
    expect(Object.keys(noUpdate)).toEqual(["update"]);
    expect(noUpdate.update).toBeNull();
  });

  it("OTA update envelope nests exactly the four frozen fields under `update`", () => {
    const update = JSON.parse(cppStringConstant(MIRROR, "kOtaUpdate")) as {
      update: Record<string, unknown>;
    };
    expect(Object.keys(update)).toEqual(["update"]);
    expect(Object.keys(update.update).sort()).toEqual(["sha256", "size", "url", "version"]);
  });

  it("the canonical telemetry shape uses the lock's `metrics` + per-entry fields", () => {
    // The lock names the top-level request shape and the per-entry fields; the
    // SDK's canonical fixture must use exactly those names.
    expect(Object.keys(TELEMETRY_REQUEST_SHAPES)).toContain("metricsArray");
    const canonical = JSON.parse(cppStringConstant(MIRROR, "kShapeMetricsArray")) as {
      metrics: Record<string, unknown>[];
    };
    expect(Object.keys(canonical)).toEqual(["metrics"]);
    expect(Object.keys(canonical.metrics[0]).sort()).toEqual([...METRIC_FIELDS].sort());
  });

  it("the metricValue shorthand uses the reserved `metric` + `value` keys", () => {
    const shorthand = JSON.parse(cppStringConstant(MIRROR, "kShapeMetricValue")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(shorthand).sort()).toEqual(["metric", "value"]);
    // `metric` is the reserved shorthand key, distinct from the per-entry
    // METRIC_FIELDS names (`key`/`value`) — the lock records both.
    expect(METRIC_FIELDS).toEqual(["key", "value"]);
  });
});

// ---------------------------------------------------------------------------
// OTA routes — the shape frozen in `ota-lock.ts` (spec §6.4/§6.5). The routes
// are not server-side yet, but the SDK mirror still declares the paths, the
// firmware request header, the media type and the retry-after header, so a
// one-sided edit here — either side — is caught. This is what keeps the OTA
// shape honest while both halves are shape-only.
// ---------------------------------------------------------------------------

interface CppOtaRoute {
  method: string;
  path: string;
  contentType: string;
  implemented: boolean;
}

/** Parse the `kOtaRoutes[]` initializer list from the SDK mirror. */
function cppOtaRoutes(source: string): CppOtaRoute[] {
  const start = source.indexOf("const OtaRoute kOtaRoutes[] = {");
  if (start < 0) throw new Error("SDK mirror is missing the kOtaRoutes[] table");
  const open = source.indexOf("{", start);
  const close = source.indexOf("};", open);
  if (open < 0 || close < 0) throw new Error("could not bracket the kOtaRoutes[] table");

  const routes: CppOtaRoute[] = [];
  const re = /\{\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*(true|false)\s*\}/g;
  const body = source.slice(open, close);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    routes.push({
      method: m[1],
      path: m[2],
      contentType: m[3],
      implemented: m[4] === "true",
    });
  }
  return routes;
}

describe("mirror: OTA route shape agrees with ota-lock.ts", () => {
  const routes = cppOtaRoutes(MIRROR);

  it("the kOtaRouteCount guard matches the parsed table", () => {
    expect(cppIntConstant(MIRROR, "kOtaRouteCount")).toBe(routes.length);
  });

  it("freezes the same two paths (offer + image)", () => {
    expect(routes.map((r) => r.path)).toEqual([OTA_OFFER.path, OTA_IMAGE.path]);
    expect(routes.map((r) => r.method)).toEqual([OTA_OFFER.method, OTA_IMAGE.method]);
  });

  it("freezes the path family as distinct /v1/ota + /v1/ota/image", () => {
    expect(cppStringConstant(MIRROR, "kOtaOfferPath")).toBe(OTA_LOCK_STRINGS.offerPath);
    expect(cppStringConstant(MIRROR, "kOtaImagePath")).toBe(OTA_LOCK_STRINGS.imagePath);
    expect(OTA_IMAGE.path.startsWith(OTA_OFFER.path + "/")).toBe(true);
  });

  it("sends the running firmware version in the offer's request header", () => {
    expect(cppStringConstant(MIRROR, "kOtaFirmwareHeader")).toBe(OTA_OFFER.requestHeader);
    expect(cppStringConstant(MIRROR, "kOtaFirmwareHeader")).toBe(CONTRACT_HEADERS.firmware);
    // The device ingress under test also carries it — same frozen bytes.
    expect(cppStringConstant(MIRROR, "kHeaderFirmware")).toBe(CONTRACT_HEADERS.firmware);
  });

  it("serves the image as application/octet-stream", () => {
    expect(cppStringConstant(MIRROR, "kOtaImageContentType")).toBe(OTA_IMAGE.contentType);
    // The image route (index 1) carries the media type; the offer carries none.
    expect(routes[1].contentType).toBe(OTA_IMAGE.contentType);
    expect(routes[0].contentType).toBe("");
  });

  it("freezes retry-after as the 429 header", () => {
    expect(cppStringConstant(MIRROR, "kOtaRetryAfterHeader")).toBe(OTA_IMAGE.rateLimited.header);
    expect(OTA_IMAGE.rateLimited.header).toBe("retry-after");
  });

  it("both routes are marked implemented on both sides (M3)", () => {
    expect(routes.map((r) => r.implemented)).toEqual([true, true]);
    expect(OTA_OFFER.implemented).toBe(true);
    expect(OTA_IMAGE.implemented).toBe(true);
  });

  it("the image route's 429/404 statuses agree with the frozen lock", () => {
    expect(OTA_IMAGE.rateLimited.status).toBe(STATUS.tooManyRequests);
    expect(OTA_IMAGE.notFound.status).toBe(STATUS.notFound);
    // The SDK encodes the same ints for these (see test_main.cpp).
    expect(cppIntConstant(MIRROR, "kStatusTooManyRequests")).toBe(STATUS.tooManyRequests);
    expect(cppIntConstant(MIRROR, "kStatusNotFound")).toBe(STATUS.notFound);
  });

  it("the OTA update fields mirror the lock's `update` object fields", () => {
    const update = JSON.parse(cppStringConstant(MIRROR, "kOtaUpdate")) as {
      update: Record<string, unknown>;
    };
    expect(new Set(Object.keys(update.update))).toEqual(new Set(OTA_UPDATE_FIELDS));
    expect(OTA_SHA256_HEX_LENGTH).toBe(64);
  });

  it("the aggregate covers both routes", () => {
    expect(Object.keys(OTA_ROUTES).sort()).toEqual(["image", "offer"]);
    expect(cppIntConstant(MIRROR, "kOtaRouteCount")).toBe(Object.keys(OTA_ROUTES).length);
  });
});
