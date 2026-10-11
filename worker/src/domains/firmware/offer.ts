/**
 * firmware/offer — the OTA check: `GET /v1/ota` (spec §6.4, A18b).
 *
 * This is the *offer* half of OTA and the third leg of the family
 * `firmware/upload.ts` (A18, the write) → this module (the check) →
 * `firmware/image.ts` (A18c, the read). A device asks "is there anything newer
 * for my project?", presenting the version it is **running** in
 * `x-insight-firmware`; the answer is either "you are current"
 * (`{update:null}`) or an offer naming one exact image to fetch
 * (`{update:{version,size,sha256,url}}`). Like every other domain module it is
 * a **pure service over injected seams** — it reaches for no binding, no
 * ambient clock and no `env` — so its rules are pinned by a unit test rather
 * than through `createApp`.
 *
 * ## Two seams, one question
 *
 *   1. {@link FirmwareRepo} — D1's `firmware` table (the SAME
 *      `(projectId, version)` row `upload.ts` writes). The offer reads it, so a
 *      device can never be offered a version that has no recorded image.
 *   2. {@link OfferTargets} — the two project-scoped targets the offer compares
 *      against: the version an operator has pinned (`assigned`) and the newest
 *      version known (`latest`). Scoped by `projectId`, never a global "current".
 *
 * There is deliberately no clock, no quota and no object-store read here: an
 * offer is a pure lookup plus a comparison, and the image bytes are A18c's job.
 *
 * ## The comparison rule (§6.4)
 *
 * `running` is the version the device reports; `target` is the version we would
 * like it to run. The rule is small and total:
 *
 *   * **no target** or **`running` equal to the target** → `{update:null}`. An
 *     up-to-date device, a device whose project pins nothing, and a device that
 *     reports the pinned version all get the same "nothing to do" answer.
 *   * **any other `running`** → offer the target. "Newer" is whatever the
 *     project's target says it is: the operator pins an `assigned` version, or
 *     falls back to the newest `latest` one. The offer never invents an
 *     ordering of its own — it does not parse the strings to decide which is
 *     larger, it simply *offers the target to a device that is not on it*.
 *   * **target with no `firmware` row** → `{update:null}`. The row is what names
 *     a retrievable image and its `size`/`sha256`, so a target that is not
 *     backed by a row is not offerable — a device must never be pointed at a
 *     version whose bytes (or digest) we cannot describe. Fail closed.
 *
 * `assigned` wins over `latest`: an operator who pins a version is saying
 * "this fleet runs this", and the newest upload must not silently override a
 * deliberate rollback. Only when nothing is assigned does `latest` apply.
 *
 * ## The offer carries the image URL, and the URL is the path
 *
 * `update.url` is the image URL for the offered version (§6.4). The image is
 * served by A18c at `GET /v1/ota/image`, selected by the same
 * `x-insight-firmware` header this route reads, so the URL is exactly that
 * path — {@link OTA_IMAGE_PATH} — with no version segment to keep in sync: the
 * device already knows which version it is asking for (the one it was just
 * offered). That makes the offer self-consistent with the reader by
 * construction, rather than by two files agreeing on a string.
 *
 * ## `ota_status` — the offer reconciles the device's reported version
 *
 * The offer is also the one place the platform learns what a device *actually*
 * runs: the `x-insight-firmware` header is the device's own report, and a check
 * the device repeats is the closest thing to an acknowledgement the wire has.
 * So the call records {@link OtaStatusRecorder.recordOtaStatus} — the
 * `reconcile`-style half of this module, in the same spirit as
 * `domains/telemetry/reconcile.ts` (an observation that repairs drifted state,
 * idempotent by construction):
 *
 *   * the device reports the **target** version → `ok` (it is on the version we
 *     want; the fleet's drift for this device is closed);
 *   * any other report (stale, unknown, or no target at all) → `update_available`,
 *     explicitly *not* `ok`, so a pinned-but-unreached version stays visible.
 *
 * The record is best-effort in the same sense the ingest route's device
 * registration is: a recorder that is absent (a deploy without one) or that
 * *throws* never fails the offer — the offer's answer is about firmware, and a
 * reporting hiccup must not turn a device's check into an error. A throwing
 * recorder is swallowed (see the "Fail closed" note below), never surfaced.
 *
 * ## Fail closed
 *
 * A lookup (used for the target's row) that throws is treated as "no row", so
 * the offer degrades to `{update:null}` rather than a `500`: a device left on
 * its current version is safe, and the offer is re-asked on the next poll. The
 * same posture the ingest route takes toward a broken rate limiter — a guard
 * that cannot be evaluated never opens a gate.
 *
 * ## Auth
 *
 * The route authenticates through the injected {@link VerifyOfferToken} — the
 * shared strict Bearer grammar plus the D1-backed device-token verifier in
 * production, a stub in tests. A missing/malformed/unusable token is `401`
 * `{error:"unauthorized"}`, indistinguishable in reason from a rejected one, so
 * a caller cannot probe why it failed. The resolved principal's `projectId`
 * scopes every lookup, so one project's token can never read another's targets
 * or firmware rows.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { readBearerToken, type Principal } from "../../platform/middleware/resolve-project";

// ---------------------------------------------------------------------------
// Frozen wire constants (mirror test/contracts/ota-lock.ts — the tripwire)
// ---------------------------------------------------------------------------

/** The offer route's path (spec §6.4). */
export const OTA_OFFER_PATH = "/v1/ota";

/** The image route's path (spec §6.5) — the offer's `url` value. */
export const OTA_IMAGE_PATH = "/v1/ota/image";

/** Frozen envelope field: `{ "update": null | {...} }`. */
export const OTA_RESPONSE_FIELD = "update";

/**
 * Field names of the `update` object, in contract order. Exported as a value so
 * a test can assert the emitted object's KEY ORDER, which the SDK's index
 * scanner depends on.
 */
export const OTA_UPDATE_FIELD_NAMES = ["version", "size", "sha256", "url"] as const;

/** Frozen `200` — both the "current" and the "offer" success bodies. */
export const OTA_OFFER_OK_STATUS = 200 as const;

/** Frozen `401` — no token, or one the verifier rejects. */
export const OTA_OFFER_UNAUTHORIZED_STATUS = 401 as const;

/** Frozen error code carried by a `401`. */
export const OTA_OFFER_UNAUTHORIZED_CODE = "unauthorized" as const;

/** The request header carrying the RUNNING firmware version (spec §6.4). */
export const OTA_REQUEST_HEADER = "x-insight-firmware";

/** The header naming the requesting device; mirrors the sibling OTA routes. */
export const DEVICE_HEADER = "x-insight-device";

/** Device key applied when {@link DEVICE_HEADER} is absent or blank. */
export const DEFAULT_DEVICE_KEY = "unknown";

// ---------------------------------------------------------------------------
// ota_status — the state the offer records
// ---------------------------------------------------------------------------

/**
 * The OTA state of one device, as the offer records it.
 *
 * `ok` is deliberately narrow: it means the device **reported the version we
 * want it to run**. A device on a stale version, on an unknown version, or in a
 * project with no target at all is `update_available` — never a silent `ok` —
 * so "the fleet is current" is a claim backed by a device's own report rather
 * than by the absence of one.
 */
export type OtaStatus = "ok" | "update_available";

/** Every {@link OtaStatus} value, in a stable order for enumeration in tests. */
export const OTA_STATUSES = ["ok", "update_available"] as const;

/** Type guard: is `value` one of the known OTA statuses? */
export function isOtaStatus(value: unknown): value is OtaStatus {
  return typeof value === "string" && (OTA_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Metadata seam: D1's `firmware` table, reduced to the one lookup the offer
 * needs — the row for a `(projectId, version)`.
 *
 * Declared structurally (a subset of {@link FirmwareRepo} in `upload.ts`, whose
 * `find` satisfies it as-is) so the route is coupled only to the operation it
 * uses and a test can hand it a two-line stub.
 */
export interface FirmwareLookup {
  /**
   * The `(projectId, version)` row, or `null` when this project has no such
   * version. Never another tenant's row.
   */
  find(projectId: string, version: string): Promise<FirmwareRow | null>;
}

/**
 * The `firmware` row as the offer consumes it: the three fields that reach the
 * wire (`version`, `size`, `sha256`) plus the object key.
 *
 * A structural subset of `Firmware` in `upload.ts`, so the real row satisfies
 * it unchanged. `size` and `sha256` are exactly what the device verifies after
 * A18c streams the bytes: the offer forwards them verbatim and computes none of
 * them itself.
 */
export interface FirmwareRow {
  readonly version: string;
  /** Byte length of the stored image — the exact object put by the upload. */
  readonly size: number;
  /** Lowercase 64-hex SHA-256 of the stored image bytes. */
  readonly sha256: string;
  /** Object key the image is stored under (unused on the wire; kept for parity). */
  readonly r2Key: string;
}

/**
 * The project-scoped targets the offer compares against (spec §6.4).
 *
 * Two independent questions, because they can disagree: what an operator has
 * pinned (`assigned`) and what has been uploaded most recently (`latest`). Both
 * are already resolved for one project, so the offer never decides "newest"
 * itself — an ordering of version strings is a policy the platform owns, not a
 * string comparison this route should invent.
 *
 * `null` means "no such version for this project", never "unknown" or "error".
 */
export interface OfferTargets {
  /** The version an operator pinned for the project, or `null` when unpinned. */
  assigned(projectId: string): Promise<string | null>;
  /** The newest uploaded version for the project, or `null` when none. */
  latest(projectId: string): Promise<string | null>;
}

/**
 * The `ota_status` recorder — the reconcile-style seam.
 *
 * One call per offer, carrying the *verified* tenant, the device that made the
 * check, the version it reports running, the target the project wants (or
 * `null` when there is none) and the verdict derived from the two. Implementations
 * upsert a row (`ota_status` in the project DO / `devices` metadata in
 * production); the invite is that the LAST report wins, so a device that
 * re-checks after flashing flips itself to `ok` without any extra endpoint.
 *
 * It MUST tolerate being called for an unknown device (the report is the first
 * thing the platform may hear about it) and MUST be idempotent: a device polling
 * the offer once a minute writes the same row once a minute, with no history.
 */
export interface OtaStatusRecorder {
  recordOtaStatus(record: OtaStatusRecord): Promise<void> | void;
}

/** One `ota_status` observation, exactly as {@link OtaStatusRecorder} receives it. */
export interface OtaStatusRecord {
  readonly projectId: string;
  readonly device: string;
  /** The version the device reports RUNNING (the request header, trimmed). */
  readonly running: string;
  /** The version the project wants this device on, or `null` when none. */
  readonly target: string | null;
  /** The verdict: `ok` iff `running === target`. */
  readonly status: OtaStatus;
  /** The clock's instant, for a recorder that persists `updated_at`. */
  readonly at: number;
}

/**
 * Verifies a presented token and resolves the credential's {@link Principal}.
 * Production wraps the D1-backed device-token verifier; tests pass a stub.
 * Returning `null` (or throwing) means "not usable" and the route answers `401`.
 */
export type VerifyOfferToken = (token: string) => Promise<Principal | null>;

/** Everything `GET /v1/ota` needs, injectable end-to-end for tests. */
export interface OfferDeps {
  /** Metadata seam: the `firmware` row for `(projectId, version)`. */
  readonly firmware: FirmwareLookup;
  /** The project's pinned + newest targets (spec §6.4). */
  readonly targets: OfferTargets;
  /** Verify the presented bearer token → {@link Principal}, or `null`. */
  readonly verifyToken: VerifyOfferToken;
  /**
   * The `ota_status` recorder. Optional: when absent the offer records nothing
   * (the route still answers correctly), which keeps the pure "what should this
   * device run?" question separable from the reporting side-effect.
   */
  readonly otaStatus?: OtaStatusRecorder;
  /** Clock seam (epoch ms) for the record's `at`; defaults to `Date.now`. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Wire bodies
// ---------------------------------------------------------------------------

/** The `update` object of a `200` offer — exactly the four frozen fields. */
export interface OtaUpdate {
  readonly version: string;
  readonly size: number;
  readonly sha256: string;
  /** The image URL: the path A18c serves, selected by the same header. */
  readonly url: string;
}

/**
 * The `200` body. `update` is `null` when the device is current — the frozen
 * "nothing to do" value is JSON `null`, not an omitted key (spec §6.4).
 */
export interface OtaBody {
  readonly update: OtaUpdate | null;
}

/** The `{ error: "unauthorized" }` body; stable and non-probing. */
export interface OtaOfferErrorBody {
  readonly error: typeof OTA_OFFER_UNAUTHORIZED_CODE;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The single frozen "nothing to do" body: `{"update":null}`. */
export function noUpdateBody(): OtaBody {
  return { update: null };
}

/**
 * The "no target" constant: JSON `null` under the envelope key. Kept as a named
 * function (like `noUpdateBody`) so the two "nothing" answers are visibly one
 * shape rather than two literals that could drift apart.
 */
export const NO_UPDATE_VALUE = null;

/**
 * Resolve the project's target version: `assigned` if set, else `latest`, else
 * `null`.
 *
 * `assigned` wins (see the module doc): a deliberate pin is an operator's
 * decision and outranks "the newest upload". A blank/whitespace target is
 * treated as absent, so a misconfigured empty string cannot become a version
 * nothing backs.
 */
export async function resolveTarget(
  targets: OfferTargets,
  projectId: string,
): Promise<string | null> {
  const assigned = (await targets.assigned(projectId))?.trim() ?? "";
  if (assigned !== "") return assigned;

  const latest = (await targets.latest(projectId))?.trim() ?? "";
  return latest === "" ? null : latest;
}

/**
 * The `ota_status` verdict: `ok` iff the device reports the target version.
 *
 * The comparison is exact and case-sensitive — a version string is an opaque
 * name, not a number to be coerced, and `"1.2.0"` and `" 1.2.0 "` are not the
 * same report. A `null` target (nothing to run) is never `ok`.
 */
export function otaStatus(running: string, target: string | null): OtaStatus {
  return target !== null && running === target ? "ok" : "update_available";
}

/**
 * Build the offer from the running version, the resolved target and the
 * target's row — the whole §6.4 rule in one pure function.
 *
 *   * target `null`, or `running === target` → `{update:null}`;
 *   * otherwise a row → the four-field offer;
 *   * otherwise (no row) → `{update:null}` (an image we cannot describe is not
 *     offerable — fail closed).
 *
 * `url` is {@link OTA_IMAGE_PATH}: the version the device was just offered is
 * the version it will ask A18c for, so the URL needs no version segment.
 */
export function buildOffer(
  running: string,
  target: string | null,
  row: FirmwareRow | null,
): OtaUpdate | null {
  if (target === null || running === target) return null;
  if (row === null) return null;

  return {
    version: row.version,
    size: row.size,
    sha256: row.sha256,
    url: OTA_IMAGE_PATH,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** The handler shape, named so consumers can hold a reference. */
export type OfferHandler = (c: Context) => Promise<Response>;

/**
 * Authenticate the request, or return the `401` to answer it with.
 *
 * The credential is parsed with the SHARED strict Bearer grammar (a bare or
 * scheme-less `Authorization` is not a credential at all) then verified through
 * the injected seam; a verifier that *throws* is a refusal, not a `500`, so the
 * route fails closed rather than leaking an unenforceable mistake.
 */
async function authorise(c: Context, deps: OfferDeps): Promise<Principal | Response> {
  const token = readBearerToken(c);
  if (token === null) return unauthorized(c);

  let principal: Principal | null;
  try {
    principal = await deps.verifyToken(token);
  } catch {
    principal = null;
  }
  if (principal === null) return unauthorized(c);

  // Expose the resolved principal exactly the way `resolveProject` does, so a
  // downstream reader sees the *verified* tenant, never one derived from the URL.
  c.set("principal", principal);
  return principal;
}

/** The `401`, built once per call so the body is frozen and non-probing. */
function unauthorized(c: Context): Response {
  const body: OtaOfferErrorBody = {
    error: OTA_OFFER_UNAUTHORIZED_CODE,
    message: "a valid project token is required",
  };
  return c.json(body, OTA_OFFER_UNAUTHORIZED_STATUS);
}

/**
 * Build the `GET /v1/ota` handler.
 *
 * Order, each step's failure mapped to the frozen shape:
 *   1. auth                       → `401` (fail closed)
 *   2. read `x-insight-firmware`  → the RUNNING version (blank = "")
 *   3. resolve the project target → `assigned`, else `latest`, else none
 *   4. the target's `firmware` row → `{update:null}` when absent
 *   5. build the offer            → `{update:null}` or the four-field object
 *   6. record `ota_status`        → best-effort, never fails the answer
 */
export function createOfferHandler(deps: OfferDeps): OfferHandler {
  const now = deps.now ?? (() => Date.now());

  return async function offerHandler(c: Context): Promise<Response> {
    // 1. AUTH — before any lookup, so an anonymous caller learns nothing about
    //    a project's firmware.
    const principal = await authorise(c, deps);
    if (principal instanceof Response) return principal;

    const projectId = principal.projectId;
    const device = (c.req.header(DEVICE_HEADER) ?? "").trim() || DEFAULT_DEVICE_KEY;

    // 2. RUNNING — the version the device reports, trimmed. A blank/absent
    //    header is not an error: it is a device we cannot match to the target,
    //    which the rule below resolves to an offer (and never to `ok`).
    const running = (c.req.header(OTA_REQUEST_HEADER) ?? "").trim();

    // 3. TARGET — the project's pinned version, else the newest; never a global
    //    default, and scoped by the VERIFIED tenant.
    const target = await resolveTarget(deps.targets, projectId);

    // 4./5. THE ROW + THE OFFER — a target with no row is not offerable (fail
    //       closed: `{update:null}`), and a lookup that throws degrades the same
    //       way rather than surfacing a 500.
    let row: FirmwareRow | null = null;
    if (target !== null && running !== target) {
      try {
        row = await deps.firmware.find(projectId, target);
      } catch {
        row = null;
      }
    }
    const update = buildOffer(running, target, row);
    const body: OtaBody = { update };

    // 6. RECORD `ota_status` — the reconcile half. Best-effort and AFTER the
    //    answer is decided: the offer is about the device's firmware, so a
    //    reporting failure (or an absent recorder) must never turn a check into
    //    an error. A recorder that throws is swallowed here — the same
    //    fail-closed posture the route takes toward its lookups.
    if (deps.otaStatus !== undefined) {
      const record: OtaStatusRecord = {
        projectId,
        device,
        running,
        target,
        status: otaStatus(running, target),
        at: now(),
      };
      try {
        await deps.otaStatus.recordOtaStatus(record);
      } catch {
        // Reporting is advisory — never fail the offer because of it.
      }
    }

    return c.json(body, OTA_OFFER_OK_STATUS);
  };
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

/**
 * The mountable offer router: a Hono app whose `GET /` is {@link createOfferHandler}.
 *
 * Named (rather than left as `Hono`) so a consumer that holds the router — a
 * deploy wiring it, a test driving `app.request` — imports one contract.
 */
export type OtaOfferRouter = Hono;

/**
 * Build a ready-to-mount Hono app exposing `GET /v1/ota`.
 *
 * Mount with `app.route("/v1/ota", createOtaOffer(deps))`; the handler sits at
 * `/`. Kept as its own router (like `createOtaImage`) so a deploy wires the OTA
 * surface without inventing a path here.
 */
export function createOtaOffer(deps: OfferDeps): OtaOfferRouter {
  const app = new Hono();
  app.get("/", createOfferHandler(deps));
  return app;
}

// ---------------------------------------------------------------------------
// In-memory fakes — honest implementations of the seams, for tests & local dev
// ---------------------------------------------------------------------------

/**
 * In-memory {@link OtaStatusRecorder}.
 *
 * Keeps every record in call order so a test can assert the exact observation
 * (including that `at` is the injected clock) and that an up-to-date poll wrote
 * `ok`. The "last write wins" shape is modelled by a map keyed `(projectId,
 * device)`: `latest` is the row a device's most recent check would have left,
 * which is the property the reconcile behaviour depends on. Not a production
 * store: it never expires and holds no history.
 */
export class InMemoryOtaStatusRecorder implements OtaStatusRecorder {
  readonly #seen: OtaStatusRecord[] = [];
  readonly #latest = new Map<string, OtaStatusRecord>();

  /** Every recorded observation, in call order. */
  all(): readonly OtaStatusRecord[] {
    return this.#seen.slice();
  }

  /** The row for one device, or `null` when it has never reported. */
  latest(projectId: string, device: string): OtaStatusRecord | null {
    return this.#latest.get(InMemoryOtaStatusRecorder.#key(projectId, device)) ?? null;
  }

  /** The recorded status for one device, or `null` when it has never reported. */
  status(projectId: string, device: string): OtaStatus | null {
    return this.latest(projectId, device)?.status ?? null;
  }

  recordOtaStatus(record: OtaStatusRecord): void {
    const stored: OtaStatusRecord = { ...record };
    this.#seen.push(stored);
    // Last write wins: a later check for the same device replaces the row.
    this.#latest.set(InMemoryOtaStatusRecorder.#key(record.projectId, record.device), stored);
  }

  /** Tenant is part of the key, so one project cannot overwrite another's row. */
  static #key(projectId: string, device: string): string {
    return `${projectId}\u0000${device}`;
  }
}

export default createOtaOffer;
