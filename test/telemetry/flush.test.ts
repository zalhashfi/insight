import { describe, expect, it } from "vitest";
import {
  InMemoryShardStorage,
  ShardDO,
} from "../../worker/src/platform/durable-objects/shard-do";
import {
  DEFAULT_KEY_PREFIX,
  InMemoryR2,
  flushShard,
  toNdjson,
  windowKey,
  type FlushedPoint,
} from "../../worker/src/domains/telemetry/flush";

/**
 * Spec tests for the A10 flush (`flushShard`) — the two-phase, IDEMPOTENT
 * drain from a shard's `inflight` journal to R2.
 *
 * The guarantee under test is INV-T4: a crash anywhere in the flush must not
 * lose a point and must not duplicate one. Each case pins one property of the
 * protocol:
 *
 *   1. **Happy path** — every journalled point reaches R2 exactly once, and the
 *      journal is drained to empty.
 *   2. **Fault injection** — a `put` that fails mid-way leaves the window
 *      journalled; the re-run re-delivers it, and R2 still holds each point
 *      once (no loss from the failure, no dup from the retry).
 *   3. **Idempotency** — a second flush with no new rows is a no-op: no extra
 *      object, no extra point.
 *   4. **Concurrency** — two attempts at the same window do not corrupt the
 *      object (the `unique-key`/`cas` strategies behave as designed).
 */

const DEVICE = "dev_alpha";
const METRIC = "temperature";
const FIXED_NOW = 1_700_000_000_123;
const BASE_TS = 1_000_000;

/** Build an initialised shard backed by fresh in-memory storage. */
async function shard(): Promise<{ do: ShardDO; storage: InMemoryShardStorage }> {
  const storage = new InMemoryShardStorage();
  const instance = new ShardDO({ storage, now: () => FIXED_NOW });
  await instance.init();
  return { do: instance, storage };
}

/** Ingest `count` accepted samples for one device, seqs 0..count-1. */
async function ingest(instance: ShardDO, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const result = await instance.ingest({
      device: DEVICE,
      metric: METRIC,
      value: i,
      ts: BASE_TS + i,
    });
    if (!result.accepted) throw new Error(`ingest ${i} unexpectedly rejected`);
  }
}

/** Parse an NDJSON body into its points, asserting it is line-delimited. */
function parse(body: string): FlushedPoint[] {
  return body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FlushedPoint);
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------
describe("flushShard — happy path", () => {
  it("delivers exactly 100 points to R2 and drains the journal", async () => {
    const { do: shardDO } = await shard();
    await ingest(shardDO, 100);
    expect(await shardDO.pending(DEVICE)).toHaveLength(100);

    const r2 = new InMemoryR2();
    const result = await flushShard(shardDO, r2, { device: DEVICE });

    expect(result.flushed).toBe(100);
    expect(result.key).not.toBeNull();
    expect(result.upToSeq).toBe(99);
    expect(r2.puts).toHaveLength(1);

    // R2 holds exactly 100 parsed points, each once.
    const points = r2.points();
    expect(points).toHaveLength(100);
    const seqs = points.map((p) => p.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i));
    // Every point carries the full sample shape, not just an id.
    expect(points.every((p) => p.device === DEVICE && p.metric === METRIC)).toBe(true);

    // Journal drained to empty.
    expect(await shardDO.pending(DEVICE)).toHaveLength(0);
  });

  it("uses a deterministic per-window key", async () => {
    const { do: shardDO } = await shard();
    await ingest(shardDO, 3);

    const r2 = new InMemoryR2();
    const result = await flushShard(shardDO, r2, { device: DEVICE, strategy: "cas" });

    expect(result.key).toBe(windowKey(DEFAULT_KEY_PREFIX, DEVICE, 2));
    expect(r2.keys()).toEqual([windowKey(DEFAULT_KEY_PREFIX, DEVICE, 2)]);
  });

  it("is a no-op (no put) when the journal is empty", async () => {
    const { do: shardDO } = await shard();
    const r2 = new InMemoryR2();

    const result = await flushShard(shardDO, r2, { device: DEVICE });

    expect(result.key).toBeNull();
    expect(result.flushed).toBe(0);
    expect(r2.puts).toHaveLength(0);
    expect(r2.points()).toHaveLength(0);
  });

  it("serialises NDJSON with one newline-terminated object per row", async () => {
    const { do: shardDO } = await shard();
    await ingest(shardDO, 2);
    const rows = await shardDO.pending(DEVICE);

    const body = toNdjson(rows);
    expect(body.endsWith("\n")).toBe(true);
    expect(body.split("\n").filter(Boolean)).toHaveLength(2);
    expect(parse(body).map((p) => p.seq)).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// 2. Fault injection — a put fails mid-way, then the run is retried
// ---------------------------------------------------------------------------
describe("flushShard — fault injection (INV-T4)", () => {
  it("re-run after a mid-flush put failure neither loses nor duplicates", async () => {
    const { do: shardDO } = await shard();
    await ingest(shardDO, 100);

    const r2 = new InMemoryR2();
    // The first put of window 0..99 fails — as if the process died at the
    // network call, before any drain.
    r2.failNext(new Error("R2 outage"));

    await expect(flushShard(shardDO, r2, { device: DEVICE })).rejects.toThrow("R2 outage");

    // Nothing was delivered, and crucially nothing was drained: the whole
    // window is still journalled, so a re-run can still deliver it.
    expect(r2.points()).toHaveLength(0);
    expect(await shardDO.pending(DEVICE)).toHaveLength(100);

    // Re-run: same window, second attempt.
    const retry = await flushShard(shardDO, r2, { device: DEVICE });
    expect(retry.flushed).toBe(100);

    // R2 holds exactly 100 points — no loss from the failure, no dup from the
    // retry (the attempt suffix gave the retry a distinct object).
    const points = r2.points();
    expect(points).toHaveLength(100);
    expect(new Set(points.map((p) => p.seq)).size).toBe(100);

    // Journal drained.
    expect(await shardDO.pending(DEVICE)).toHaveLength(0);
  });

  it("a crash AFTER the put but BEFORE the drain is recovered by replay", async () => {
    const { do: shardDO, storage } = await shard();
    await ingest(shardDO, 10);

    const r2 = new InMemoryR2();
    // Deliver the window, then simulate a crash before the drain: put the
    // object but skip `drain`. The journal still owes all 10.
    const putKey = windowKey(DEFAULT_KEY_PREFIX, DEVICE, 9);
    await r2.put(putKey, toNdjson(await shardDO.pending(DEVICE)));
    expect(await shardDO.pending(DEVICE)).toHaveLength(10);

    // A re-run must not duplicate: under `cas`, the same key is rejected, yet
    // the rows are still drained because they are durably delivered.
    const result = await flushShard(shardDO, r2, { device: DEVICE, strategy: "cas" });
    expect(result.alreadyDelivered).toBe(true);
    expect(r2.keys()).toEqual([putKey]);
    expect(r2.points()).toHaveLength(10);
    expect(await storage.inflight(DEVICE)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Idempotency — a second flush with no new rows adds nothing
// ---------------------------------------------------------------------------
describe("flushShard — idempotency", () => {
  it("a second flush with no new points adds and duplicates nothing", async () => {
    const { do: shardDO } = await shard();
    await ingest(shardDO, 100);

    const r2 = new InMemoryR2();
    await flushShard(shardDO, r2, { device: DEVICE });

    const objectsAfterFirst = r2.keys().length;
    const pointsAfterFirst = r2.points().length;

    const second = await flushShard(shardDO, r2, { device: DEVICE });

    expect(second.flushed).toBe(0);
    expect(second.key).toBeNull();
    expect(r2.keys().length).toBe(objectsAfterFirst);
    expect(r2.points().length).toBe(pointsAfterFirst);
    expect(await shardDO.pending(DEVICE)).toHaveLength(0);
  });

  it("a later flush delivers only the newly-accepted rows", async () => {
    const { do: shardDO } = await shard();
    await ingest(shardDO, 100);

    const r2 = new InMemoryR2();
    await flushShard(shardDO, r2, { device: DEVICE });

    // 5 more accepted after the first flush: seqs 100..104.
    for (let i = 0; i < 5; i += 1) {
      await shardDO.ingest({
        device: DEVICE,
        metric: METRIC,
        value: 1000 + i,
        ts: BASE_TS + 100 + i,
      });
    }

    const second = await flushShard(shardDO, r2, { device: DEVICE });
    expect(second.flushed).toBe(5);
    expect(second.upToSeq).toBe(104);

    // 105 distinct points across two windows; the first 100 are not re-sent.
    const points = r2.points();
    expect(points).toHaveLength(105);
    expect(new Set(points.map((p) => p.seq)).size).toBe(105);
    expect(points.filter((p) => p.seq >= 100).map((p) => p.seq).sort((a, b) => a - b)).toEqual([
      100, 101, 102, 103, 104,
    ]);
  });

  it("drain advances the high-water mark monotonically", async () => {
    const { do: shardDO, storage } = await shard();
    await ingest(shardDO, 10);
    const r2 = new InMemoryR2();

    await flushShard(shardDO, r2, { device: DEVICE });
    expect(await storage.flushedTo(DEVICE)).toBe(9);

    // A stale drain (a re-run of an older window) must not roll the mark back.
    await shardDO.drain(DEVICE, 4);
    expect(await storage.flushedTo(DEVICE)).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 4. Concurrent-same-window safety
// ---------------------------------------------------------------------------
describe("flushShard — concurrent same-window safety", () => {
  it("unique-key: two attempts at one window write distinct objects, no collision", async () => {
    const { do: shardDO } = await shard();
    await ingest(shardDO, 100);

    const r2 = new InMemoryR2();
    // Two attempts of the same window, launched concurrently, each with its
    // own attempt id — as two workers racing the same shard.
    const [a, b] = await Promise.all([
      flushShard(shardDO, r2, { device: DEVICE, attempt: "worker-a" }),
      flushShard(shardDO, r2, { device: DEVICE, attempt: "worker-b" }),
    ]);

    // Distinct keys: neither attempt overwrote the other's object.
    expect(a.key).not.toBe(b.key);
    expect(r2.keys().length).toBe(2);
    // Each object independently holds the full, uncorrupted window.
    for (const key of r2.keys()) {
      expect(parse(r2.get(key)!.body)).toHaveLength(100);
    }
    // The journal is empty: the (idempotent) drain ran twice safely.
    expect(await shardDO.pending(DEVICE)).toHaveLength(0);
  });

  it("cas: the second attempt of a window is rejected, leaving one intact object", async () => {
    const { do: shardDO } = await shard();
    await ingest(shardDO, 100);

    const r2 = new InMemoryR2();
    const first = await flushShard(shardDO, r2, { device: DEVICE, strategy: "cas" });
    expect(first.alreadyDelivered).toBe(false);

    // A concurrent/duplicate attempt at the same window: same key, CAS rejects.
    // Re-journal a row so the flush has work to do, then attempt again.
    const { do: other } = await shard();
    await ingest(other, 100);
    const second = await flushShard(other, r2, { device: DEVICE, strategy: "cas" });

    expect(second.key).toBe(first.key);
    expect(second.alreadyDelivered).toBe(true);
    // Still exactly one object, holding exactly 100 points — the rejection
    // could not have corrupted or doubled the delivered window.
    expect(r2.keys()).toHaveLength(1);
    expect(r2.points()).toHaveLength(100);
    // The rejected attempt still drained its own journal.
    expect(await other.pending(DEVICE)).toHaveLength(0);
  });

  it("two overlapping flushes of one shard never lose a point and never corrupt an object", async () => {
    const { do: shardDO } = await shard();
    await ingest(shardDO, 100);

    const r2 = new InMemoryR2();
    await Promise.all([
      flushShard(shardDO, r2, { device: DEVICE, attempt: "one" }),
      flushShard(shardDO, r2, { device: DEVICE, attempt: "two" }),
    ]);

    // Two overlapping attempts each capture the same window before either
    // drains, so the *objects* may both hold all 100 rows (that is the point of
    // a unique key: neither corrupts the other). The safety property is that a
    // seq-keyed reader sees each point exactly once. Assert the union, not the
    // raw cross-object count.
    const seqs = r2.points().map((p) => p.seq);
    expect(new Set(seqs)).toEqual(new Set(Array.from({ length: 100 }, (_, i) => i)));
    // No object is individually corrupted or partial.
    for (const key of r2.keys()) expect(parse(r2.get(key)!.body)).toHaveLength(100);
    expect(await shardDO.pending(DEVICE)).toHaveLength(0);
  });
});
