import { describe, expect, it } from "vitest";
import {
  InMemoryShardStorage,
  ShardDO,
  type IngestResult,
  type Sample,
} from "../../worker/src/platform/durable-objects/shard-do";
import {
  dedupKey,
  type PointIdentity,
} from "../../worker/src/domains/telemetry/dedup";

/**
 * A13 — idempotent ingest dedup.
 *
 * At-least-once delivery means the SAME point can arrive twice. The identity
 * rule — `(device, variable, ts, seq)`, documented in
 * `domains/telemetry/dedup.ts` — is owned by that module and **applied** by
 * `ShardDO.ingest`, the one place a duplicate can land. These tests pin the
 * rule two ways, both against what actually runs:
 *
 *   1. **The identity key** (`dedupKey`) — the exact string the shard's
 *      `seenPoints` set is indexed on; injective over `(device, metric, ts,
 *      seq)`.
 *   2. **The ingest gate** (`ShardDO.ingest`) — sending the same point twice
 *      leaves the ring size unchanged on the second send and consumes no seq,
 *      while a genuinely different point (new ts) is recorded. INV-T1/T2 are
 *      untouched: a stale ts is still rejected.
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

/** Send one ingest and hand back the raw result, whatever it is. */
function send(
  instance: ShardDO,
  sample: { device?: string; metric?: string; value: number | null; ts: number },
): Promise<IngestResult> {
  return instance.ingest({
    device: sample.device ?? DEVICE,
    metric: sample.metric ?? METRIC,
    value: sample.value,
    ts: sample.ts,
  });
}

/** Ingest and require acceptance, returning the assigned seq. */
async function accept(
  instance: ShardDO,
  sample: { device?: string; metric?: string; value: number | null; ts: number },
): Promise<number> {
  const result = await send(instance, sample);
  if (!result.accepted) {
    throw new Error(`expected acceptance, got "${result.reason}" at ts=${sample.ts}`);
  }
  return result.seq;
}

const POINT: PointIdentity = { device: DEVICE, variable: METRIC, ts: 42, seq: 3 };

// ---------------------------------------------------------------------------
// Identity — the key the shard indexes records on
// ---------------------------------------------------------------------------
describe("dedup identity key", () => {
  it("keys a point by (device, variable, ts, seq) and is injective", () => {
    const base = dedupKey(POINT);
    expect(base).toBe(dedupKey({ ...POINT }));

    // Each field, changed alone, yields a different key — no collisions.
    expect(dedupKey({ ...POINT, device: "dev_beta" })).not.toBe(base);
    expect(dedupKey({ ...POINT, variable: "humidity" })).not.toBe(base);
    expect(dedupKey({ ...POINT, ts: 43 })).not.toBe(base);
    expect(dedupKey({ ...POINT, seq: 4 })).not.toBe(base);

    // A NUL separator means the fields cannot be smuggled into one another.
    expect(dedupKey({ device: "a", variable: "b", ts: 1, seq: 2 })).not.toBe(
      dedupKey({ device: "a\u0000b", variable: "", ts: 1, seq: 2 }),
    );
  });

  it("gives the identity a retry carries (device, metric, ts, latestSeq) the same key as the stored point", () => {
    // This is exactly how `ShardDO.ingest` decides a re-delivery: for a same-ts
    // arrival it reuses the stored `latestSeq`, so the retry's key equals the
    // key of the point already recorded — which is why the retry folds onto
    // the entry that exists instead of appending a second row.
    const stored = dedupKey({ device: DEVICE, variable: METRIC, ts: 100, seq: 0 });
    const retry = dedupKey({ device: DEVICE, variable: METRIC, ts: 100, seq: 0 });
    expect(retry).toBe(stored);

    // A fresh seq at the same ts is a new point (the INV-T2 tie), not a retry.
    expect(dedupKey({ device: DEVICE, variable: METRIC, ts: 100, seq: 1 })).not.toBe(stored);
  });
});

// ---------------------------------------------------------------------------
// The shard ring — accept once, ignore the retry
// ---------------------------------------------------------------------------
describe("ShardDO.ingest — idempotent dedup", () => {
  it("records one entry when the same point is pushed twice", async () => {
    const { do: shardDO } = await shard();

    const firstSeq = await accept(shardDO, { value: 10, ts: 100 });
    expect(firstSeq).toBe(0);
    const ringAfterFirst = await shardDO.getRing(DEVICE);
    expect(ringAfterFirst).toHaveLength(1);

    // The SAME point, byte for byte: same device, variable, value and ts.
    const retry = await send(shardDO, { value: 10, ts: 100 });
    expect(retry.accepted).toBe(false);
    if (retry.accepted) throw new Error("unreachable");
    expect(retry.reason).toBe("seen");
    expect(retry.latestTs).toBe(100);

    // Ring size unchanged on the second send — no double-count.
    const ringAfterRetry = await shardDO.getRing(DEVICE);
    expect(ringAfterRetry).toHaveLength(ringAfterFirst.length);
    expect(ringAfterRetry).toHaveLength(1);

    // No seq was consumed: the next genuine reading still takes seq 1.
    const nextSeq = await accept(shardDO, { value: 11, ts: 101 });
    expect(nextSeq).toBe(1);
  });

  it("does not double-count across many re-deliveries", async () => {
    const { do: shardDO } = await shard();
    await accept(shardDO, { value: 7, ts: 500 });

    for (let i = 0; i < 5; i += 1) {
      const retry = await send(shardDO, { value: 7, ts: 500 });
      expect(retry).toMatchObject({ accepted: false, reason: "seen" });
    }

    expect(await shardDO.getRing(DEVICE)).toHaveLength(1);
    expect(shardDO.getDropped()).toBe(0);
  });

  it("records a genuinely different point at a new ts", async () => {
    const { do: shardDO } = await shard();
    await accept(shardDO, { value: 10, ts: 100 });

    const seq = await accept(shardDO, { value: 11, ts: 101 });
    expect(seq).toBe(1);

    const ring = await shardDO.getRing(DEVICE);
    expect(ring.map((row) => row.ts)).toEqual([100, 101]);
    expect(ring.map((row) => row.value)).toEqual([10, 11]);
  });

  it("treats a same-ts change as a re-delivery at the stream's existing seq, not a new point", async () => {
    const { do: shardDO } = await shard();
    await accept(shardDO, { value: 1, ts: 100 });

    // Identity is `(device, metric, ts, seq)`. `ingest` derives `seq` from the
    // stream, so a change at the SAME ts reuses the seq already assigned: it is
    // the stream's current point re-sent and is refused as "seen" rather than
    // silently overwriting. The stored reading stands.
    const resend = await send(shardDO, { value: 2, ts: 100 });
    expect(resend).toMatchObject({ accepted: false, reason: "seen" });

    const ring = await shardDO.getRing(DEVICE);
    expect(ring).toHaveLength(1);
    expect(ring.map((row) => row.value)).toEqual([1]);
  });

  it("still rejects a stale ts after a point was deduped (INV-T1)", async () => {
    const { do: shardDO } = await shard();
    await accept(shardDO, { value: 10, ts: 100 });
    await send(shardDO, { value: 10, ts: 100 }); // duplicate, rejected as "seen"

    const stale = await send(shardDO, { value: 9, ts: 99 });
    expect(stale.accepted).toBe(false);
    if (stale.accepted) throw new Error("unreachable");
    expect(stale.reason).toBe("out_of_order");
    expect(stale.latestTs).toBe(100);

    // State and ring are untouched, and the next accept takes the next seq.
    expect(shardDO.getState(DEVICE, METRIC)[0]).toMatchObject({ value: 10, ts: 100, seq: 0 });
    expect(await shardDO.getRing(DEVICE)).toHaveLength(1);
    expect(await accept(shardDO, { value: 11, ts: 101 })).toBe(1);
  });

  it("keys dedup per stream: the same ts on another variable is not a duplicate", async () => {
    const { do: shardDO } = await shard();
    await accept(shardDO, { metric: "temperature", value: 1, ts: 100 });
    await accept(shardDO, { metric: "humidity", value: 2, ts: 100 });

    expect(await shardDO.getRing(DEVICE)).toHaveLength(2);

    // Re-sending each point is still a duplicate for its own stream only.
    expect(await send(shardDO, { metric: "temperature", value: 1, ts: 100 })).toMatchObject({
      accepted: false,
      reason: "seen",
    });
    expect(await send(shardDO, { metric: "humidity", value: 2, ts: 100 })).toMatchObject({
      accepted: false,
      reason: "seen",
    });
    expect(await shardDO.getRing(DEVICE)).toHaveLength(2);
  });

  it("does not treat the same ts and value from a different device as a duplicate", async () => {
    const { do: shardDO } = await shard();
    await accept(shardDO, { device: DEVICE, value: 1, ts: 100 });
    await accept(shardDO, { device: "dev_beta", value: 1, ts: 100 });

    expect(await shardDO.getRing(DEVICE)).toHaveLength(1);
    expect(await shardDO.getRing("dev_beta")).toHaveLength(1);
  });

  it("treats a null reading as a recorded point, not a missing one", async () => {
    const { do: shardDO } = await shard();
    // `null` is a valid reading. The first arrival is recorded (its identity
    // enters `seenPoints`); the identical retry is the stored point re-sent.
    const seq = await accept(shardDO, { value: null, ts: 100 });
    expect(seq).toBe(0);

    const retry = await send(shardDO, { value: null, ts: 100 });
    expect(retry).toMatchObject({ accepted: false, reason: "seen" });

    const ring = await shardDO.getRing(DEVICE);
    expect(ring).toHaveLength(1);
    expect(ring.map((row) => row.value)).toEqual([null]);
  });

  it("keeps the journal honest: a deduped point is journalled once", async () => {
    const { do: shardDO, storage } = await shard();
    await accept(shardDO, { value: 1, ts: 100 });
    await send(shardDO, { value: 1, ts: 100 });

    const inflight: Sample[] = await storage.inflight(DEVICE);
    expect(inflight).toHaveLength(1);
    expect(inflight[0]).toMatchObject({ device: DEVICE, metric: METRIC, ts: 100, seq: 0 });
  });
});
