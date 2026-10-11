/**
 * Spec tests for the OTA offer — `GET /v1/ota` (A18b, spec §6.4).
 *
 * The route is a pure service over injected seams, so these tests drive honest
 * in-memory fakes and the REAL route handler (through a Hono app built from
 * {@link createOtaOffer}) — nothing here is the code under test:
 *
 *   0. **The frozen shape** — the offer's envelope, its four `update` fields in
 *      contract order, the `x-insight-firmware` request header and the image
 *      URL are asserted against `test/contracts/ota-lock.ts`, so an edit to the
 *      lock or the route fails HERE (the tripwire).
 *   1. **Up to date** — a device reporting the target version gets exactly
 *      `{"update":null}`, and its `ota_status` reconciles to `ok`.
 *   2. **Stale** — a device behind the target gets `{"update":{version,size,
 *      sha256,url}}`, every field the exact stored value, including the digest
 *      from the `firmware` row.
 *   3. **Assign vs latest** — a pinned `assigned` version outranks `latest`;
 *      with nothing assigned, `latest` applies; with neither, nothing is
 *      offered.
 *   4. **Fail closed** — a target with no `firmware` row is not offerable, a
 *      lookup/recorder that throws never becomes a `500`, and an
 *      unauthenticated request is `401` with no offer in the body.
 *
 * The `firmware` rows and the object store are the SAME fakes the upload suite
 * uses (`InMemoryFirmwareRepo` / `InMemoryImageStore`), so an offered
 * `size`/`sha256` is what the *upload* path recorded rather than a fixture
 * invented here.
 */

import { describe, expect, it } from "vitest";
import {
  DEVICE_HEADER,
  DEFAULT_DEVICE_KEY,
  InMemoryOtaStatusRecorder,
  NO_UPDATE_VALUE,
  OTA_IMAGE_PATH,
  OTA_OFFER_OK_STATUS,
  OTA_OFFER_PATH,
  OTA_OFFER_UNAUTHORIZED_CODE,
  OTA_OFFER_UNAUTHORIZED_STATUS,
  OTA_UPDATE_FIELD_NAMES,
  buildOffer,
  createOtaOffer,
  isOtaStatus,
  otaStatus,
  resolveTarget,
  type FirmwareLookup,
  type FirmwareRow,
  type OfferDeps,
  type OfferTargets,
  type OtaStatusRecorder,
  type OtaOfferRouter,
  type VerifyOfferToken,
} from "../../worker/src/domains/firmware/offer";
import {
  FIRMWARE_CONTENT_TYPE,
  InMemoryFirmwareRepo,
  InMemoryImageStore,
  firmwareKey,
} from "../../worker/src/domains/firmware/upload";
// The FROZEN cross-repo contract lock — the tripwire this suite asserts against.
import { OTA_OFFER, OTA_SHA256_HEX_LENGTH } from "../contracts/ota-lock";
import { CONTRACT_HEADERS, OTA_RESPONSE_FIELDS, OTA_UPDATE_FIELDS } from "../contracts/contract-lock";

const PROJECT = "proj_ota";
const OTHER_PROJECT = "proj_other";
const DEVICE = "dev_alpha";
const TOKEN = "pt_live_ota";
const RUNNING = "1.0.0";
const TARGET = "1.2.0";
const FIRMWARE_HEADER = CONTRACT_HEADERS.firmware; // "x-insight-firmware"

// ---------------------------------------------------------------------------
// Harness — the real seams, plus the two target answers the test owns
// ---------------------------------------------------------------------------

interface Harness {
  readonly app: OtaOfferRouter;
  readonly store: InMemoryImageStore;
  readonly repo: InMemoryFirmwareRepo;
  readonly otaStatus: InMemoryOtaStatusRecorder;
  readonly deps: OfferDeps;
  /** Move the offer's injected clock (it starts at a fixed epoch). */
  setClock(value: number): void;
  /** Pin / clear the project's `assigned` target. */
  assign(version: string | null): void;
  /** Set / clear the project's `latest` target. */
  publishLatest(version: string | null): void;
}

/**
 * Build the full dependency set over real in-memory seams.
 *
 * The metadata table and the object store are the SAME fakes the upload suite
 * uses, wired through an adapter exposing exactly the one method this route
 * consumes, so what the offer reports is what the upload path recorded. The two
 * @link OfferTargets} answers are small, test-owned values (the route must not
 * invent "newest" itself — see the module doc).
 */
function setup(): Harness {
  const store = new InMemoryImageStore();
  const repo = new InMemoryFirmwareRepo();
  const otaStatus = new InMemoryOtaStatusRecorder();
  let clock = 1_700_000_000_000;

  let assigned: string | null = null;
  let latest: string | null = null;

  const firmware: FirmwareLookup = {
    find: async (projectId, version) => repo.find(projectId, version),
  };
  const targets: OfferTargets = {
    assigned: async () => assigned,
    latest: async () => latest,
  };
  const verifyToken: VerifyOfferToken = async (token) =>
    token === TOKEN
      ? { kind: "device", projectId: PROJECT, tokenId: "tok_ota", scopes: "read write" }
      : null;

  const deps: OfferDeps = { firmware, targets, verifyToken, otaStatus, now: () => clock };
  return {
    app: createOtaOffer(deps),
    store,
    repo,
    otaStatus,
    deps,
    setClock: (value) => {
      clock = value;
    },
    assign: (version) => {
      assigned = version;
    },
    publishLatest: (version) => {
      latest = version;
    },
  };
}

/** Seed a firmware row + its object the way the upload route would. */
async function seedImage(
  harness: Harness,
  version: string,
  bytes: Uint8Array,
  projectId: string = PROJECT,
): Promise<FirmwareRow> {
  const key = firmwareKey(projectId, version);
  await harness.store.put(key, bytes, FIRMWARE_CONTENT_TYPE);
  const row = await harness.repo.upsert({
    id: `fw_${projectId}_${version}`,
    projectId,
    version,
    size: bytes.byteLength,
    sha256: digest(bytes),
    r2Key: key,
    createdAt: 0,
    updatedAt: 0,
  });
  return row;
}

/** Deterministic, incompressible-looking bytes without a real RNG. */
function image(bytes: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length: bytes }, (_, i) => (i * 31 + seed * 7) & 0xff);
}

/**
 * A deterministic 64-hex digest with no async dependency, so a seeded row's
 * `sha256` is knowable in the expectation as well as the offer.
 */
function digest(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h = (h ^ b) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").repeat(OTA_SHA256_HEX_LENGTH / 8);
}

/** Drive the route for one device / running version. */
async function request(
  harness: Harness,
  running: string,
  options: { device?: string; token?: string } = {},
): Promise<Response> {
  return harness.app.request("/", {
    method: "GET",
    headers: {
      [CONTRACT_HEADERS.authorization]: `Bearer ${options.token ?? TOKEN}`,
      [FIRMWARE_HEADER]: running,
      [DEVICE_HEADER]: options.device ?? DEVICE,
    },
  });
}

/** The parsed `{update: ...}` body of a `200`. */
async function bodyOf(res: Response): Promise<{ update: Record<string, unknown> | null }> {
  return (await res.json()) as { update: Record<string, unknown> | null };
}

// ---------------------------------------------------------------------------
// 0. The frozen wire shape (the tripwire)
// ---------------------------------------------------------------------------
describe("GET /v1/ota — the frozen shape", () => {
  it("matches the OTA lock: path, status, header, envelope and field order", () => {
    expect(OTA_OFFER.path).toBe(OTA_OFFER_PATH);
    expect(OTA_OFFER.method).toBe("GET");
    expect(OTA_OFFER.success).toBe(OTA_OFFER_OK_STATUS);
    expect(OTA_OFFER.requestHeader).toBe(FIRMWARE_HEADER);
    expect(OTA_OFFER.requestHeader).toBe("x-insight-firmware");
    expect(OTA_OFFER.envelopeField).toBe(OTA_RESPONSE_FIELDS[0]);
    expect(OTA_OFFER.envelopeField).toBe("update");
    // The `update` object's fields are the lock's, in the lock's order.
    expect(OTA_OFFER.updateFields).toBe(OTA_UPDATE_FIELDS);
    expect(OTA_UPDATE_FIELD_NAMES).toEqual(["version", "size", "sha256", "url"]);
    // The JSON `null` "nothing to do" value is the lock's, not a fresh literal.
    expect(OTA_OFFER.noUpdateValue).toBe(NO_UPDATE_VALUE);
    expect(OTA_OFFER.noUpdateValue).toBeNull();
    // The digest length the offer reports is the frozen 64 hex characters.
    expect(OTA_SHA256_HEX_LENGTH).toBe(64);
  });

  it("serialises up-to-date as exactly `{\"update\":null}`", () => {
    expect(JSON.stringify({ update: NO_UPDATE_VALUE })).toBe('{"update":null}');
  });

  it("freezes `ok`/`update_available` as the only two ota_status values", () => {
    expect(isOtaStatus("ok")).toBe(true);
    expect(isOtaStatus("update_available")).toBe(true);
    expect(isOtaStatus("stale")).toBe(false);
    expect(isOtaStatus(1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1. Up to date → {update:null}, and ota_status reconciles to `ok`
// ---------------------------------------------------------------------------
describe("GET /v1/ota — the device is current", () => {
  it("answers a device on the assigned target with exactly {update:null}", async () => {
    const harness = setup();
    await seedImage(harness, TARGET, image(512));
    harness.assign(TARGET);

    const res = await request(harness, TARGET);

    expect(res.status).toBe(OTA_OFFER_OK_STATUS);
    const body = await bodyOf(res);
    expect(Object.keys(body)).toEqual(["update"]);
    expect(body.update).toBeNull();
    // Byte-for-byte the frozen "nothing to do" body.
    expect(JSON.stringify(body)).toBe('{"update":null}');
  });

  it("answers a device on the latest version with {update:null} when nothing is assigned", async () => {
    const harness = setup();
    await seedImage(harness, TARGET, image(64));
    harness.publishLatest(TARGET); // no `assigned` pin

    const body = await bodyOf(await request(harness, TARGET));
    expect(body.update).toBeNull();
  });

  it("reconciles ota_status to `ok` for a device reporting the target", async () => {
    const harness = setup();
    await seedImage(harness, TARGET, image(128));
    harness.assign(TARGET);

    await request(harness, TARGET);

    // The record is the LAST report for the device — the reconcile property.
    expect(harness.otaStatus.status(PROJECT, DEVICE)).toBe("ok");
    const record = harness.otaStatus.latest(PROJECT, DEVICE);
    expect(record).toMatchObject({
      projectId: PROJECT,
      device: DEVICE,
      running: TARGET,
      target: TARGET,
      status: "ok",
    });
    expect(harness.otaStatus.all()).toHaveLength(1);
  });

  it("does NOT write `ok` for a device reporting a version other than the target", async () => {
    const harness = setup();
    await seedImage(harness, TARGET, image(128));
    harness.assign(TARGET);

    await request(harness, RUNNING); // stale report

    expect(harness.otaStatus.status(PROJECT, DEVICE)).toBe("update_available");
    expect(harness.otaStatus.status(PROJECT, DEVICE)).not.toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 2. Stale device → the exact four-field offer
// ---------------------------------------------------------------------------
describe("GET /v1/ota — a newer firmware is available", () => {
  it("offers version/size/sha256/url with the exact stored values", async () => {
    const harness = setup();
    const bytes = image(4096);
    const row = await seedImage(harness, TARGET, bytes);
    harness.assign(TARGET);

    const res = await request(harness, RUNNING);

    expect(res.status).toBe(OTA_OFFER_OK_STATUS);
    const body = await bodyOf(res);
    expect(Object.keys(body)).toEqual(["update"]);

    const update = body.update as Record<string, unknown>;
    // Exactly the four fields, in contract order, and nothing else.
    expect(Object.keys(update)).toEqual(["version", "size", "sha256", "url"]);
    expect(update.version).toBe(TARGET);
    expect(update.size).toBe(bytes.byteLength);
    expect(update.size).toBe(row.size);
    expect(update.sha256).toBe(row.sha256);
    expect(update.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(update.url).toBe(OTA_IMAGE_PATH);
    // `version` lives under `update`, never at the top level.
    expect(Object.keys(body)).not.toContain("version");
  });

  it("offers the newest version when nothing is assigned", async () => {
    const harness = setup();
    await seedImage(harness, RUNNING, image(16));
    await seedImage(harness, TARGET, image(32));
    harness.publishLatest(TARGET);

    const update = (await bodyOf(await request(harness, RUNNING))).update;
    expect(update?.version).toBe(TARGET);
  });

  it("never offers a version with no firmware row (fail closed)", async () => {
    const harness = setup();
    harness.assign(TARGET); // pinned, but the upload never recorded a row

    const body = await bodyOf(await request(harness, RUNNING));
    expect(body.update).toBeNull();
  });

  it("keeps tenancy: one project's target is never offered from another's row", async () => {
    const harness = setup();
    // The row exists, but for ANOTHER project.
    await seedImage(harness, TARGET, image(64), OTHER_PROJECT);
    harness.assign(TARGET);

    const body = await bodyOf(await request(harness, RUNNING));
    expect(body.update).toBeNull();
  });

  it("offers the target to a device reporting an unknown version", async () => {
    const harness = setup();
    await seedImage(harness, TARGET, image(64));
    harness.assign(TARGET);

    const update = (await bodyOf(await request(harness, "0.0.1-alpha"))).update;
    expect(update?.version).toBe(TARGET);
  });

  it("answers with {update:null} when the project has no target at all", async () => {
    const harness = setup();
    await seedImage(harness, TARGET, image(64)); // rows exist, none targeted

    const body = await bodyOf(await request(harness, RUNNING));
    expect(body.update).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Auth & the hardened failures
// ---------------------------------------------------------------------------
describe("GET /v1/ota — auth and failure handling", () => {
  it("refuses an unauthenticated request with 401 and no offer", async () => {
    const harness = setup();
    await seedImage(harness, TARGET, image(64));
    harness.assign(TARGET);

    const res = await harness.app.request("/", {
      method: "GET",
      headers: { [FIRMWARE_HEADER]: RUNNING },
    });

    expect(res.status).toBe(OTA_OFFER_UNAUTHORIZED_STATUS);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe(OTA_OFFER_UNAUTHORIZED_CODE);
    expect(body).not.toHaveProperty("update");
  });

  it("refuses a token the verifier rejects", async () => {
    const harness = setup();
    const res = await request(harness, RUNNING, { token: "pt_wrong" });
    expect(res.status).toBe(401);
  });

  it("treats a throwing verifier as a refusal, not a 500", async () => {
    const harness = setup();
    const throwing: OfferDeps = {
      ...harness.deps,
      verifyToken: async () => {
        throw new Error("verifier exploded");
      },
    };
    const res = await createOtaOffer(throwing).request("/", {
      method: "GET",
      headers: { [CONTRACT_HEADERS.authorization]: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("degrades to {update:null} when the row lookup throws", async () => {
    const harness = setup();
    harness.assign(TARGET);
    const exploding: OfferDeps = {
      ...harness.deps,
      firmware: {
        find: async () => {
          throw new Error("D1 unavailable");
        },
      },
    };

    const res = await createOtaOffer(exploding).request("/", {
      method: "GET",
      headers: {
        [CONTRACT_HEADERS.authorization]: `Bearer ${TOKEN}`,
        [FIRMWARE_HEADER]: RUNNING,
      },
    });
    expect(res.status).toBe(OTA_OFFER_OK_STATUS);
    expect((await bodyOf(res)).update).toBeNull();
  });

  it("answers correctly even when the ota_status recorder throws", async () => {
    const harness = setup();
    await seedImage(harness, TARGET, image(64));
    harness.assign(TARGET);
    const explodingRecorder: OtaStatusRecorder = {
      recordOtaStatus: () => {
        throw new Error("recorder exploded");
      },
    };

    const res = await createOtaOffer({ ...harness.deps, otaStatus: explodingRecorder }).request("/", {
      method: "GET",
      headers: {
        [CONTRACT_HEADERS.authorization]: `Bearer ${TOKEN}`,
        [FIRMWARE_HEADER]: RUNNING,
      },
    });
    expect(res.status).toBe(OTA_OFFER_OK_STATUS);
    expect((await bodyOf(res)).update?.version).toBe(TARGET);
  });
});

// ---------------------------------------------------------------------------
// 4. The reconciling report — one row per device, last report wins
// ---------------------------------------------------------------------------
describe("ota_status — the reconcile report", () => {
  it("flips a stale device to `ok` when it later reports the target", async () => {
    const harness = setup();
    await seedImage(harness, TARGET, image(256));
    harness.assign(TARGET);

    await request(harness, RUNNING);
    expect(harness.otaStatus.status(PROJECT, DEVICE)).toBe("update_available");

    await request(harness, TARGET);
    expect(harness.otaStatus.status(PROJECT, DEVICE)).toBe("ok");
    // Two observations, but only the latest survives as the device's row.
    expect(harness.otaStatus.all()).toHaveLength(2);
    expect(harness.otaStatus.latest(PROJECT, DEVICE)?.status).toBe("ok");
  });

  it("reports `update_available` (never `ok`) when the project has no target", async () => {
    const harness = setup();
    await request(harness, RUNNING);

    const record = harness.otaStatus.latest(PROJECT, DEVICE);
    expect(record?.target).toBeNull();
    expect(record?.status).toBe("update_available");
  });

  it("buckets a nameless device under the shared default key", async () => {
    const harness = setup();
    harness.assign(TARGET);
    await seedImage(harness, TARGET, image(32));

    await harness.app.request("/", {
      method: "GET",
      headers: {
        [CONTRACT_HEADERS.authorization]: `Bearer ${TOKEN}`,
        [FIRMWARE_HEADER]: TARGET,
      },
    });

    expect(harness.otaStatus.status(PROJECT, DEFAULT_DEVICE_KEY)).toBe("ok");
  });

  it("stamps each observation with the injected clock's instant", async () => {
    const harness = setup();
    harness.setClock(1_700_000_000_123);

    await request(harness, RUNNING);

    expect(harness.otaStatus.latest(PROJECT, DEVICE)?.at).toBe(1_700_000_000_123);
  });
});

// ---------------------------------------------------------------------------
// 5. The pure helpers — the §6.4 rule in isolation
// ---------------------------------------------------------------------------
describe("offer helpers", () => {
  it("resolveTarget prefers `assigned` over `latest`, and null when neither", async () => {
    const answers: Record<string, string | null> = { assigned: null, latest: null };
    const targets: OfferTargets = {
      assigned: async () => answers.assigned,
      latest: async () => answers.latest,
    };

    expect(await resolveTarget(targets, PROJECT)).toBeNull();
    answers.latest = "2.0.0";
    expect(await resolveTarget(targets, PROJECT)).toBe("2.0.0");
    // A pin outranks a newer upload — a deliberate rollback must hold.
    answers.assigned = "1.9.0";
    expect(await resolveTarget(targets, PROJECT)).toBe("1.9.0");
    // A blank answer is "absent", never a version nothing backs.
    answers.assigned = "   ";
    expect(await resolveTarget(targets, PROJECT)).toBe("2.0.0");
  });

  it("otaStatus is `ok` iff the device reports exactly the target", () => {
    expect(otaStatus(TARGET, TARGET)).toBe("ok");
    expect(otaStatus(RUNNING, TARGET)).toBe("update_available");
    expect(otaStatus(TARGET, null)).toBe("update_available");
    // A version string is an opaque name: no coercion, no trimming.
    expect(otaStatus(` ${TARGET} `, TARGET)).toBe("update_available");
  });

  it("buildOffer offers only a target the device is not on AND has a row for", () => {
    const row: FirmwareRow = {
      version: TARGET,
      size: 10,
      sha256: "a".repeat(OTA_SHA256_HEX_LENGTH),
      r2Key: firmwareKey(PROJECT, TARGET),
    };

    expect(buildOffer(TARGET, TARGET, row)).toBeNull(); // already current
    expect(buildOffer(RUNNING, null, row)).toBeNull(); // no target
    expect(buildOffer(RUNNING, TARGET, null)).toBeNull(); // no row
    expect(buildOffer(RUNNING, TARGET, row)).toEqual({
      version: TARGET,
      size: 10,
      sha256: "a".repeat(OTA_SHA256_HEX_LENGTH),
      url: OTA_IMAGE_PATH,
    });
  });

  it("exposes the mountable router at the frozen path family", () => {
    const harness = setup();
    expect(OTA_OFFER_PATH).toBe("/v1/ota");
    // The image URL the offer hands out is the sibling route A18c serves.
    expect(OTA_IMAGE_PATH).toBe(`${OTA_OFFER_PATH}/image`);
    expect(typeof createOtaOffer(harness.deps).request).toBe("function");
  });
});
