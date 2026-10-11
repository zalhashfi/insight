import { describe, expect, it } from "vitest";
import {
  InMemoryShardStorage,
  RING_CAPACITY,
  ShardDO,
  hashDeviceKey,
  shardIndex,
  splitStreamKey,
  type IngestResult,
  type Sample,
  type ShardStorage,
} from "../../worker/src/platform/durable-objects/shard-do";
import {
  SHARD_DDL,
  SHARD_TABLES,
  shardStatements,
} from "../../worker/src/platform/durable-objects/shard-schema";

/**
 * Spec tests for the A09 shard write path (`ShardDO`).
 *
 * Every dependency is injected — an in-memory storage seam plus a clock — so
 * each contract is asserted against a value we control outright:
 *
 *   1. **Ordering** (INV-T1/T2) — a stale `ts` is rejected and leaves both the
 *      projected value and the seq high-water mark untouched; an equal `ts` is
 *      last-write-wins, tie-broken by seq.
 *   2. **Monotonic seq** — only an accepted sample advances `nextSeq`.
 *   3. **Ring capacity** — a full stream FIFO-evicts its oldest row and the
 *      eviction is counted, while the evicted sample survives in `inflight`.
 *   4. **Sharding** — `shardIndex` is deterministic across calls and spreads
 *      many keys evenly over the shard range.
 *   5. **DDL** — the schema string actually declares the tables the DO uses.
 */

const DEVICE = "dev_alpha";
const METRIC = "temperature";

/** A clock the test owns, so `recordedAt` is exactly knowable. */
const FIXED_NOW = 1_700_000_000_123;

/** Build an initialised shard backed by fresh in-memory storage. */
async function shard(options: { ringCapacity?: number } = {}): Promise<{
  do: ShardDO;
  storage: InMemoryShardStorage;
}> {
  const storage = new InMemoryShardStorage();
  const instance = new ShardDO({
    storage,
    now: () => FIXED_NOW,
    ringCapacity: options.ringCapacity,
  });
  await instance.init();
  return { do: instance, storage };
}

/** Ingest and require acceptance, returning the assigned seq. */
async function accept(
  instance: ShardDO,
  sample: { device?: string; metric?: string; value: number | null; ts: number },
): Promise<number> {
  const result: IngestResult = await instance.ingest({
    device: sample.device ?? DEVICE,
    metric: sample.metric ?? METRIC,
    value: sample.value,
    ts: sample.ts,
  });
  if (!result.accepted) {
    throw new Error(`expected acceptance, got rejection at ts=${sample.ts}`);
  }
  return result.seq;
}

// ---------------------------------------------------------------------------
// Ordering — INV-T1 / INV-T2
// ---------------------------------------------------------------------------
describe("ShardDO.ingest — ordering (INV-T1/T2)", () => {
  it("rejects a stale ts, leaving state and seq untouched", async () => {
    const { do: shardDO } = await shard();

    const seq10 = await accept(shardDO, { value: 10, ts: 10 });
    expect(seq10).toBe(0);

    const rejected = await shardDO.ingest({
      device: DEVICE,
      metric: METRIC,
      value: 9,
      ts: 9,
    });

    expect(rejected.accepted).toBe(false);
    if (rejected.accepted) throw new Error("unreachable");
    expect(rejected.reason).toBe("out_of_order");
    expect(rejected.latestTs).toBe(10);

    // State stays at ts=10 with its value.
    const state = shardDO.getState(DEVICE, METRIC);
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ value: 10, ts: 10, seq: 0 });

    // The rejected sample consumed no seq: the next accept still takes seq 1.
    const nextSeq = await accept(shardDO, { value: 11, ts: 11 });
    expect(nextSeq).toBe(1);

    // And the rejected sample never entered the ring.
    const ring = await shardDO.getRing(DEVICE);
    expect(ring.map((row) => row.seq)).toEqual([0, 1]);
    expect(ring.map((row) => row.ts)).toEqual([10, 11]);
  });

  it("resolves an equal ts by seq: a same-ts retry is the stored point, a newer ts wins", async () => {
    const { do: shardDO } = await shard();

    await accept(shardDO, { value: 1, ts: 100 });

    // INV-T2 is "equal ts is LWW, tie-broken by seq". The bare `ingest` API
    // derives `seq` from the stream, so a same-ts arrival reuses the stored
    // point's identity `(device, metric, ts, seq)` — it is the stored point
    // re-sent, refused by the dedup gate (A13) rather than overwriting.
    const retry = await shardDO.ingest({
      device: DEVICE,
      metric: METRIC,
      value: 2,
      ts: 100,
    });
    expect(retry).toMatchObject({ accepted: false, reason: "seen" });
    expect(shardDO.getState(DEVICE, METRIC)[0]).toMatchObject({ value: 1, ts: 100, seq: 0 });

    // A strictly newer ts is a genuinely new point: it takes a fresh seq and
    // becomes the winner, so the stream still moves forward.
    const seq = await accept(shardDO, { value: 3, ts: 101 });
    expect(seq).toBe(1);
    expect(shardDO.getState(DEVICE, METRIC)[0]).toMatchObject({ value: 3, ts: 101, seq: 1 });
  });
});

// ---------------------------------------------------------------------------
// Monotonic seq
// ---------------------------------------------------------------------------
describe("ShardDO.ingest — seq is monotonic", () => {
  it("advances on every accepted reading and never decreases", async () => {
    const { do: shardDO } = await shard();

    const seen: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      seen.push(await accept(shardDO, { value: i, ts: i + 1 }));
    }

    expect(seen[0]).toBe(0);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    }
  });

  it("keeps one counter per (device, metric) stream", async () => {
    const { do: shardDO } = await shard();

    const a = await accept(shardDO, { value: 1, ts: 1 });
    const b = await accept(shardDO, { metric: "humidity", value: 1, ts: 1 });
    const c = await accept(shardDO, { device: "dev_beta", value: 1, ts: 1 });

    expect([a, b, c]).toEqual([0, 0, 0]);
    expect(await accept(shardDO, { value: 2, ts: 2 })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ring capacity — FIFO eviction
// ---------------------------------------------------------------------------
describe("ShardDO.ingest — ring capacity", () => {
  it("FIFO-evicts the oldest row and counts the drop when full", async () => {
    const { do: shardDO } = await shard({ ringCapacity: 4 });

    for (let i = 0; i < 4; i += 1) {
      await accept(shardDO, { value: i, ts: i + 1 });
    }
    expect((await shardDO.getRing(DEVICE)).map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(shardDO.getDropped()).toBe(0);

    // One more: oldest (seq 0) is evicted before the new row lands.
    await accept(shardDO, { value: 4, ts: 5 });

    const ring = await shardDO.getRing(DEVICE);
    expect(ring.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(ring.some((r) => r.seq === 0)).toBe(false);
    expect(shardDO.getDropped()).toBe(1);
    expect(shardDO.getDropped(DEVICE)).toBe(1);
  });

  it("defaults to RING_CAPACITY rows and evicts exactly one at the boundary", async () => {
    const { do: shardDO } = await shard();

    for (let i = 0; i < RING_CAPACITY; i += 1) {
      await accept(shardDO, { value: i, ts: i + 1 });
    }
    expect(await shardDO.getRing(DEVICE)).toHaveLength(RING_CAPACITY);
    expect(shardDO.getDropped()).toBe(0);

    await accept(shardDO, { value: RING_CAPACITY, ts: RING_CAPACITY + 1 });
    const ring = await shardDO.getRing(DEVICE);
    expect(ring).toHaveLength(RING_CAPACITY);
    expect(ring[0].seq).toBe(1);
    expect(ring[ring.length - 1].seq).toBe(RING_CAPACITY);
    expect(shardDO.getDropped()).toBe(1);
  });

  it("keeps an evicted sample on the inflight journal for the future flush", async () => {
    const { do: shardDO } = await shard({ ringCapacity: 2 });

    for (let i = 0; i < 3; i += 1) {
      await accept(shardDO, { value: i, ts: i + 1 });
    }

    // Ring holds only the two newest; the journal still owes all three.
    expect((await shardDO.getRing(DEVICE)).map((r) => r.seq)).toEqual([1, 2]);
    const pending = await shardDO.pending(DEVICE);
    expect(pending.map((r) => r.seq)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Projection + inflight views
// ---------------------------------------------------------------------------
describe("ShardDO — state and inflight views", () => {
  it("scopes getState by device and metric", async () => {
    const { do: shardDO } = await shard();

    await accept(shardDO, { value: 1, ts: 1 });
    await accept(shardDO, { metric: "humidity", value: 2, ts: 1 });
    await accept(shardDO, { device: "dev_beta", value: 3, ts: 1 });

    expect(shardDO.getState()).toHaveLength(3);
    expect(shardDO.getState(DEVICE)).toHaveLength(2);
    expect(shardDO.getState(DEVICE, "humidity")).toEqual([
      { device: DEVICE, metric: "humidity", value: 2, ts: 1, seq: 0 },
    ]);
    expect(shardDO.getState(DEVICE, "absent")).toEqual([]);
  });

  it("exposes pending() for the whole shard and per device, oldest first", async () => {
    const { do: shardDO } = await shard();

    await accept(shardDO, { value: 1, ts: 1 });
    await accept(shardDO, { value: 2, ts: 2 });
    await accept(shardDO, { device: "dev_beta", value: 3, ts: 1 });

    // Two streams for DEVICE (seq 0, 1) plus one for dev_beta (seq 0). The
    // shard-wide view groups by device, each group oldest-first; it does not
    // interleave the two devices by seq (which would compare unrelated clocks).
    const all = await shardDO.pending();
    expect(all).toHaveLength(3);
    for (const device of [DEVICE, "dev_beta"]) {
      const group = all.filter((row) => row.device === device).map((row) => row.seq);
      const ascending = [...group].sort((a, b) => a - b);
      expect(group).toEqual(ascending);
    }
    expect(all.filter((row) => row.device === DEVICE)).toHaveLength(2);
    expect((await shardDO.pending(DEVICE)).map((r) => r.seq)).toEqual([0, 1]);
    expect((await shardDO.pending("dev_beta")).map((r) => r.device)).toEqual(["dev_beta"]);
  });

  it("rebuilds its projection from a warm storage seam", async () => {
    const storage = new InMemoryShardStorage();
    const first = new ShardDO({ storage, now: () => FIXED_NOW });
    await first.init();
    await accept(first, { value: 7, ts: 42 });

    const second = new ShardDO({ storage, now: () => FIXED_NOW });
    await second.init();
    expect(second.getState(DEVICE, METRIC)).toEqual([
      { device: DEVICE, metric: METRIC, value: 7, ts: 42, seq: 0 },
    ]);
    // The rebuilt projection still rejects a stale sample.
    const rejected = await second.ingest({
      device: DEVICE,
      metric: METRIC,
      value: 1,
      ts: 41,
    });
    expect(rejected.accepted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sharding
// ---------------------------------------------------------------------------
describe("shardIndex", () => {
  it("is deterministic across calls for the same key", () => {
    const keys = ["dev_alpha", "dev_beta", "sensor-01", "", "üñîçø∂é", "x".repeat(512)];
    for (const key of keys) {
      const first = shardIndex(key, 16);
      for (let call = 0; call < 100; call += 1) {
        expect(shardIndex(key, 16)).toBe(first);
      }
      expect(shardIndex(key, 16)).toBeGreaterThanOrEqual(0);
      expect(shardIndex(key, 16)).toBeLessThan(16);
    }
  });

  it("rejects a non-positive or non-integer shard count", () => {
    expect(() => shardIndex("k", 0)).toThrow(RangeError);
    expect(() => shardIndex("k", -1)).toThrow(RangeError);
    expect(() => shardIndex("k", 2.5)).toThrow(RangeError);
  });

  it("spreads many keys evenly over the shard range", () => {
    const shards = 16;
    const keys = Array.from({ length: 8_000 }, (_, i) => `device-${i}-${i * 2654435761}`);

    const buckets = new Array<number>(shards).fill(0);
    for (const key of keys) buckets[shardIndex(key, shards)] += 1;

    const expected = keys.length / shards;
    // Every bucket is populated, and none is off by more than 25% — a bound
    // that a degenerate hash (all-one-bucket, or modulo of low bits) breaks
    // outright while leaving honest modulo folding comfortably inside.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(expected * 0.75);
      expect(count).toBeLessThan(expected * 1.25);
    }

    // Chi-square over the observed buckets; the 0.999 quantile for 15 degrees
    // of freedom is ~37.7, so a pass is a strong signal of even spread.
    const chiSquare = buckets.reduce(
      (sum, count) => sum + (count - expected) ** 2 / expected,
      0,
    );
    expect(chiSquare).toBeLessThan(37.7);
  });

  it("folds the hash into the shard range without sign bleed", () => {
    expect(hashDeviceKey("dev_alpha")).toBeGreaterThanOrEqual(0);
    expect(hashDeviceKey("dev_alpha")).toBeLessThan(2 ** 32);
    expect(hashDeviceKey("dev_alpha")).not.toBe(hashDeviceKey("dev_beta"));
  });

  it("splits a stream key back into its device and metric", () => {
    expect(splitStreamKey(`${DEVICE}\u0000${METRIC}`)).toEqual({
      device: DEVICE,
      metric: METRIC,
    });
  });
});

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------
describe("shard schema DDL", () => {
  it("declares the tables the shard uses", () => {
    expect(SHARD_DDL).toContain("ring_buffer");
    expect(SHARD_DDL).toContain("inflight");
    expect(SHARD_DDL).toContain("flush_meta");
    for (const table of SHARD_TABLES) {
      expect(SHARD_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("splits into idempotent statements on top-level semicolons", () => {
    const statements = shardStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.endsWith(";")).toBe(true);
      expect(statement).toContain("IF NOT EXISTS");
    }
    // Round-trip: re-splitting is stable, and every table is created once.
    expect(shardStatements()).toEqual(statements);
    expect(shardStatements().filter((s) => s.includes("CREATE TABLE"))).toHaveLength(4);
  });

  it("is exposed by the storage seam so an adapter can execute it", () => {
    const storage: ShardStorage = new InMemoryShardStorage();
    expect(storage.ddl()).toEqual(shardStatements());
  });
});

// ---------------------------------------------------------------------------
// Storage seam sanity — a Sample survives a round-trip intact
// ---------------------------------------------------------------------------
describe("InMemoryShardStorage", () => {
  it("returns copies, so a caller cannot mutate stored rows", async () => {
    const storage = new InMemoryShardStorage();
    const sample: Sample = {
      device: DEVICE,
      metric: METRIC,
      value: 1,
      ts: 1,
      seq: 0,
      recordedAt: FIXED_NOW,
    };
    await storage.appendRing(sample);

    const first = await storage.ring(DEVICE, METRIC);
    first.push({ ...sample, seq: 99 });
    const second = await storage.ring(DEVICE, METRIC);
    expect(second).toHaveLength(1);
  });

  it("reports ring occupancy and drops per device — the seam A10 reads", async () => {
    const { do: shardDO, storage } = await shard({ ringCapacity: 2 });
    // One stream filled past capacity (one eviction) plus a second stream.
    await accept(shardDO, { value: 1, ts: 1 });
    await accept(shardDO, { value: 2, ts: 2 });
    await accept(shardDO, { value: 3, ts: 3 });
    await accept(shardDO, { metric: "humidity", value: 4, ts: 1 });

    // Temperature holds its full 2 after evicting seq 0; humidity its 1.
    expect(await storage.ringCount(DEVICE)).toBe(3);
    expect(await storage.ringCount("dev_absent")).toBe(0);
    expect(await storage.dropped(DEVICE)).toBe(1);
    expect(await storage.dropped("dev_absent")).toBe(0);
    expect(shardDO.getDropped(DEVICE)).toBe(1);
    expect(shardDO.getDropped()).toBe(1);
    expect(shardDO.getDropped("dev_absent")).toBe(0);

    const metas = await storage.listMeta();
    expect(metas.map((m) => m.metric).sort()).toEqual(["humidity", "temperature"]);
  });
});
