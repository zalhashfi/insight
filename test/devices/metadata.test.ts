import { describe, expect, it } from "vitest";
import {
  DEVICE_MANAGE_PERMISSION,
  DEVICE_STATUSES,
  DeviceError,
  DeviceMetadataService,
  INGEST_REFUSED,
  InMemoryDeviceRepo,
  InMemoryMembershipLookup,
  assertIngestible,
  checkIngestible,
  isDeviceError,
  isDeviceStatus,
  type Device,
  type DeviceRepo,
  type DeviceStatus,
} from "../../worker/src/domains/devices/metadata";

/**
 * Spec tests for device metadata lifecycle (FR-DEV-04/05, task A17).
 *
 * The domain talks to the {@link DeviceRepo} seam and the membership seam, so
 * these tests drive two in-memory fakes. Contracts asserted:
 *
 *   1. **Storage & read-back** — model/location/note/status/name round-trip;
 *      a partial patch touches only the fields it names, and `null` clears.
 *   2. **Status transitions** — `active → dormant → retired` are persisted and
 *      readable; an unknown status is refused `400`.
 *   3. **Ingest gate (INV-DEV-status)** — a `retired` device is refused `403`;
 *      a `dormant` device is refused `403`; only `active` may ingest. The
 *      refused set is the documented {@link INGEST_REFUSED} policy.
 *   4. **Authorization** — rename/PATCH and DELETE require owner or admin; a
 *      plain `member` is refused `403`; owner *and* admin both succeed.
 *   5. **Unknown id** — every id-addressed operation is `404` (`device_not_found`).
 *
 * Denials are asserted through the module's documented convention: entry points
 * **throw** a {@link DeviceError} with a stable `code` (never `{ ok:false }`).
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Build a service over fresh fakes with a deterministic clock and id sequence.
 * Returns the repo, the membership seam and the service, plus a helper that
 * creates and returns a device.
 */
function setup() {
  const repo: DeviceRepo = new InMemoryDeviceRepo();
  const membership = new InMemoryMembershipLookup();
  let clock = 1_000;
  let seq = 0;

  // The baseline actor: `u_owner` owns `proj_a`, so non-authorization tests can
  // perform writes without restating a membership fixture. Authorization tests
  // add admin/member/stranger roles on top.
  membership.grant("proj_a", "u_owner", "owner");

  const service = new DeviceMetadataService(repo, {
    membership,
    now: () => (clock += 1_000),
    genId: () => `d_${++seq}`,
  });

  const create = (overrides: Partial<Parameters<DeviceMetadataService["createDevice"]>[0]> = {}) =>
    service.createDevice({
      projectId: "proj_a",
      name: "Greenhouse Gateway",
      ...overrides,
    });

  return { repo, membership, service, create };
}

/** Assert that `fn` rejects with a DeviceError carrying `code`. */
async function expectDenied(fn: () => Promise<unknown>, code: string): Promise<DeviceError> {
  try {
    await fn();
  } catch (err) {
    expect(isDeviceError(err)).toBe(true);
    if (!isDeviceError(err)) throw err;
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`expected DeviceError("${code}") but call resolved`);
}

// ---------------------------------------------------------------------------
// Vocabulary (pure)
// ---------------------------------------------------------------------------

describe("status vocabulary", () => {
  it("is exactly the three lifecycle statuses of FR-DEV-05", () => {
    expect([...DEVICE_STATUSES]).toEqual(["active", "dormant", "retired"]);
  });

  it("recognises only known statuses", () => {
    expect(isDeviceStatus("active")).toBe(true);
    expect(isDeviceStatus("retired")).toBe(true);
    expect(isDeviceStatus("deleted")).toBe(false);
    expect(isDeviceStatus(1)).toBe(false);
  });

  it("documents the ingest policy: only active may ingest", () => {
    expect(INGEST_REFUSED).toEqual({ active: false, dormant: true, retired: true });
  });

  it("gates device management with the project-admin permission", () => {
    // Owner/admin manage devices; a plain member does not. The gate reuses the
    // membership vocabulary rather than minting a second permission.
    expect(DEVICE_MANAGE_PERMISSION).toBe("project:update");
  });
});

// ---------------------------------------------------------------------------
// Storage & read-back
// ---------------------------------------------------------------------------

describe("metadata storage and read-back", () => {
  it("stores and reads back every metadata field", async () => {
    const { service, create } = setup();

    const { device } = await create({
      name: "Loft Sensor",
      model: "ESP32-S3",
      location: "Loft / north wall",
      note: "calibrated 2026-10",
      status: "active",
    });

    expect(device.name).toBe("Loft Sensor");
    expect(device.model).toBe("ESP32-S3");
    expect(device.location).toBe("Loft / north wall");
    expect(device.note).toBe("calibrated 2026-10");
    expect(device.status).toBe("active");
    expect(device.projectId).toBe("proj_a");

    // Read back through a fresh lookup, not just the returned object.
    const read = await service.getDevice(device.id);
    expect(read).toEqual(device);
  });

  it("normalises blank optional fields to null", async () => {
    const { create } = setup();
    const { device } = await create({ name: "Bare", model: "  ", location: undefined });
    expect(device.model).toBeNull();
    expect(device.location).toBeNull();
    expect(device.note).toBeNull();
  });

  it("applies a partial patch and leaves unset fields untouched", async () => {
    const { service, create } = setup();
    const { device } = await create({ name: "Patchy", model: "ESP32", location: "A", note: "n" });

    const updated = await service.updateMetadata(device.id, { location: "B" }, "u_owner");

    expect(updated.location).toBe("B");
    expect(updated.model).toBe("ESP32"); // untouched
    expect(updated.note).toBe("n"); // untouched
    expect(updated.name).toBe("Patchy"); // untouched
    expect(updated.updatedAt).toBeGreaterThan(device.updatedAt);
  });

  it("clears a field with an explicit null", async () => {
    const { service, create } = setup();
    const { device } = await create({ name: "ClearMe", note: "temporary" });

    const updated = await service.updateMetadata(device.id, { note: null }, "u_owner");
    expect(updated.note).toBeNull();
  });

  it("lists only the devices of the requested project", async () => {
    const { service, create } = setup();
    await create({ name: "A1", projectId: "proj_a" });
    await create({ name: "B1", projectId: "proj_b" });

    const a = await service.listDevices("proj_a");
    expect(a.map((d) => d.name)).toEqual(["A1"]);
  });
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

describe("status transitions", () => {
  it("moves active -> dormant -> retired, each persisted", async () => {
    const { service, create } = setup();
    const { device } = await create({ name: "Lifecycle", status: "active" });

    const dormant = await service.updateMetadata(device.id, { status: "dormant" }, "u_owner");
    expect(dormant.status).toBe("dormant");
    expect((await service.getDevice(device.id)).status).toBe("dormant");

    const retired = await service.updateMetadata(device.id, { status: "retired" }, "u_owner");
    expect(retired.status).toBe("retired");
    expect((await service.getDevice(device.id)).status).toBe("retired");
  });

  it("rejects an unknown status as invalid_status (400)", async () => {
    const { service, create } = setup();
    const { device } = await create({ name: "Bad status" });

    const err = await expectDenied(
      () => service.updateMetadata(device.id, { status: "zombie" as DeviceStatus }, "u_owner"),
      "invalid_status",
    );
    expect(err.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Ingest gate (INV-DEV-status)
// ---------------------------------------------------------------------------

describe("ingest gate", () => {
  it("allows an active device to ingest", async () => {
    const { service, create } = setup();
    const { device } = await create({ name: "Writes", status: "active" });

    expect(checkIngestible(device)).toBe(true);
    expect(() => assertIngestible(device)).not.toThrow();
    await expect(service.requireIngestible(device.id)).resolves.toMatchObject({
      id: device.id,
      status: "active",
    });
  });

  it("refuses ingest from a retired device with 403", async () => {
    const { service, create } = setup();
    const { device } = await create({ name: "Decommissioned", status: "retired" });

    const err = await expectDenied(() => service.requireIngestible(device.id), "device_not_ingestible");
    expect(err.status).toBe(403);
    expect(() => assertIngestible(device)).toThrow(DeviceError);
  });

  it("refuses ingest from a dormant device with 403 (documented policy)", async () => {
    const { service, create } = setup();
    const { device } = await create({ name: "Parked", status: "dormant" });

    // Policy: `dormant` is refused too — see INGEST_REFUSED. Asserted, not assumed.
    expect(INGEST_REFUSED.dormant).toBe(true);
    const err = await expectDenied(() => service.requireIngestible(device.id), "device_not_ingestible");
    expect(err.status).toBe(403);
  });

  it("a device that becomes retired stops being ingestible", async () => {
    const { service, create } = setup();
    const { device } = await create({ name: "Was active", status: "active" });
    await expect(service.requireIngestible(device.id)).resolves.toBeTruthy();

    await service.updateMetadata(device.id, { status: "retired" }, "u_owner");
    await expectDenied(() => service.requireIngestible(device.id), "device_not_ingestible");
  });

  it("the standalone gate refuses non-active devices by status alone", async () => {
    const { create } = setup();
    const active: Device = (await create({ name: "A" })).device;
    const retired: Device = (await create({ name: "R", status: "retired" })).device;

    expect(checkIngestible(active)).toBe(true);
    expect(checkIngestible(retired)).toBe(false);
    const err = (() => {
      try {
        assertIngestible(retired);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(isDeviceError(err) && err.status === 403).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Authorization: rename / PATCH / DELETE require owner or admin
// ---------------------------------------------------------------------------

describe("authorization", () => {
  /** A project with an owner, an admin and a plain member. */
  async function threeTier() {
    const harness = setup();
    const { device } = await harness.create({ name: "Managed" });
    harness.membership.grant("proj_a", "u_owner", "owner");
    harness.membership.grant("proj_a", "u_admin", "admin");
    harness.membership.grant("proj_a", "u_member", "member");
    return { ...harness, device };
  }

  it("rename by a member is refused 403 (forbidden)", async () => {
    const { service, device } = await threeTier();
    const err = await expectDenied(() => service.rename(device.id, "Nope", "u_member"), "forbidden");
    expect(err.status).toBe(403);
  });

  it("rename by an owner and by an admin succeeds", async () => {
    const { service, device } = await threeTier();
    const byAdmin = await service.rename(device.id, "Renamed by admin", "u_admin");
    expect(byAdmin.name).toBe("Renamed by admin");
    const byOwner = await service.rename(device.id, "Renamed by owner", "u_owner");
    expect(byOwner.name).toBe("Renamed by owner");
  });

  it("PATCH (updateMetadata) by a member is refused 403; owner/admin succeed", async () => {
    const { service, device } = await threeTier();
    await expectDenied(
      () => service.updateMetadata(device.id, { model: "hacked" }, "u_member"),
      "forbidden",
    );
    const byAdmin = await service.updateMetadata(device.id, { model: "ESP32" }, "u_admin");
    expect(byAdmin.model).toBe("ESP32");
    const byOwner = await service.updateMetadata(device.id, { status: "dormant" }, "u_owner");
    expect(byOwner.status).toBe("dormant");
  });

  it("DELETE by a member is refused 403; by owner succeeds", async () => {
    const { service, repo, device } = await threeTier();
    const err = await expectDenied(() => service.delete(device.id, "u_member"), "forbidden");
    expect(err.status).toBe(403);
    // The device is still present — a refused delete writes nothing.
    expect(await repo.get(device.id)).not.toBeNull();

    await expect(service.delete(device.id, "u_owner")).resolves.toBeUndefined();
    expect(await repo.get(device.id)).toBeNull();
  });

  it("reports a non-member as not_a_member (still 403)", async () => {
    const { service, device } = await threeTier();
    const err = await expectDenied(() => service.rename(device.id, "x", "u_stranger"), "not_a_member");
    expect(err.status).toBe(403);
  });

  it("a role in another project grants nothing here (cross-tenant)", async () => {
    const { service, membership, device } = await threeTier();
    // u_foreign owns proj_b — a role that must not reach a proj_a device.
    membership.grant("proj_b", "u_foreign", "owner");
    const err = await expectDenied(() => service.delete(device.id, "u_foreign"), "not_a_member");
    expect(err.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Unknown device id -> 404
// ---------------------------------------------------------------------------

describe("unknown device id", () => {
  it("getDevice reports device_not_found (404)", async () => {
    const { service } = setup();
    const err = await expectDenied(() => service.getDevice("d_missing"), "device_not_found");
    expect(err.status).toBe(404);
  });

  it("rename / updateMetadata / delete / requireIngestible on an unknown id are all 404", async () => {
    const { service } = setup();
    const unknown = "d_ghost";
    for (const call of [
      () => service.rename(unknown, "x", "u_owner"),
      () => service.updateMetadata(unknown, { model: "m" }, "u_owner"),
      () => service.delete(unknown, "u_owner"),
      () => service.requireIngestible(unknown),
    ]) {
      const err = await expectDenied(call, "device_not_found");
      expect(err.status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("requires a non-blank name and projectId", async () => {
    const { service } = setup();
    await expectDenied(
      () => service.createDevice({ projectId: "proj_a", name: "   " }),
      "invalid_input",
    );
    await expectDenied(
      () => service.createDevice({ projectId: "  ", name: "ok" }),
      "invalid_input",
    );
  });

  it("refuses a duplicate id", async () => {
    const { service } = setup();
    await service.createDevice({ projectId: "proj_a", name: "One", id: "d_dup" });
    await expectDenied(
      () => service.createDevice({ projectId: "proj_a", name: "Two", id: "d_dup" }),
      "device_exists",
    );
  });

  it("rename refuses a blank name", async () => {
    const { service, create } = setup();
    const { device } = await create({ name: "Named" });
    await expectDenied(() => service.rename(device.id, "  ", "u_owner"), "invalid_input");
  });
});
