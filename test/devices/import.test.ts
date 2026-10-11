import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPORT_LIMITS,
  DEVICE_IMPORT_FIELDS,
  DeviceImportError,
  DeviceImportService,
  canonicalField,
  importDevices,
  isDeviceImportError,
  parseCsv,
  parseImportFormat,
  type DeviceImportResult,
} from "../../worker/src/domains/devices/import";
import {
  DeviceMetadataService,
  InMemoryDeviceRepo,
  InMemoryMembershipLookup,
  type Device,
  type DeviceRepo,
} from "../../worker/src/domains/devices/metadata";

/**
 * Spec tests for bulk device import (FR-DEV-06, task A34).
 *
 * The import is driven against the SAME seams `metadata.test.ts` uses — an
 * in-memory {@link DeviceRepo} and a deterministic id sequence — so an imported
 * device is asserted to be indistinguishable from one created through
 * `createDevice` directly. Contracts asserted:
 *
 *   1. **Counts & shape** — an import adds exactly N devices; created rows are
 *      reported in source order.
 *   2. **Failed rows carry a reason** — a bad row is reported with a stable
 *      code and a message, and is *not* created.
 *   3. **No partial device** — after any import, every device in the repo is a
 *      complete record (id/key/name/status/timestamps all present), and the set
 *      equals exactly the reported `created` rows.
 *   4. **Determinism** — the same input yields the same `created`/`failed`
 *      split; a duplicated explicit id is won by the FIRST row in source order.
 *   5. **CSV lexing** — RFC 4180 quoting, separator sniffing, BOM, blank lines.
 *   6. **JSON lexing** — bare array and `{ devices: [...] }`; unknown keys and
 *      non-object elements are handled without aborting the good rows.
 *   7. **Whole-file refusals** — a malformed file, an empty body and an
 *      over-limit batch throw a {@link DeviceImportError} (no rows written).
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Build an import service over a fresh in-memory repo with a deterministic id
 * sequence, plus the metadata service it delegates writes to. Returns the repo
 * (to inspect what really landed) and the import service.
 */
function setup() {
  const repo: DeviceRepo = new InMemoryDeviceRepo();
  const membership = new InMemoryMembershipLookup();
  let clock = 1_000;
  let seq = 0;

  const devices = new DeviceMetadataService(repo, {
    membership,
    now: () => (clock += 1_000),
    genId: () => `d_${++seq}`,
  });
  const importer = new DeviceImportService(devices);

  return { repo, devices, importer };
}

/** Assert every device stored by `repo` is a complete, non-partial record. */
async function assertComplete(repo: DeviceRepo, projectId: string): Promise<readonly Device[]> {
  const stored = await repo.listByProject(projectId);
  for (const device of stored) {
    expect(device.id).toBeTruthy();
    expect(device.key).toBeTruthy();
    expect(device.name.trim().length).toBeGreaterThan(0);
    expect(["active", "dormant", "retired"]).toContain(device.status);
    expect(device.createdAt).toBeGreaterThan(0);
    expect(device.updatedAt).toBeGreaterThan(0);
    expect(device.projectId).toBe(projectId);
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Pure vocabulary
// ---------------------------------------------------------------------------

describe("format vocabulary", () => {
  it("names exactly the two supported formats", () => {
    expect(parseImportFormat("csv")).toBe("csv");
    expect(parseImportFormat("json")).toBe("json");
  });

  it("accepts the usual aliases and content types case-insensitively", () => {
    expect(parseImportFormat("CSV")).toBe("csv");
    expect(parseImportFormat("text/csv")).toBe("csv");
    expect(parseImportFormat(" application/json ")).toBe("json");
    expect(parseImportFormat("application/vnd.api+json")).toBe("json");
  });

  it("rejects anything it does not recognise", () => {
    expect(parseImportFormat("xml")).toBeNull();
    expect(parseImportFormat("")).toBeNull();
    expect(parseImportFormat(undefined)).toBeNull();
    expect(parseImportFormat(null)).toBeNull();
  });

  it("documents the accepted column set", () => {
    expect([...DEVICE_IMPORT_FIELDS]).toEqual([
      "id",
      "key",
      "name",
      "model",
      "location",
      "note",
      "status",
    ]);
  });

  it("maps header aliases onto canonical fields", () => {
    expect(canonicalField("Device Name")).toBe("name");
    expect(canonicalField("device_name")).toBe("name");
    expect(canonicalField("deviceName")).toBe("name");
    expect(canonicalField("MODEL")).toBe("model");
    expect(canonicalField("device-id")).toBe("id");
    expect(canonicalField("comment")).toBe("note");
    expect(canonicalField("lifecycle")).toBe("status");
    expect(canonicalField("unrelated")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CSV lexing (pure)
// ---------------------------------------------------------------------------

describe("CSV lexing", () => {
  it("honours RFC 4180 quoting", () => {
    const records = parseCsv('name,location\n"Loft, north","Room ""B"""\n');
    expect(records).toEqual([
      ["name", "location"],
      ["Loft, north", 'Room "B"'],
    ]);
  });

  it("supports a quoted cell containing a newline", () => {
    const records = parseCsv('name,note\n"A","line one\nline two"\n');
    expect(records[1]).toEqual(["A", "line one\nline two"]);
  });

  it("handles CRLF and bare LF identically", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual(parseCsv("a,b\n1,2\n"));
  });

  it("strips a leading BOM", () => {
    expect(parseCsv("\uFEFFname\nAlpha\n")).toEqual([["name"], ["Alpha"]]);
  });

  it("does not fabricate a trailing empty record", () => {
    expect(parseCsv("name\nAlpha\n")).toEqual([["name"], ["Alpha"]]);
  });

  it("parses against an explicit separator", () => {
    expect(parseCsv("name;location\nA;B\n", ";")).toEqual([
      ["name", "location"],
      ["A", "B"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// JSON import
// ---------------------------------------------------------------------------

describe("JSON import", () => {
  it("adds N devices from an array of objects", async () => {
    const { importer, repo } = setup();
    const data = JSON.stringify([
      { name: "Alpha", model: "ESP32", location: "Roof", status: "active" },
      { name: "Beta", note: "spare" },
      { name: "Gamma", status: "dormant" },
    ]);

    const result = await importer.importDevices({ projectId: "proj_a", data, format: "json" });

    expect(result.created).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.totalRows).toBe(3);
    expect(result.created.map((d) => d.name)).toEqual(["Alpha", "Beta", "Gamma"]);

    // The count is real: the repo holds exactly the reported devices.
    const stored = await assertComplete(repo, "proj_a");
    expect(stored.map((d) => d.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(stored).toHaveLength(3);
  });

  it("accepts an object with a `devices` array", async () => {
    const { importer } = setup();
    const data = JSON.stringify({ devices: [{ name: "Only" }] });
    const result = await importer.importDevices({ projectId: "proj_a", data, format: "json" });
    expect(result.created.map((d) => d.name)).toEqual(["Only"]);
  });

  it("persists every metadata field and normalises blanks to null", async () => {
    const { importer } = setup();
    const data = JSON.stringify([
      {
        id: "dev-1",
        key: "wire-1",
        name: "Full",
        model: "ESP32-S3",
        location: "Loft",
        note: "calibrated",
        status: "dormant",
      },
      { name: "Blank", model: "   ", location: "", note: null },
    ]);

    const result = await importer.importDevices({ projectId: "proj_a", data, format: "json" });

    expect(result.created[0]).toMatchObject({
      id: "dev-1",
      key: "wire-1",
      name: "Full",
      model: "ESP32-S3",
      location: "Loft",
      note: "calibrated",
      status: "dormant",
    });
    expect(result.created[1]).toMatchObject({ name: "Blank", model: null, location: null, note: null });
    expect(result.created[1].status).toBe("active"); // documented default
  });

  it("defaults the wire key to the id when omitted", async () => {
    const { importer } = setup();
    const data = JSON.stringify([{ id: "dev-9", name: "Keyless" }]);
    const result = await importer.importDevices({ projectId: "proj_a", data, format: "json" });
    expect(result.created[0].key).toBe("dev-9");
  });

  it("ignores unknown keys without failing the row", async () => {
    const { importer } = setup();
    const data = JSON.stringify([{ name: "Kept", colour: "green", firmware: "1.2.3" }]);
    const result = await importer.importDevices({ projectId: "proj_a", data, format: "json" });
    expect(result.created).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  it("reports a non-object element at its index and still imports the rest", async () => {
    const { importer } = setup();
    const data = JSON.stringify([{ name: "Good" }, 42, { name: "Also good" }]);

    const result = await importer.importDevices({ projectId: "proj_a", data, format: "json" });

    expect(result.created.map((d) => d.name)).toEqual(["Good", "Also good"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ row: 2, code: "missing_name" });
  });
});

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

describe("CSV import", () => {
  it("adds N devices from a header row", async () => {
    const { importer, repo } = setup();
    const data = [
      "id,name,model,location,note,status",
      "dev-1,Alpha,ESP32,Roof,primary,active",
      "dev-2,Beta,ESP8266,Shed,,dormant",
      "dev-3,Gamma,,,,",
    ].join("\n");

    const result = await importer.importDevices({ projectId: "proj_a", data, format: "csv" });

    expect(result.created).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.created[0]).toMatchObject({
      id: "dev-1",
      name: "Alpha",
      model: "ESP32",
      location: "Roof",
      note: "primary",
      status: "active",
    });
    expect(result.created[1]).toMatchObject({ id: "dev-2", model: "ESP8266", location: "Shed" });
    expect(result.created[2]).toMatchObject({ id: "dev-3", status: "active" });

    expect(await assertComplete(repo, "proj_a")).toHaveLength(3);
  });

  it("tolerates headers that match an alias and differ in case", async () => {
    const { importer } = setup();
    const data = "Device Name;MODEL;Device Key\nAlpha;ESP32;wire-1\n";
    const result = await importer.importDevices({ projectId: "proj_a", data, format: "csv" });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ name: "Alpha", model: "ESP32", key: "wire-1" });
  });

  it("keeps a quoted field containing the separator intact", async () => {
    const { importer } = setup();
    const data = 'name,location\n"Loft, north","Room ""B"""\n';
    const result = await importer.importDevices({ projectId: "proj_a", data, format: "csv" });
    expect(result.created[0]).toMatchObject({ name: "Loft, north", location: 'Room "B"' });
  });

  it("skips blank lines between records", async () => {
    const { importer } = setup();
    const data = "name\nAlpha\n\nBeta\n";
    const result = await importer.importDevices({ projectId: "proj_a", data, format: "csv" });
    expect(result.created.map((d) => d.name)).toEqual(["Alpha", "Beta"]);
  });

  it("numbers reported rows by their file line, not their position in the compacted list", async () => {
    const { importer } = setup();
    // Line 1 is the header, line 2 is Alpha, line 3 is blank, line 4 is the bad
    // row. The blank line must NOT renumber the bad row down to 3 — the
    // operator needs the line they can jump to.
    const data = "name\nAlpha\n\n,zombie\n";
    const result = await importer.importDevices({ projectId: "proj_a", data, format: "csv" });
    expect(result.created.map((d) => d.name)).toEqual(["Alpha"]);
    expect(result.failed[0].row).toBe(4);
  });

  it("handles CRLF line endings", async () => {
    const { importer } = setup();
    const data = "name,status\r\nAlpha,retired\r\n";
    const result = await importer.importDevices({ projectId: "proj_a", data, format: "csv" });
    expect(result.created[0]).toMatchObject({ name: "Alpha", status: "retired" });
  });
});

// ---------------------------------------------------------------------------
// Failed rows: reported with a reason, and nothing written for them
// ---------------------------------------------------------------------------

describe("failed rows are reported with a reason", () => {
  it("reports a missing name", async () => {
    const { importer, repo } = setup();
    const data = JSON.stringify([{ name: "Good" }, { model: "ESP32" }]);

    const result = await importer.importDevices({ projectId: "proj_a", data, format: "json" });

    expect(result.failed).toEqual([
      { row: 2, code: "missing_name", message: expect.stringContaining("name is required") },
    ]);
    // Only the good row landed.
    expect((await assertComplete(repo, "proj_a")).map((d) => d.name)).toEqual(["Good"]);
  });

  it("reports an unknown lifecycle status, naming the value", async () => {
    const { importer } = setup();
    const data = JSON.stringify([{ name: "Ghost", status: "archived" }]);

    const result = await importer.importDevices({ projectId: "proj_a", data, format: "json" });

    expect(result.failed[0].code).toBe("unknown_status");
    expect(result.failed[0].message).toContain("archived");
    expect(result.created).toHaveLength(0);
  });

  it("reports a duplicate id inside the file; the FIRST row wins", async () => {
    const { importer, repo } = setup();
    const data = JSON.stringify([
      { id: "dup", name: "First" },
      { id: "dup", name: "Second" },
      { id: "other", name: "Third" },
    ]);

    const result = await importer.importDevices({ projectId: "proj_a", data, format: "json" });

    expect(result.created.map((d) => d.name)).toEqual(["First", "Third"]);
    expect(result.failed).toEqual([
      { row: 2, code: "duplicate_id", message: expect.stringContaining("dup") },
    ]);
    // Deterministic: the surviving "dup" really is the first row's.
    const stored = await repo.get("dup");
    expect(stored?.name).toBe("First");
  });

  it("reports a collision with an existing device as device_exists", async () => {
    const { importer, devices, repo } = setup();
    await devices.createDevice({ projectId: "proj_a", id: "taken", name: "Existing" });

    const data = JSON.stringify([{ id: "taken", name: "Clash" }, { id: "fresh", name: "New" }]);
    const result = await importer.importDevices({ projectId: "proj_a", data, format: "json" });

    expect(result.failed[0]).toMatchObject({ row: 1, code: "device_exists" });
    expect(result.created.map((d) => d.name)).toEqual(["New"]);
    // The existing device was NOT overwritten.
    expect((await repo.get("taken"))?.name).toBe("Existing");
  });

  it("keeps the created set exactly equal to the reported created rows", async () => {
    const { importer, repo } = setup();
    const data = [
      "name,status",
      "Alpha,active",
      ",active", // missing name
      "Bravo,zombie", // unknown status
      "Charlie,retired",
    ].join("\n");

    const result: DeviceImportResult = await importer.importDevices({
      projectId: "proj_a",
      data,
      format: "csv",
    });

    const stored = await repo.listByProject("proj_a");
    expect(stored.map((d) => d.name)).toEqual(result.created.map((d) => d.name));
    expect(stored.map((d) => d.name)).toEqual(["Alpha", "Charlie"]);
    // Header is record 1, so the bad rows sit at records 3 and 4.
    expect(result.failed.map((f) => f.row)).toEqual([3, 4]);
    expect(result.failed.map((f) => f.code)).toEqual(["missing_name", "unknown_status"]);
  });
});

// ---------------------------------------------------------------------------
// No partial device — the acceptance invariant
// ---------------------------------------------------------------------------

describe("no partial device exists", () => {
  it("writes a complete record for every successful row", async () => {
    const { importer, repo } = setup();
    const data = JSON.stringify([
      { name: "One" },
      { name: "Two", model: "ESP32" },
      { name: "Three", status: "retired" },
    ]);

    await importer.importDevices({ projectId: "proj_a", data, format: "json" });

    const stored = await assertComplete(repo, "proj_a");
    expect(stored).toHaveLength(3);
  });

  it("leaves nothing behind for a rejected row", async () => {
    const { importer, repo } = setup();
    // A row that would be valid only if it could be half-written: it has a
    // model but no name, so the whole row must be discarded, not partially kept.
    const data = JSON.stringify([{ model: "ESP32", location: "Roof", status: "active" }]);

    const result = await importer.importDevices({ projectId: "proj_a", data, format: "json" });

    expect(result.created).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(await repo.listByProject("proj_a")).toEqual([]);
  });

  it("scopes every imported device to the target project", async () => {
    const { importer, repo } = setup();
    await importer.importDevices({
      projectId: "proj_a",
      data: JSON.stringify([{ name: "A" }]),
      format: "json",
    });

    expect(await repo.listByProject("proj_b")).toEqual([]);
    expect(await assertComplete(repo, "proj_a")).toHaveLength(1);
  });

  it("an import is idempotent-by-report: re-running the same file collides, not duplicates", async () => {
    const { importer, repo } = setup();
    const data = JSON.stringify([{ id: "k1", name: "Once" }, { id: "k2", name: "Twice" }]);

    const first = await importer.importDevices({ projectId: "proj_a", data, format: "json" });
    expect(first.created).toHaveLength(2);

    const second = await importer.importDevices({ projectId: "proj_a", data, format: "json" });
    expect(second.created).toHaveLength(0);
    expect(second.failed.map((f) => f.code)).toEqual(["device_exists", "device_exists"]);
    // No duplicate records were created by the rerun.
    expect(await repo.listByProject("proj_a")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("produces the same split for the same input, twice over", async () => {
    const data = JSON.stringify([
      { id: "a", name: "Alpha" },
      { name: "" },
      { id: "a", name: "Alpha again" },
      { name: "Beta", status: "bad" },
      { name: "Gamma" },
    ]);

    const one = await setup().importer.importDevices({ projectId: "proj_a", data, format: "json" });
    const two = await setup().importer.importDevices({ projectId: "proj_a", data, format: "json" });

    expect(one.created.map((d) => d.name)).toEqual(two.created.map((d) => d.name));
    expect(one.created.map((d) => d.name)).toEqual(["Alpha", "Gamma"]);
    expect(one.failed.map((f) => f.row)).toEqual(two.failed.map((f) => f.row));
    expect(one.failed.map((f) => f.row)).toEqual([2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Whole-file refusals (throw, nothing written)
// ---------------------------------------------------------------------------

describe("whole-file refusals", () => {
  /** Assert `fn` rejects with a {@link DeviceImportError} carrying `code`. */
  async function expectImportError(
    fn: () => Promise<unknown>,
    code: string,
  ): Promise<DeviceImportError> {
    try {
      await fn();
    } catch (err) {
      expect(isDeviceImportError(err)).toBe(true);
      if (!isDeviceImportError(err)) throw err;
      expect(err.code).toBe(code);
      return err;
    }
    throw new Error(`expected DeviceImportError("${code}") but call resolved`);
  }

  it("refuses malformed JSON", async () => {
    const { importer, repo } = setup();
    const err = await expectImportError(
      () => importer.importDevices({ projectId: "proj_a", data: "{not json", format: "json" }),
      "invalid_format",
    );
    expect(err.status).toBe(400);
    expect(await repo.listByProject("proj_a")).toEqual([]);
  });

  it("refuses a JSON body that is neither an array nor { devices }", async () => {
    const { importer } = setup();
    await expectImportError(
      () => importer.importDevices({ projectId: "proj_a", data: '{"nope":1}', format: "json" }),
      "invalid_format",
    );
  });

  it("refuses an empty body", async () => {
    const { importer } = setup();
    await expectImportError(
      () => importer.importDevices({ projectId: "proj_a", data: "   ", format: "csv" }),
      "empty_import",
    );
  });

  it("refuses a CSV with no recognised column", async () => {
    const { importer } = setup();
    await expectImportError(
      () => importer.importDevices({ projectId: "proj_a", data: "alpha,beta\n1,2\n", format: "csv" }),
      "invalid_format",
    );
  });

  it("refuses a blank projectId", async () => {
    const { importer } = setup();
    await expectImportError(
      () => importer.importDevices({ projectId: "  ", data: "name\nA\n", format: "csv" }),
      "invalid_input",
    );
  });

  it("refuses a batch larger than maxRows with 413, writing nothing", async () => {
    const { repo, devices } = setup();
    const importer = new DeviceImportService(devices, { limits: { maxRows: 2 } });
    const data = JSON.stringify([{ name: "A" }, { name: "B" }, { name: "C" }]);

    const err = await expectImportError(
      () => importer.importDevices({ projectId: "proj_a", data, format: "json" }),
      "too_many_rows",
    );
    expect(err.status).toBe(413);
    expect(await repo.listByProject("proj_a")).toEqual([]);
  });

  it("exposes its effective limits, defaulting from the documented constant", () => {
    const { devices } = setup();
    expect(new DeviceImportService(devices).limits).toEqual(DEFAULT_IMPORT_LIMITS);
    expect(new DeviceImportService(devices, { limits: { maxRows: 5 } }).limits).toMatchObject({
      maxRows: 5,
      maxMessageLength: DEFAULT_IMPORT_LIMITS.maxMessageLength,
    });
  });
});

// ---------------------------------------------------------------------------
// The standalone helper & the reported format
// ---------------------------------------------------------------------------

describe("importDevices helper", () => {
  it("imports via a throwaway service and echoes the format", async () => {
    const { devices } = setup();
    const result = await importDevices(devices, {
      projectId: "proj_a",
      data: "name\nSolo\n",
      format: "csv",
    });
    expect(result.format).toBe("csv");
    expect(result.created.map((d) => d.name)).toEqual(["Solo"]);
    expect(result.totalRows).toBe(1);
  });

  it("carries the source format through on the result", async () => {
    const { importer } = setup();
    const result = await importer.importDevices({
      projectId: "proj_a",
      data: JSON.stringify([{ name: "A" }]),
      format: "json",
    });
    expect(result.format).toBe("json");
  });
});
