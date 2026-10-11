/**
 * Spec tests for firmware upload (A18 — FR-OTA-01, NFR-SEC-03).
 *
 * The domain talks to two injected seams, so these tests drive two in-memory
 * fakes and assert the *external* effects (what is in the store, what is in the
 * table) rather than the service's internals:
 *
 *   1. **Happy path** — a ≤8 MiB image produces a `firmware` row whose
 *      `sha256` equals a digest recomputed by the test, and the exact bytes are
 *      placed at the deterministic key `firmware/<projectId>/<version>.bin`.
 *   2. **Size gate** — a body strictly greater than 8 MiB is refused `413`
 *      (`payload_too_large`) and **nothing** is stored: no object, no row.
 *   3. **Re-upload (documented determinism)** — the default policy is REPLACE:
 *      the same version overwrites the object and upserts the row in place.
 *      The opt-in `conflict: "reject"` policy is the loud alternative (`409`),
 *      asserted on both a fresh key and a stale one.
 *   4. **Digest shape** — `sha256` is lowercase hex, exactly 64 characters, and
 *      provably a *real* digest (it matches WebCrypto's own output, and a
 *      one-byte change moves it).
 */

import { describe, expect, it } from "vitest";
import {
  FIRMWARE_CONTENT_TYPE,
  FIRMWARE_KEY_PREFIX,
  FIRMWARE_STATUS_CODE,
  FirmwareError,
  FirmwareUploadService,
  InMemoryFirmwareRepo,
  InMemoryImageStore,
  MAX_FIRMWARE_BYTES,
  SHA256_HEX_LENGTH,
  SHA256_HEX_PATTERN,
  bytesToHex,
  firmwareKey,
  isFirmwareError,
  sha256Hex,
  uploadFirmwareFromBody,
  type FirmwareRepo,
  type ImageStore,
} from "../../worker/src/domains/firmware/upload";

const PROJECT = "proj_a";
const VERSION = "1.2.0";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Build a service over fresh fakes with a deterministic clock and id sequence.
 * Returns the store, the repo and the service plus the raw seams, so a test can
 * assert on stored objects/rows and prove "nothing was stored".
 */
function setup(options: { conflict?: "replace" | "reject" } = {}) {
  const store: ImageStore = new InMemoryImageStore();
  const repo: FirmwareRepo = new InMemoryFirmwareRepo();
  let clock = 1_000;
  let seq = 0;

  const service = new FirmwareUploadService({
    store,
    repo,
    ...options,
    now: () => (clock += 1_000),
    genId: () => `fw_${++seq}`,
  });

  // Narrow to the concrete fakes for assertion helpers while keeping the
  // service typed against the seams.
  const imageStore = store as InMemoryImageStore;
  const firmwareRepo = repo as InMemoryFirmwareRepo;
  return { service, store: imageStore, repo: firmwareRepo };
}

/** Deterministic, incompressible-looking bytes without a real RNG. */
function image(bytes: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length: bytes }, (_, i) => (i * 31 + seed * 7) & 0xff);
}

/** Recompute the digest the way an independent verifier (a device) would. */
async function recompute(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).slice().buffer);
  return bytesToHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// 0. Deterministic key derivation
// ---------------------------------------------------------------------------
describe("firmwareKey — the deterministic object key", () => {
  it("is `firmware/<projectId>/<version>.bin` with no clock or randomness", () => {
    expect(firmwareKey("proj_a", "1.2.0")).toBe("firmware/proj_a/1.2.0.bin");
    expect(FIRMWARE_KEY_PREFIX).toBe("firmware");
    // Pure: the same arguments always yield the same key, so a re-upload and a
    // later image stream (A18c) agree without shared state.
    expect(firmwareKey("proj_a", "1.2.0")).toBe(firmwareKey("proj_a", "1.2.0"));
    // The tenant is part of the path, so two projects never collide.
    expect(firmwareKey("proj_a", "1.2.0")).not.toBe(firmwareKey("proj_b", "1.2.0"));
  });
});

// ---------------------------------------------------------------------------
// 1. Happy path: ≤ 8 MiB → row + object at the key
// ---------------------------------------------------------------------------
describe("upload — happy path (≤ 8 MiB)", () => {
  it("stores the exact bytes at the key and records size/sha256/r2Key", async () => {
    const { service, store } = setup();
    const bytes = image(4096);

    const result = await service.upload({ projectId: PROJECT, version: VERSION, body: bytes });

    // The key is the deterministic one, and the object is the byte-exact image.
    const key = "firmware/proj_a/1.2.0.bin";
    expect(result.key).toBe(key);
    expect(result.firmware.r2Key).toBe(key);
    const stored = store.get(key);
    expect(stored).toBeDefined();
    expect(stored?.body).toEqual(bytes);
    expect(stored?.contentType).toBe(FIRMWARE_CONTENT_TYPE);
    expect(store.keys()).toEqual([key]);
  });

  it("records a sha256 that matches an independently recomputed digest", async () => {
    const { service } = setup();
    const bytes = image(65_536);

    const { firmware } = await service.upload({ projectId: PROJECT, version: VERSION, body: bytes });

    expect(firmware.sha256).toBe(await recompute(bytes));
    // …and equals the module's own hasher, i.e. it is a real SHA-256 of the body.
    expect(firmware.sha256).toBe(await sha256Hex(bytes));
  });

  it("records the exact byte length as `size` (what §6.5 compares against)", async () => {
    const { service } = setup();
    const bytes = image(1234);

    const { firmware } = await service.upload({ projectId: PROJECT, version: VERSION, body: bytes });

    expect(firmware.size).toBe(bytes.byteLength);
    expect(firmware.size).toBe(1234);
  });

  it("accepts a body of exactly 8 MiB (the limit is inclusive)", async () => {
    const { service, store } = setup();
    const bytes = image(MAX_FIRMWARE_BYTES, 3);

    const result = await service.upload({ projectId: PROJECT, version: VERSION, body: bytes });

    expect(result.firmware.size).toBe(MAX_FIRMWARE_BYTES);
    expect(store.get(result.key)?.body.byteLength).toBe(MAX_FIRMWARE_BYTES);
  });
});

// ---------------------------------------------------------------------------
// 2. Size gate: > 8 MiB → 413, nothing stored
// ---------------------------------------------------------------------------
describe("upload — size gate (> 8 MiB → 413)", () => {
  it("refuses an oversized image with 413 payload_too_large", async () => {
    const { service } = setup();
    const bytes = image(MAX_FIRMWARE_BYTES + 1);

    const failure = await service
      .upload({ projectId: PROJECT, version: VERSION, body: bytes })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(FirmwareError);
    expect(isFirmwareError(failure)).toBe(true);
    if (!isFirmwareError(failure)) throw new Error("expected a FirmwareError");
    expect(failure.code).toBe("payload_too_large");
    expect(failure.status).toBe(413);
    expect(FIRMWARE_STATUS_CODE.payload_too_large).toBe(413);
  });

  it("stores NOTHING when the body is rejected: no object, no row", async () => {
    const { service, store, repo } = setup();

    await expect(
      service.upload({ projectId: PROJECT, version: VERSION, body: image(MAX_FIRMWARE_BYTES + 100) }),
    ).rejects.toBeInstanceOf(FirmwareError);

    // No put was even attempted, and no row was written.
    expect(store.puts).toEqual([]);
    expect(store.keys()).toEqual([]);
    expect(repo.all()).toEqual([]);
    expect(await repo.find(PROJECT, VERSION)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Re-upload: deterministic — REPLACE by default, REJECT opt-in
// ---------------------------------------------------------------------------
describe("upload — re-upload of the same version (deterministic)", () => {
  it("DEFAULT (replace): overwrites the object and upserts the row in place", async () => {
    const { service, store, repo } = setup();
    const first = image(2048, 1);
    const second = image(4096, 2);

    const a = await service.upload({ projectId: PROJECT, version: VERSION, body: first });
    const b = await service.upload({ projectId: PROJECT, version: VERSION, body: second });

    // Same key, same row id — one object, one row, but the LATEST content.
    expect(b.key).toBe(a.key);
    expect(b.firmware.id).toBe(a.firmware.id);
    expect(b.replaced).toBe(true);
    expect(a.replaced).toBe(false);

    expect(store.keys()).toEqual([a.key]);
    expect(store.get(a.key)?.body).toEqual(second);
    expect(store.puts.map((p) => p.bytes)).toEqual([2048, 4096]);

    const rows = repo.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].size).toBe(4096);
    expect(rows[0].sha256).toBe(await recompute(second));
    expect(rows[0].updatedAt).toBeGreaterThan(rows[0].createdAt);
  });

  it("re-uploading identical bytes is a byte-for-byte no-op in content and digest", async () => {
    const { service, store } = setup();
    const bytes = image(8192, 5);

    const a = await service.upload({ projectId: PROJECT, version: VERSION, body: bytes });
    const b = await service.upload({ projectId: PROJECT, version: VERSION, body: image(8192, 5) });

    expect(a.firmware.sha256).toBe(b.firmware.sha256);
    expect(store.get(a.key)?.body).toEqual(bytes);
  });

  it('OPT-IN (conflict: "reject"): refuses 409 firmware_exists and stores nothing new', async () => {
    const { service, store, repo } = setup({ conflict: "reject" });
    const first = image(1024, 1);

    const a = await service.upload({ projectId: PROJECT, version: VERSION, body: first });
    const before = store.puts.length;

    await expect(
      service.upload({ projectId: PROJECT, version: VERSION, body: image(2048, 2) }),
    ).rejects.toMatchObject({ code: "firmware_exists", status: 409 });

    // The first object stands, no second put happened, and the row is unchanged.
    expect(store.puts.length).toBe(before);
    expect(store.get(a.key)?.body).toEqual(first);
    expect(repo.all()).toHaveLength(1);
    expect(repo.all()[0].size).toBe(1024);
  });

  it('OPT-IN (conflict: "reject") still accepts a NEW version', async () => {
    const { service, store, repo } = setup({ conflict: "reject" });

    await service.upload({ projectId: PROJECT, version: "1.2.0", body: image(1024, 1) });
    const b = await service.upload({ projectId: PROJECT, version: "1.3.0", body: image(1024, 2) });

    expect(b.key).toBe("firmware/proj_a/1.3.0.bin");
    expect(store.keys().sort()).toEqual(["firmware/proj_a/1.2.0.bin", "firmware/proj_a/1.3.0.bin"]);
    expect(repo.all()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. sha256 shape: lowercase 64-hex
// ---------------------------------------------------------------------------
describe("sha256 — lowercase, 64-hex, and actually the image's digest", () => {
  it("is exactly 64 lowercase hex characters", async () => {
    const { service } = setup();

    const { firmware } = await service.upload({
      projectId: PROJECT,
      version: VERSION,
      body: image(777),
    });

    expect(firmware.sha256).toHaveLength(SHA256_HEX_LENGTH);
    expect(SHA256_HEX_LENGTH).toBe(64);
    expect(firmware.sha256).toMatch(SHA256_HEX_PATTERN);
    expect(firmware.sha256).toBe(firmware.sha256.toLowerCase());
  });

  it("changes when one byte of the image changes (it hashes the bytes, not a label)", async () => {
    const { service } = setup();
    const base = image(512, 1);
    const tweaked = image(512, 1);
    tweaked[0] = (tweaked[0] + 1) & 0xff;

    const a = await service.upload({ projectId: PROJECT, version: "1.0.0", body: base });
    const b = await service.upload({ projectId: PROJECT, version: "1.0.1", body: tweaked });

    expect(a.firmware.sha256).not.toBe(b.firmware.sha256);
  });

  it("hashes exactly the bytes put, even when handed a view into a larger buffer", async () => {
    const { service, store } = setup();
    const backing = image(1024, 4);
    const view = backing.subarray(100, 300); // a 200-byte window, not the whole buffer

    const { firmware, key } = await service.upload({
      projectId: PROJECT,
      version: VERSION,
      body: view,
    });

    expect(firmware.size).toBe(200);
    expect(firmware.sha256).toBe(await recompute(view));
    expect(store.get(key)?.body).toEqual(view);
  });
});

// ---------------------------------------------------------------------------
// 5. Input guards & the Blob/ArrayBuffer adapter
// ---------------------------------------------------------------------------
describe("upload — input guards", () => {
  it("refuses a blank projectId with 400 invalid_input", async () => {
    const { service, store, repo } = setup();

    await expect(
      service.upload({ projectId: "   ", version: VERSION, body: image(16) }),
    ).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    expect(store.puts).toEqual([]);
    expect(repo.all()).toEqual([]);
  });

  it("refuses a blank version with 400 invalid_input", async () => {
    const { service } = setup();

    await expect(
      service.upload({ projectId: PROJECT, version: "", body: image(16) }),
    ).rejects.toMatchObject({ code: "invalid_input", status: 400 });
  });
});

describe("uploadFirmwareFromBody — request-body adapter", () => {
  it("adapts an ArrayBuffer and a Blob to the same bytes as a Uint8Array", async () => {
    const bytes = image(300, 9);
    const fromBuffer = await uploadFirmwareFromBody(bytes.slice().buffer);
    const fromBlob = await uploadFirmwareFromBody(new Blob([bytes.slice().buffer]));

    expect(fromBuffer).toEqual(bytes);
    expect(fromBlob).toEqual(bytes);
    // A Uint8Array passes straight through (no copy).
    expect(await uploadFirmwareFromBody(bytes)).toBe(bytes);
  });
});
