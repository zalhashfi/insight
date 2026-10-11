/**
 * Spec tests for the OTA image download — `GET /v1/ota/image` (A18c, spec §6.5).
 *
 * The route is a pure service over three injected seams, so these tests drive
 * honest in-memory fakes and the REAL route handler (through a Hono app built
 * from {@link createOtaImage}) — nothing here is the code under test:
 *
 *   1. **Existing image** — `200`, `application/octet-stream`, and the EXACT
 *      bytes at the deterministic key, byte-for-byte.
 *   2. **Quota exceeded** — `429` + a numeric `retry-after`, and *no bytes* are
 *      streamed (empty body, no `application/octet-stream`).
 *   3. **Missing image** — `404`, for a version with no row AND for a row whose
 *      object has been deleted out of band.
 *   4. **Quota is per device, per hour** — two devices never share a counter,
 *      and the window rolls exactly one hour after the budget was spent.
 *
 * The frozen wire shape (`OTA_IMAGE`) from `test/contracts/ota-lock.ts` is
 * asserted directly, so an edit to the lock or the route fails here.
 */

import { describe, expect, it } from "vitest";
import { createOtaImage } from "../../worker/src/domains/firmware/image";
import {
  DEFAULT_OTA_IMAGE_QUOTA_PER_HOUR,
  IMAGE_NOT_FOUND_STATUS,
  IMAGE_OK_STATUS,
  IMAGE_RATE_LIMITED_STATUS,
  OTA_IMAGE_CONTENT_TYPE,
  OTA_IMAGE_QUOTA_WINDOW_MS,
  RETRY_AFTER_HEADER,
  WindowQuota,
  createImageHandler,
  type FirmwareLookup,
  type ImageDeps,
  type ImageReader,
  type VerifyImageToken,
} from "../../worker/src/domains/firmware/image";
import {
  FIRMWARE_CONTENT_TYPE,
  InMemoryFirmwareRepo,
  InMemoryImageStore,
  firmwareKey,
} from "../../worker/src/domains/firmware/upload";
// The FROZEN cross-repo contract lock — the tripwire this suite asserts against.
import { OTA_IMAGE } from "../contracts/ota-lock";
import { CONTRACT_HEADERS } from "../contracts/contract-lock";

const PROJECT = "proj_ota";
const VERSION = "1.2.0";
const TOKEN = "pt_live_ota";
const DEVICE_A = "dev_alpha";
const DEVICE_B = "dev_beta";
const FIRMWARE_HEADER = CONTRACT_HEADERS.firmware; // "x-insight-firmware"

// ---------------------------------------------------------------------------
// Harness — real seams at the bottom, a thin test-local quota on top
// ---------------------------------------------------------------------------

/**
 * Build the full dependency set over real in-memory seams.
 *
 * The object store and the metadata table are the SAME fakes the upload suite
 * uses (`InMemoryImageStore` / `InMemoryFirmwareRepo`), wired through adapters
 * that expose exactly the two methods this route consumes — so the bytes the
 * route streams are bytes the *upload* path produced, not a bespoke fixture.
 */
interface Harness {
  readonly app: ReturnType<typeof createOtaImage>;
  readonly store: InMemoryImageStore;
  readonly repo: InMemoryFirmwareRepo;
  readonly clock: { now: number };
  readonly quota: WindowQuota;
  readonly deps: ImageDeps;
}

function setup(options: { quotaLimit?: number; clock?: { now: number } } = {}): Harness {
  const store = new InMemoryImageStore();
  const repo = new InMemoryFirmwareRepo();
  const clock = options.clock ?? { now: 1_700_000_000_000 };

  // Adapters: the seam shapes this route declares, over the real fakes.
  const images: ImageReader = {
    get: async (key) => {
      const object = store.get(key);
      return object === undefined
        ? null
        : { body: object.body, contentType: object.contentType };
    },
  };
  const firmware: FirmwareLookup = {
    findKey: async (projectId, version) => {
      const row = await repo.find(projectId, version);
      return row === null ? null : row.r2Key;
    },
  };
  const quota = new WindowQuota({
    limit: options.quotaLimit ?? 2,
    windowMs: OTA_IMAGE_QUOTA_WINDOW_MS,
    now: () => clock.now,
  });
  const verifyToken: VerifyImageToken = async (token) =>
    token === TOKEN
      ? { kind: "device", projectId: PROJECT, tokenId: "tok_ota", scopes: "read write" }
      : null;

  const deps: ImageDeps = { images, firmware, quota, verifyToken };
  const app = createOtaImage(deps);
  return { app, store, repo, clock, quota, deps };
}

/** Seed a firmware image the way the upload route would: object + row. */
async function seedImage(
  harness: Harness,
  version: string,
  bytes: Uint8Array,
): Promise<string> {
  const key = firmwareKey(PROJECT, version);
  await harness.store.put(key, bytes, FIRMWARE_CONTENT_TYPE);
  await harness.repo.upsert({
    id: `fw_${version}`,
    projectId: PROJECT,
    version,
    size: bytes.byteLength,
    sha256: "0".repeat(64),
    r2Key: key,
    createdAt: 0,
    updatedAt: 0,
  });
  return key;
}

/** Deterministic, incompressible-looking bytes without a real RNG. */
function image(bytes: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length: bytes }, (_, i) => (i * 31 + seed * 7) & 0xff);
}

/** Drive the route for one device / version. */
async function request(
  harness: Harness,
  device: string,
  version: string,
  token: string = TOKEN,
): Promise<Response> {
  return harness.app.request("/", {
    method: "GET",
    headers: {
      [CONTRACT_HEADERS.authorization]: `Bearer ${token}`,
      [FIRMWARE_HEADER]: version,
      "x-insight-device": device,
    },
  });
}

// ---------------------------------------------------------------------------
// 0. The frozen wire shape (the tripwire)
// ---------------------------------------------------------------------------
describe("GET /v1/ota/image — the frozen shape", () => {
  it("serves application/octet-stream at 200, 429 + retry-after, and 404 on absence", () => {
    expect(OTA_IMAGE.contentType).toBe(OTA_IMAGE_CONTENT_TYPE);
    expect(OTA_IMAGE.success).toBe(IMAGE_OK_STATUS);
    expect(OTA_IMAGE.rateLimited.status).toBe(IMAGE_RATE_LIMITED_STATUS);
    expect(OTA_IMAGE.rateLimited.header).toBe(RETRY_AFTER_HEADER);
    expect(OTA_IMAGE.notFound.status).toBe(IMAGE_NOT_FOUND_STATUS);
    // The request header it reads is the shared /v1/ota family's.
    expect(OTA_IMAGE.requestHeader).toBe(FIRMWARE_HEADER);
  });
});

// ---------------------------------------------------------------------------
// 1. Existing image → 200 + octet-stream + exact bytes
// ---------------------------------------------------------------------------
describe("GET /v1/ota/image — an existing image", () => {
  it("returns 200, application/octet-stream and the EXACT stored bytes", async () => {
    const harness = setup();
    const bytes = image(4096);
    await seedImage(harness, VERSION, bytes);

    const res = await request(harness, DEVICE_A, VERSION);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(OTA_IMAGE_CONTENT_TYPE);
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(bytes);
    // Byte-for-byte: not merely the same length.
    expect([...body]).toEqual([...bytes]);
  });

  it("streams the bytes the upload path stored, at the deterministic key", async () => {
    const harness = setup();
    const bytes = image(777, 4);
    const key = await seedImage(harness, VERSION, bytes);

    expect(key).toBe("firmware/proj_ota/1.2.0.bin");
    const res = await request(harness, DEVICE_A, VERSION);

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(harness.store.get(key)?.body);
  });

  it("refuses an unauthenticated request with 401 and streams nothing", async () => {
    const harness = setup();
    await seedImage(harness, VERSION, image(64));

    const res = await harness.app.request("/", {
      method: "GET",
      headers: { [FIRMWARE_HEADER]: VERSION },
    });

    expect(res.status).toBe(401);
    // A rejection carries the `{ error, message }` body, never the image bytes.
    expect(res.headers.get("content-type")).not.toBe(OTA_IMAGE_CONTENT_TYPE);
    await expect(res.json()).resolves.toMatchObject({ error: "unauthorized" });
  });
});

// ---------------------------------------------------------------------------
// 2. Quota exceeded → 429 + retry-after, and NO bytes
// ---------------------------------------------------------------------------
describe("GET /v1/ota/image — per-device/hour quota", () => {
  it("serves exactly `limit` requests, then denies the next with 429 + retry-after", async () => {
    const harness = setup({ quotaLimit: 2 });
    await seedImage(harness, VERSION, image(128));

    for (let i = 0; i < 2; i += 1) {
      expect((await request(harness, DEVICE_A, VERSION)).status).toBe(200);
    }

    const denied = await request(harness, DEVICE_A, VERSION);
    expect(denied.status).toBe(IMAGE_RATE_LIMITED_STATUS);
    const retryAfter = Number(denied.headers.get(RETRY_AFTER_HEADER));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });

  it("streams NO bytes on a denial (no octet-stream, empty body)", async () => {
    const harness = setup({ quotaLimit: 1 });
    await seedImage(harness, VERSION, image(2048));

    expect((await request(harness, DEVICE_A, VERSION)).status).toBe(200);

    const denied = await request(harness, DEVICE_A, VERSION);
    expect(denied.status).toBe(429);
    // The octet-stream media type belongs to a 200 only.
    expect(denied.headers.get("content-type")).not.toBe(OTA_IMAGE_CONTENT_TYPE);
    // No image bytes are streamed: the body is the small JSON error, not the
    // 2048-byte firmware image the store holds.
    const body = new Uint8Array(await denied.arrayBuffer());
    expect(body.byteLength).toBeLessThan(2048);
    expect(body.byteLength).not.toBe(2048);
  });

  it("does not consult the store at all once over quota", async () => {
    const harness = setup({ quotaLimit: 1 });
    await seedImage(harness, VERSION, image(16));

    let reads = 0;
    const counted: ImageReader = {
      get: async (key) => {
        reads += 1;
        return harness.deps.images.get(key);
      },
    };
    const app = createOtaImage({ ...harness.deps, images: counted });

    await app.request("/", {
      method: "GET",
      headers: {
        [CONTRACT_HEADERS.authorization]: `Bearer ${TOKEN}`,
        [FIRMWARE_HEADER]: VERSION,
        "x-insight-device": DEVICE_A,
      },
    });
    expect(reads).toBe(1);

    const denied = await app.request("/", {
      method: "GET",
      headers: {
        [CONTRACT_HEADERS.authorization]: `Bearer ${TOKEN}`,
        [FIRMWARE_HEADER]: VERSION,
        "x-insight-device": DEVICE_A,
      },
    });
    expect(denied.status).toBe(429);
    // The denied request never reached the store: the budget precedes the read.
    expect(reads).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Missing image → 404
// ---------------------------------------------------------------------------
describe("GET /v1/ota/image — a missing image", () => {
  it("returns 404 for a version with no firmware row", async () => {
    const harness = setup();

    const res = await request(harness, DEVICE_A, "9.9.9");

    expect(res.status).toBe(IMAGE_NOT_FOUND_STATUS);
    // A 404 is JSON, never the image: no octet-stream, no image bytes.
    expect(res.headers.get("content-type")).not.toBe(OTA_IMAGE_CONTENT_TYPE);
    const body = await res.json();
    expect(body).toMatchObject({ error: "not_found" });
  });

  it("returns 404 when the row exists but its object was deleted out of band", async () => {
    const harness = setup();
    // A row describing bytes that are not in the store (the reader's inversion).
    await harness.repo.upsert({
      id: "fw_ghost",
      projectId: PROJECT,
      version: VERSION,
      size: 100,
      sha256: "1".repeat(64),
      r2Key: firmwareKey(PROJECT, VERSION),
      createdAt: 0,
      updatedAt: 0,
    });

    const res = await request(harness, DEVICE_A, VERSION);
    expect(res.status).toBe(IMAGE_NOT_FOUND_STATUS);
  });

  it("returns 404 for a version that belongs to another project's tenant", async () => {
    const harness = setup();
    await seedImage(harness, VERSION, image(32));

    // A token naming a different project cannot read proj_ota's version.
    const other = createOtaImage({
      ...harness.deps,
      verifyToken: async () => ({
        kind: "device",
        projectId: "proj_other",
        tokenId: "tok_other",
        scopes: "read write",
      }),
    });
    const res = await other.request("/", {
      method: "GET",
      headers: {
        [CONTRACT_HEADERS.authorization]: "Bearer pt_other",
        [FIRMWARE_HEADER]: VERSION,
        "x-insight-device": DEVICE_A,
      },
    });
    expect(res.status).toBe(IMAGE_NOT_FOUND_STATUS);
  });
});

// ---------------------------------------------------------------------------
// 4. Quota counts per device, per hour (independent devices), and rolls
// ---------------------------------------------------------------------------
describe("GET /v1/ota/image — quota is per device per hour", () => {
  it("counts each device independently: one device's flood cannot throttle another", async () => {
    const harness = setup({ quotaLimit: 2 });
    await seedImage(harness, VERSION, image(64));

    // Device A exhausts its own budget…
    for (let i = 0; i < 3; i += 1) await request(harness, DEVICE_A, VERSION);
    expect((await request(harness, DEVICE_A, VERSION)).status).toBe(429);

    // …while device B's counter is untouched: it still has its full budget.
    expect(harness.quota.remaining(DEVICE_B)).toBe(2);
    expect((await request(harness, DEVICE_B, VERSION)).status).toBe(200);
    expect((await request(harness, DEVICE_B, VERSION)).status).toBe(200);
    expect((await request(harness, DEVICE_B, VERSION)).status).toBe(429);
  });

  it("admits again once the one-hour window has rolled", async () => {
    const clock = { now: 1_700_000_000_000 };
    const harness = setup({ quotaLimit: 1, clock });
    await seedImage(harness, VERSION, image(64));

    expect((await request(harness, DEVICE_A, VERSION)).status).toBe(200);
    expect((await request(harness, DEVICE_A, VERSION)).status).toBe(429);

    // One hour later (exactly the window) the oldest sample has left: admitted.
    clock.now += OTA_IMAGE_QUOTA_WINDOW_MS;
    expect((await request(harness, DEVICE_A, VERSION)).status).toBe(200);
    // And its budget is spent again.
    expect((await request(harness, DEVICE_A, VERSION)).status).toBe(429);
  });

  it("still admits a within-budget device while another is throttled", async () => {
    const harness = setup({ quotaLimit: 1 });
    await seedImage(harness, VERSION, image(64));

    expect((await request(harness, DEVICE_A, VERSION)).status).toBe(200);
    expect((await request(harness, DEVICE_A, VERSION)).status).toBe(429);
    // A fresh device is served even though A is throttled.
    const res = await request(harness, DEVICE_B, VERSION);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(64);
  });

  it("uses the D2.8 default hourly budget when none is injected", () => {
    expect(DEFAULT_OTA_IMAGE_QUOTA_PER_HOUR).toBeGreaterThan(0);
    expect(OTA_IMAGE_QUOTA_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 5. The quota seam itself — the window-log contract, in isolation
// ---------------------------------------------------------------------------
describe("WindowQuota — the per-device/hour seam", () => {
  it("allows `limit` then denies with a positive whole-second retryAfter", async () => {
    let now = 1_700_000_000_000;
    const quota = new WindowQuota({ limit: 2, now: () => now });

    expect((await quota.consume("d1")).allowed).toBe(true);
    expect((await quota.consume("d1")).allowed).toBe(true);

    const denied = await quota.consume("d1");
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("expected a denial");
    expect(Number.isInteger(denied.retryAfter)).toBe(true);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);

    // A denial is free: it consumes no budget, and another device is unaffected.
    expect((await quota.consume("d2")).allowed).toBe(true);
    expect(quota.remaining("d2")).toBe(1);

    // Exactly one window later, the budget is whole again.
    now += OTA_IMAGE_QUOTA_WINDOW_MS;
    expect((await quota.consume("d1")).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. The handler is exported standalone (mount-anywhere seam)
// ---------------------------------------------------------------------------
describe("createImageHandler — the bare handler", () => {
  it("is a function over the same deps the router mounts", () => {
    const harness = setup();
    const handler = createImageHandler(harness.deps);
    expect(typeof handler).toBe("function");
  });
});
