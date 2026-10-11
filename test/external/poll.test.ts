/**
 * Spec tests for external-source polling — `external/poll.ts` (A31,
 * FR-INT-04 / FR-EXT-01).
 *
 * The poll is a pure service over injected seams, so these tests drive the REAL
 * {@link pollSource} with honest in-memory fakes — a stub `fetch`, the real
 * {@link InMemoryCursorStore} and the real {@link InMemoryPollSink} (which
 * mirrors the shape of `domains/telemetry`'s `InMemoryTelemetrySink`) — and
 * nothing here mocks the code under test. The clock is a value the test owns, so
 * every stamped `ts` is exactly knowable and no case depends on wall time.
 *
 * The acceptance properties, one `describe` each:
 *
 *   1. **Mapping** — a poll turns the allow-listed fields of each envelope item
 *      into telemetry points on the shared sink: the variable name comes from the
 *      `sentinel_map`, the value verbatim from the source, and the `ts` from the
 *      injected clock. Fields outside the mapping are ignored.
 *   2. **Cursor** — a poll advances the stored watermark, and a re-poll of the
 *      same payload double-ingests nothing; only genuinely new items are added.
 *   3. **Malformed / missing envelope** — a transport error, a non-2xx, a
 *      non-JSON body and an `envelope_path` that names nothing are each a soft
 *      failure that ingests nothing and never throws, leaving the cursor put.
 *   4. **Allow-list** — a non-allowed secret field present in the payload is
 *      never ingested, even though a `sentinel_map` entry names it.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryCursorStore,
  InMemoryPollSink,
  advanceCursor,
  isSeen,
  mapAllowedFields,
  parseEnvelopePath,
  pollSource,
  readEnvelope,
  type CursorConfig,
  type ExternalSourceConfig,
  type FetchLike,
  type FetchResponseLike,
  type PollDeps,
  type PollResult,
} from "../../worker/src/domains/external/poll";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PROJECT = "proj_ext";
const SOURCE = "src_weather";
const URL = "https://example.test/weather";
const FIXED_NOW = 1_700_000_000_000;

/**
 * A scripted transport: each call returns the next queued response. A queued
 * `Error` is thrown instead (to model a transport failure), and a queued value
 * with a non-JSON body is wrapped so `.json()` rejects.
 */
function scriptedFetch(
  steps: readonly (unknown | Error)[],
): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const step = steps[Math.min(index, steps.length - 1)];
    index++;
    if (step instanceof Error) throw step;
    return step as FetchResponseLike;
  };
  return { fetch, calls };
}

/** A `FetchResponseLike` whose body is `body` (JSON-serialised on demand). */
function jsonResponse(status: number, body: unknown): FetchResponseLike {
  return {
    status,
    json: async () => body,
  };
}

/** A `FetchResponseLike` whose `.json()` rejects — a non-JSON body. */
function brokenJsonResponse(status: number): FetchResponseLike {
  return {
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  };
}

/** Base config; each case overrides only the knobs it is about. */
function config(overrides: Partial<ExternalSourceConfig> = {}): ExternalSourceConfig {
  return {
    sourceId: SOURCE,
    url: URL,
    projectId: PROJECT,
    envelopePath: "observations",
    cursor: { field: "id", kind: "number" },
    sentinelMap: { temp_c: "temp", humidity: "humidity" },
    allowList: ["temp_c", "humidity"],
    ...overrides,
  };
}

interface Harness {
  readonly deps: PollDeps;
  readonly cursor: InMemoryCursorStore;
  readonly sink: InMemoryPollSink;
  calls(): readonly string[];
}

/** Wire the scripted transport to the real cursor store + real poll sink. */
function harness(steps: readonly (unknown | Error)[], now: number = FIXED_NOW): Harness {
  const { fetch, calls } = scriptedFetch(steps);
  const cursor = new InMemoryCursorStore();
  const sink = new InMemoryPollSink();
  const deps: PollDeps = { fetch, cursor, sink, now: () => now };
  return { deps, cursor, sink, calls: () => calls };
}

// ---------------------------------------------------------------------------
// 0. Envelope path — the parsing primitive the unwrap depends on
// ---------------------------------------------------------------------------

describe("parseEnvelopePath — a tiny dotted / bracketed grammar", () => {
  it("reads a plain dotted path as key steps", () => {
    expect(parseEnvelopePath("a.b.c")).toEqual([{ key: "a" }, { key: "b" }, { key: "c" }]);
  });

  it("reads bracketed digits as indices and named brackets as keys", () => {
    expect(parseEnvelopePath("payload.readings[2].temp")).toEqual([
      { key: "payload" },
      { key: "readings" },
      { index: 2 },
      { key: "temp" },
    ]);
    // A non-numeric bracket is NOT an index; the whole segment stays one literal
    // key (`map[key]` is a legal JSON object key that must not crash the parser).
    expect(parseEnvelopePath("map[key]")).toEqual([{ key: "map[key]" }]);
  });

  it("treats an empty or whitespace path as no steps (the root)", () => {
    expect(parseEnvelopePath("")).toEqual([]);
    expect(parseEnvelopePath("   ")).toEqual([]);
    expect(parseEnvelopePath(undefined)).toEqual([]);
  });
});

describe("readEnvelope — where the items live, normalised to an array", () => {
  it("resolves a key path to the array it names", () => {
    const body = { observations: [{ id: 1 }, { id: 2 }] };
    expect(readEnvelope(body, "observations")).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("resolves a nested path through indices", () => {
    const body = { payload: { batches: [{ readings: [{ id: 7 }] }] } };
    expect(readEnvelope(body, "payload.batches[0].readings")).toEqual([{ id: 7 }]);
  });

  it("normalises a single object to a one-element array", () => {
    const body = { reading: { id: 9, temp_c: 21 } };
    expect(readEnvelope(body, "reading")).toEqual([{ id: 9, temp_c: 21 }]);
  });

  it("returns null when the path names nothing", () => {
    expect(readEnvelope({}, "observations")).toBeNull();
    expect(readEnvelope({ observations: 5 }, "observations")).toBeNull();
    expect(readEnvelope({ a: { b: 1 } }, "a.c")).toBeNull();
    expect(readEnvelope({ list: [1] }, "list[3]")).toBeNull();
  });

  it("treats an empty path as the root itself", () => {
    expect(readEnvelope([{ id: 1 }], "")).toEqual([{ id: 1 }]);
    expect(readEnvelope({ id: 1 }, undefined)).toEqual([{ id: 1 }]);
    expect(readEnvelope(42, "")).toBeNull(); // a scalar root is not an envelope
  });
});

// ---------------------------------------------------------------------------
// 1. Mapping — allow-listed fields become telemetry points
// ---------------------------------------------------------------------------

describe("pollSource — mapping allow-listed fields into telemetry points", () => {
  it("records each mapped field as a point on the shared sink, in allow-list order", async () => {
    const h = harness([
      jsonResponse(200, {
        observations: [
          { id: 1, temp_c: 21.5, humidity: 48 },
          { id: 2, temp_c: 22.0, humidity: 50 },
        ],
      }),
    ]);

    const result = await pollSource(config(), h.deps);

    expect(result.ok).toBe(true);
    expect(result.ingested).toBe(4);
    expect(result.skipped).toBe(0);
    // The sink is the device telemetry seam: identical tuple shape.
    expect(h.sink.samples()).toEqual([
      { projectId: PROJECT, device: SOURCE, metric: "temp", value: 21.5, ts: FIXED_NOW },
      { projectId: PROJECT, device: SOURCE, metric: "humidity", value: 48, ts: FIXED_NOW },
      { projectId: PROJECT, device: SOURCE, metric: "temp", value: 22.0, ts: FIXED_NOW },
      { projectId: PROJECT, device: SOURCE, metric: "humidity", value: 50, ts: FIXED_NOW },
    ]);
    // The returned `points` are exactly what was recorded.
    expect(result.points).toEqual([
      { variable: "temp", value: 21.5, ts: FIXED_NOW },
      { variable: "humidity", value: 48, ts: FIXED_NOW },
      { variable: "temp", value: 22.0, ts: FIXED_NOW },
      { variable: "humidity", value: 50, ts: FIXED_NOW },
    ]);
  });

  it("ignores fields that are present but not mapped", async () => {
    const h = harness([
      jsonResponse(200, { observations: [{ id: 1, temp_c: 20, uptime_s: 9999, rssi: -60 }] }),
    ]);

    await pollSource(config(), h.deps);

    expect(h.sink.samples().map((s) => s.metric)).toEqual(["temp"]);
  });

  it("uses the configured device key and project, never a global default", async () => {
    const h = harness([jsonResponse(200, { observations: [{ id: 1, temp_c: 20 }] })]);

    await pollSource(config({ device: "external:acme", projectId: "proj_other" }), h.deps);

    expect(h.sink.samples()[0]).toEqual({
      projectId: "proj_other",
      device: "external:acme",
      metric: "temp",
      value: 20,
      ts: FIXED_NOW,
    });
  });

  it("falls back to the source id as the device key when none is configured", async () => {
    const h = harness([jsonResponse(200, { observations: [{ id: 1, humidity: 40 }] })]);

    await pollSource(config({ sentinelMap: { humidity: "humidity" }, allowList: ["humidity"] }), h.deps);

    expect(h.sink.samples()[0]?.device).toBe(SOURCE);
  });

  it("stamps the item's own finite numeric timestamp when timestampField names one", async () => {
    const h = harness([
      jsonResponse(200, {
        observations: [
          { id: 1, temp_c: 20, observed_at: 1_600_000_000_000 },
          { id: 2, temp_c: 21, observed_at: "not-a-number" }, // falls back to the poll instant
        ],
      }),
    ]);

    await pollSource(config({ timestampField: "observed_at" }), h.deps);

    expect(h.sink.samples().map((s) => s.ts)).toEqual([1_600_000_000_000, FIXED_NOW]);
  });

  it("skips an item with no allowed field but still ingests its siblings", async () => {
    const h = harness([
      jsonResponse(200, {
        observations: [{ id: 1, temp_c: 20 }, { id: 2, note: "no temperature" }, { id: 3, humidity: 45 }],
      }),
    ]);

    const result = await pollSource(config(), h.deps);

    expect(result.ok).toBe(true);
    expect(result.ingested).toBe(2);
    expect(result.skipped).toBe(1);
    expect(h.sink.samples().map((s) => s.value)).toEqual([20, 45]);
  });

  it("does not coerce an uncoercible value (a string number is skipped, not parsed)", async () => {
    const h = harness([jsonResponse(200, { observations: [{ id: 1, temp_c: "21.5" }] })]);

    const result = await pollSource(config(), h.deps);

    expect(result.ok).toBe(true);
    expect(result.ingested).toBe(0);
    expect(h.sink.size).toBe(0);
  });

  it("records a null value (a cleared reading is allowed)", async () => {
    const h = harness([jsonResponse(200, { observations: [{ id: 1, temp_c: null }] })]);

    await pollSource(config(), h.deps);

    expect(h.sink.samples()[0]).toEqual({
      projectId: PROJECT,
      device: SOURCE,
      metric: "temp",
      value: null,
      ts: FIXED_NOW,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Cursor — advance once, never double-ingest
// ---------------------------------------------------------------------------

describe("pollSource — the cursor prevents re-ingesting seen items", () => {
  it("advances the stored watermark after a successful poll", async () => {
    const h = harness([jsonResponse(200, { observations: [{ id: 10, temp_c: 1 }, { id: 12, temp_c: 3 }] })]);

    const result = await pollSource(config(), h.deps);

    expect(result.cursor).toBe("12");
    expect(h.cursor.read(SOURCE)).toBe("12");
  });

  it("does not double-ingest when the same payload is polled again", async () => {
    const payload = {
      observations: [
        { id: 1, temp_c: 21 },
        { id: 2, temp_c: 22 },
      ],
    };
    const h = harness([jsonResponse(200, payload), jsonResponse(200, payload)]);

    const first = await pollSource(config(), h.deps);
    const second = await pollSource(config(), h.deps);

    expect(first.ingested).toBe(2);
    expect(second.ingested).toBe(0); // every item is at/below the watermark
    expect(second.skipped).toBe(2);
    expect(h.sink.size).toBe(2); // still only the two from the first poll
  });

  it("ingests only the genuinely new items on a re-poll", async () => {
    const h = harness([
      jsonResponse(200, { observations: [{ id: 1, temp_c: 21 }] }),
      jsonResponse(200, {
        observations: [
          { id: 1, temp_c: 21 }, // seen
          { id: 2, temp_c: 22 }, // new
        ],
      }),
    ]);

    await pollSource(config(), h.deps);
    const second = await pollSource(config(), h.deps);

    expect(second.ingested).toBe(1);
    expect(second.points).toEqual([{ variable: "temp", value: 22, ts: FIXED_NOW }]);
    expect(h.sink.samples().map((s) => s.value)).toEqual([21, 22]);
  });

  it("keeps the watermark monotonic when items arrive out of order", async () => {
    const h = harness([
      jsonResponse(200, { observations: [{ id: 5, temp_c: 1 }, { id: 3, temp_c: 2 }] }),
    ]);

    const result = await pollSource(config(), h.deps);

    // The maximum wins, so a newest-first batch cannot drag the mark backwards.
    expect(result.cursor).toBe("5");
    expect(h.cursor.read(SOURCE)).toBe("5");
  });

  it("orders a string cursor lexicographically (an ISO-8601 watermark)", async () => {
    const h = harness([
      jsonResponse(200, {
        observations: [
          { ts: "2024-01-01T00:00:00Z", temp_c: 1 },
          { ts: "2024-01-01T00:00:05Z", temp_c: 2 },
        ],
      }),
    ]);

    const result = await pollSource(config({ cursor: { field: "ts", kind: "string" } }), h.deps);

    expect(result.cursor).toBe("2024-01-01T00:00:05Z");
  });

  it("does not advance the watermark on a failed poll (retry in place)", async () => {
    const h = harness([jsonResponse(500, { error: "boom" })]);
    // Seed a mark first so "unchanged" is observable.
    h.cursor.write(SOURCE, "7");

    const result = await pollSource(config(), h.deps);

    expect(result.ok).toBe(false);
    expect(result.cursor).toBe("7");
    expect(h.cursor.read(SOURCE)).toBe("7");
  });

  it("never treats a cursorless item as seen (it is skipped for a different reason)", () => {
    const cursor: CursorConfig = { field: "id", kind: "number" };
    expect(isSeen({ temp_c: 1 }, "10", cursor)).toBe(false);
    expect(isSeen({ id: 9 }, "10", cursor)).toBe(true);
    expect(isSeen({ id: 10 }, "10", cursor)).toBe(true); // equal → seen by default
    expect(isSeen({ id: 11 }, "10", cursor)).toBe(false);
  });

  it("advanceCursor returns the previous mark when no item carries a cursor", () => {
    expect(advanceCursor("9", [{ temp_c: 1 }], { field: "id", kind: "number" })).toBe("9");
    expect(advanceCursor(null, [], { field: "id", kind: "number" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Malformed / missing envelope — soft failure, never a crash
// ---------------------------------------------------------------------------

describe("pollSource — a bad source is a soft failure, never a throw", () => {
  it("reports fetch_failed when the transport throws, and ingests nothing", async () => {
    const h = harness([new Error("ECONNREFUSED")]);

    const result = await pollSource(config(), h.deps);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("fetch_failed");
    expect(result.ingested).toBe(0);
    expect(h.sink.size).toBe(0);
    expect(h.cursor.read(SOURCE)).toBeNull();
  });

  it("reports http_error with the status for a non-2xx response", async () => {
    const h = harness([jsonResponse(404, { message: "no such source" })]);

    const result = await pollSource(config(), h.deps);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("http_error");
    expect(result.status).toBe(404);
    expect(h.sink.size).toBe(0);
  });

  it("reports invalid_json when the body is not JSON", async () => {
    const h = harness([brokenJsonResponse(200)]);

    const result = await pollSource(config(), h.deps);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("invalid_json");
    expect(h.sink.size).toBe(0);
  });

  it("reports missing_envelope when the path names nothing", async () => {
    const h = harness([jsonResponse(200, { data: { items: [] } })]); // envelope_path is "observations"

    const result = await pollSource(config(), h.deps);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("missing_envelope");
    expect(h.sink.size).toBe(0);
  });

  it("treats an empty envelope array as success with zero points, not a failure", async () => {
    const h = harness([jsonResponse(200, { observations: [] })]);

    const result = await pollSource(config(), h.deps);

    expect(result.ok).toBe(true);
    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("skips a malformed (non-object) item without discarding its good siblings", async () => {
    const h = harness([
      jsonResponse(200, { observations: [{ id: 1, temp_c: 20 }, "not-an-object", null, [{ id: 9 }], { id: 2, temp_c: 21 }] }),
    ]);

    const result = await pollSource(config(), h.deps);

    expect(result.ok).toBe(true);
    expect(result.ingested).toBe(2);
    expect(result.skipped).toBe(3);
    expect(h.sink.samples().map((s) => s.value)).toEqual([20, 21]);
  });

  it("never throws for any of the malformed shapes", async () => {
    const shapes = [
      new Error("boom"),
      jsonResponse(503, {}),
      brokenJsonResponse(200),
      jsonResponse(200, { wrong: "shape" }),
      jsonResponse(200, { observations: 42 }),
      jsonResponse(200, { observations: [null, 1, "x"] }),
    ];
    for (const step of shapes) {
      const h = harness([step as unknown | Error]);
      const result: PollResult = await pollSource(config(), h.deps);
      expect(typeof result.ok).toBe("boolean");
      expect(result.sourceId).toBe(SOURCE);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Allow-list — a non-allowed secret is never ingested
// ---------------------------------------------------------------------------

describe("pollSource — the allow-list is enforced over the mapping", () => {
  it("never ingests a secret field that is mapped but not allowed", async () => {
    const h = harness([
      jsonResponse(200, {
        observations: [
          {
            id: 1,
            temp_c: 20,
            api_key: "sk-live-DO-NOT-LEAK", // present in the payload AND named in the map
            email: "ops@example.test",
          },
        ],
      }),
    ]);

    const cfg = config({
      sentinelMap: { temp_c: "temp", api_key: "leaked_key", email: "ops_email" },
      allowList: ["temp_c"], // only temp_c may pass
    });

    const result = await pollSource(cfg, h.deps);

    expect(result.ingested).toBe(1);
    const metrics = h.sink.samples().map((s) => s.metric);
    expect(metrics).toEqual(["temp"]);
    expect(metrics).not.toContain("leaked_key");
    expect(metrics).not.toContain("ops_email");
    // Belt and braces: no recorded VALUE anywhere is the secret.
    expect(h.sink.samples().map((s) => s.value)).not.toContain("sk-live-DO-NOT-LEAK");
  });

  it("ingests only a field present in BOTH the allow-list and the sentinel_map", () => {
    const mapped = mapAllowedFields(
      { temp_c: 20, humidity: 50, secret: "x" },
      { allowList: ["temp_c", "humidity", "absent"], sentinelMap: { temp_c: "temp", secret: "oops" } },
    );
    expect(mapped).toEqual([{ variable: "temp", value: 20 }]);
  });

  it("uses the sentinel_map name verbatim, never the external field name", () => {
    const mapped = mapAllowedFields(
      { source_temp_f: 71.6 },
      { allowList: ["source_temp_f"], sentinelMap: { source_temp_f: "greenhouse_temp" } },
    );
    expect(mapped).toEqual([{ variable: "greenhouse_temp", value: 71.6 }]);
  });

  it("is inert with an empty allow-list: nothing is ever ingested", async () => {
    const h = harness([
      jsonResponse(200, { observations: [{ id: 1, temp_c: 20, humidity: 50 }] }),
    ]);

    const result = await pollSource(config({ allowList: [] }), h.deps);

    expect(result.ok).toBe(true);
    expect(result.ingested).toBe(0);
    expect(h.sink.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration — the whole path end to end
// ---------------------------------------------------------------------------

describe("pollSource — end to end over the real seams", () => {
  it("fetch → unwrap → map → sink, advancing the cursor across two polls", async () => {
    const h = harness([
      jsonResponse(200, {
        payload: { readings: [{ id: 100, temp_c: 19.5 }, { id: 101, temp_c: 19.7 }] },
      }),
      jsonResponse(200, {
        payload: { readings: [{ id: 101, temp_c: 19.7 }, { id: 102, temp_c: 20.1 }] },
      }),
    ]);

    const cfg = config({
      envelopePath: "payload.readings",
      sentinelMap: { temp_c: "temp" },
      allowList: ["temp_c"],
      device: "external:greenhouse",
    });

    const first = await pollSource(cfg, h.deps);
    const second = await pollSource(cfg, h.deps);

    expect(first.ingested).toBe(2);
    expect(second.ingested).toBe(1); // only id 102 is new
    expect(h.sink.samples()).toEqual([
      { projectId: PROJECT, device: "external:greenhouse", metric: "temp", value: 19.5, ts: FIXED_NOW },
      { projectId: PROJECT, device: "external:greenhouse", metric: "temp", value: 19.7, ts: FIXED_NOW },
      { projectId: PROJECT, device: "external:greenhouse", metric: "temp", value: 20.1, ts: FIXED_NOW },
    ]);
    expect(h.cursor.read(SOURCE)).toBe("102");
    expect(h.calls()).toEqual([URL, URL]);
  });
});
