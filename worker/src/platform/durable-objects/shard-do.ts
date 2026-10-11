/**
 * ShardDO — the write path for one telemetry shard.
 *
 * A shard owns a slice of the device keyspace (see {@link shardIndex}). Every
 * accepted sample is appended to a bounded ring buffer per `(device, metric)`
 * stream and journalled to `inflight`, where a later unit (A10) drains it
 * downstream to the analytics store.
 *
 * ## Seams
 *
 * The class is a plain class with no Cloudflare types in its signature:
 *
 *   - **storage** — a {@link ShardStorage} seam, modelling rows and ordered
 *     lists. Production passes the DO's embedded SQLite; tests pass
 *     {@link InMemoryShardStorage}. The seam is deliberately small and
 *     promise-based so both implementations satisfy it identically.
 *   - **clock** — a `now()` function returning Unix epoch milliseconds. Tests
 *     pin it, so `recordedAt` is exactly knowable and no `Date.now()` leaks in.
 *
 * ## Ordering (INV-T1 / INV-T2)
 *
 * A stream accepts a sample only if it moves time forward:
 *
 *   - `ts > latest_ts`  → accept.
 *   - `ts < latest_ts`  → **reject** (T1). The stored latest is untouched and
 *     no seq is consumed, so a late duplicate cannot roll back a newer reading.
 *   - `ts == latest_ts` → tie-break on `seq` (T2): the strictly later arrival
 *     wins (last-write-wins at equal time), so the sample is accepted and the
 *     value is replaced while `latest_ts` stays put.
 *
 * `next_seq` is a per-stream monotonic counter. It advances *only* on accept,
 * which is what makes the rejected sample's non-advance observable in tests.
 *
 * ## Idempotency (dedup)
 *
 * The write path is delivered at least once — a device retries, the edge
 * re-delivers — so `ingest` refuses a re-delivery of the point it already
 * holds. The identity is `(device, metric, ts, seq)` and the rule that defines
 * it is owned by `domains/telemetry/dedup.ts`; this class applies it at the one
 * place a duplicate can land:
 *
 *   - `ts < latest_ts`  → `{ reason: "out_of_order" }` (the T1 gate; a stale ts
 *     is refused before identity is even considered).
 *   - `ts == latest_ts` → the incoming sample would reuse the stream's current
 *     `seq` (`seq == latest_seq`), so its identity is exactly that of the stored
 *     point: refused as `{ reason: "seen" }`, with the ring, seq counter and
 *     projection untouched. A retry of an already-accepted point therefore
 *     collapses onto the entry that exists and cannot be double-counted.
 *   - `ts > latest_ts`  → accepted and assigned a fresh `seq`, even at a ts the
 *     stream has not seen; this is the only way a *new* point is recorded.
 *
 * A producer that wants to express an INV-T2 tie in-band (same instant, fresh
 * seq) does so by calling `ingest` with the fresh `seq`; the bare API reuses
 * `latest_seq` for the tie, which is what makes a retry idempotent. See the
 * case notes on {@link ShardDO.ingest} and the `streamKeyOf` helper for why
 * `seq` is part of the key rather than `value`.
 *
 * ## Capacity
 *
 * Each stream's ring holds at most {@link RING_CAPACITY} rows. When a stream is
 * full, the oldest row (lowest `seq`) is evicted before the new one is
 * appended (FIFO), and the per-device `dropped` counter is incremented; the
 * evicted sample is still on the `inflight` journal, so eviction costs
 * dashboard history, not data.
 */

import {
  SHARD_DDL,
  shardStatements,
} from "./shard-schema";
import { dedupKey } from "../../domains/telemetry/dedup";
import type { Clock } from "../lib/clock";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum rows retained per `(device, metric)` stream before FIFO eviction. */
export const RING_CAPACITY = 1000;

/** The separator joining a device and metric into a stream key. */
const STREAM_SEPARATOR = "\u0000";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** One sample, in the shape both stores persist. */
export interface Sample {
  readonly device: string;
  readonly metric: string;
  /** `null` is a valid reading, so it is not conflated with "absent". */
  readonly value: number | null;
  readonly ts: number;
  readonly seq: number;
  readonly recordedAt: number;
}

/** The ordering/projection state for one `(device, metric)` stream. */
export interface StreamMeta {
  readonly device: string;
  readonly metric: string;
  /** Timestamp of the latest accepted sample, or `null` before the first. */
  readonly latestTs: number | null;
  readonly latestValue: number | null;
  /** Seq of the latest accepted sample (0 before the first). */
  readonly latestSeq: number;
  /** Monotonic seq high-water mark; the next accepted sample takes this value. */
  readonly nextSeq: number;
  /** Rows evicted for this stream (also aggregated per device). */
  readonly dropped: number;
}

/**
 * Persistence seam for a shard.
 *
 * Small on purpose: five operations, all promise-based, no SQL type in sight.
 * {@link InMemoryShardStorage} is an honest implementation of exactly these
 * semantics; the production class adapts `ctx.storage.sql` onto them.
 */
export interface ShardStorage {
  /** The full DDL, as statements, for the adapter to execute on construction. */
  ddl(): string[];
  /** Stream ordering state, or `null` when the stream has never been seen. */
  getMeta(device: string, metric: string): Promise<StreamMeta | null>;
  /** Upsert stream ordering state. */
  putMeta(meta: StreamMeta): Promise<void>;
  /** Append a sample to the live ring buffer for its stream. */
  appendRing(sample: Sample): Promise<void>;
  /** Append a sample to the drain journal. */
  appendInflight(sample: Sample): Promise<void>;
  /** Ascending-seq ring rows for one stream (oldest first). */
  ring(device: string, metric: string): Promise<Sample[]>;
  /** Ascending-seq inflight rows for one device (oldest first). */
  inflight(device: string): Promise<Sample[]>;
  /** Remove one ring row by stream + seq (the FIFO head). */
  evictRingOldest(device: string, metric: string): Promise<void>;
  /** Every stream's ordering state, for priming the projection on `init`. */
  listMeta(): Promise<StreamMeta[]>;
  /** Per-device ring occupancy. */
  ringCount(device: string): Promise<number>;
  /** Per-device dropped total across all streams. */
  dropped(device: string): Promise<number>;

  // --- Drain surface (A10 flush) --------------------------------------
  // The second half of the write-ahead protocol: a flush claims rows to put
  // them in flight, then, only once R2 has durably accepted them, drains them
  // so they are never emitted again (INV-T4). Both are idempotent, so a
  // re-run after a crash between the put and the drain neither loses nor
  // duplicates a point.

  /**
   * Remove a delivered inflight row by `(device, seq)`.
   *
   * Idempotent: deleting an already-drained row is a no-op, so a drain that
   * is retried after a partial crash is safe to repeat wholesale.
   */
  deleteInflight(device: string, seq: number): Promise<void>;

  /**
   * Advance a device's flush high-water mark to `upToSeq`.
   *
   * Monotonic: a value below the stored mark is ignored, so a retry of an
   * older drain can never roll the mark backwards. This is the durable
   * record of "every seq `<= upToSeq` has reached the analytics store".
   */
  commitFlushed(device: string, upToSeq: number): Promise<void>;

  /** The device's durable flush high-water mark (0 when never flushed). */
  flushedTo(device: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

/** Outcome of an {@link ShardDO.ingest} call. */
export type IngestResult =
  | { readonly accepted: true; readonly seq: number }
  | {
      readonly accepted: false;
      readonly reason: "out_of_order";
      /** The stored latest ts the sample failed to beat. */
      readonly latestTs: number;
      readonly latestSeq: number;
    }
  | {
      /**
       * A re-delivery of the stream's current point: `(device, metric, ts)`
       * match the stored latest. No entry was created and no seq consumed.
       * The identity rule is owned by `domains/telemetry/dedup.ts`.
       */
      readonly accepted: false;
      readonly reason: "seen";
      readonly latestTs: number;
      readonly latestSeq: number;
    };

/** The projected state of one metric stream. */
export interface MetricState {
  readonly device: string;
  readonly metric: string;
  readonly value: number | null;
  readonly ts: number;
  readonly seq: number;
}

/** Construction options for {@link ShardDO}. */
export interface ShardDOOptions {
  readonly storage: ShardStorage;
  /** Clock returning Unix epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: Clock;
  /** Ring capacity override; defaults to {@link RING_CAPACITY}. */
  readonly ringCapacity?: number;
}

// ---------------------------------------------------------------------------
// ShardDO
// ---------------------------------------------------------------------------

/** Join a device and metric into a single map key (both may contain anything). */
function streamKey(device: string, metric: string): string {
  return `${device}${STREAM_SEPARATOR}${metric}`;
}

/**
 * The identity key for a stream's current point: `device`, `metric`, `ts`, `seq`.
 *
 * Composes the shard's stream key with the shared `dedupKey` so the record's
 * identity `(device, variable, ts, seq)` is expressed in one place — the rule
 * lives in `domains/telemetry/dedup.ts`, and this is the shard's `metric`
 * (= variable) spelled into it.
 */
function streamKeyOf(device: string, metric: string, ts: number, seq: number): string {
  return dedupKey({ device, variable: metric, ts, seq });
}

/** Split a stream key back into its device and metric. */
function splitStreamKey(key: string): { device: string; metric: string } {
  const at = key.indexOf(STREAM_SEPARATOR);
  return { device: key.slice(0, at), metric: key.slice(at + 1) };
}

/**
 * The shard write path. Construct with {@link ShardDOOptions}; call
 * {@link ShardDO.init} once to apply the DDL, then {@link ShardDO.ingest}.
 */
export class ShardDO {
  private readonly storage: ShardStorage;
  private readonly clock: Clock;
  private readonly capacity: number;
  /** Stream state, keyed by `device \0 metric`, mirrored into `storage`. */
  private readonly streams = new Map<string, StreamMeta>();
  /** Per-device dropped totals, so `getDropped()` needs no storage round-trip. */
  private readonly droppedByDevice = new Map<string, number>();
  /**
   * Identities `(device, metric, ts, seq)` already recorded — the dedup gate.
   * One entry per live stream (each accept overwrites its stream's entry), so
   * the set is bounded by `streams.size`. It answers the one question the bare
   * `ingest` API can pose: "is this the stream's current point, re-sent?" A
   * stale ts never reaches it (T1 rejects first), so no older point needs a
   * slot here.
   */
  private readonly seenPoints = new Set<string>();

  constructor(options: ShardDOOptions) {
    this.storage = options.storage;
    this.clock = options.now ?? (() => Date.now());
    this.capacity = options.ringCapacity ?? RING_CAPACITY;
  }

  /**
   * Apply the shard DDL and prime the in-memory projection from storage.
   *
   * Idempotent: the DDL uses `IF NOT EXISTS`, and re-reading the metas of an
   * already-populated shard rebuilds exactly the same map. The statements are
   * handed to the adapter, which executes them; `InMemoryShardStorage` is born
   * with its tables already present.
   */
  async init(): Promise<void> {
    this.storage.ddl();
    for (const meta of await this.storage.listMeta()) {
      this.streams.set(streamKey(meta.device, meta.metric), meta);
      this.droppedByDevice.set(
        meta.device,
        (this.droppedByDevice.get(meta.device) ?? 0) + meta.dropped,
      );
    }
  }

  /**
   * Accept or reject one sample.
   *
   * See the class docblock for the ordering rules; the returned
   * {@link IngestResult} is a value, never a throw, so the caller maps it onto
   * whatever transport it is using.
   *
   * `seq` is assigned here from the stream's monotonic counter, which is what
   * tells a re-delivery from a new reading at an equal `ts`: an identical
   * `(device, metric, ts)` reuses the stored point's `seq` and is refused
   * `{ reason: "seen" }` (dedup), while a reading at a strictly newer `ts` takes
   * a fresh `seq` and is accepted.
   */
  async ingest(input: {
    device: string;
    metric: string;
    value: number | null;
    ts: number;
  }): Promise<IngestResult> {
    const { device, metric, value, ts } = input;
    const key = streamKey(device, metric);
    const existing = this.streams.get(key) ?? null;

    // --- Ordering gate (INV-T1 / INV-T2) --------------------------------
    if (existing !== null && existing.latestTs !== null) {
      if (ts < existing.latestTs) {
        // T1: strictly stale. Reject without touching latest or nextSeq.
        return {
          accepted: false,
          reason: "out_of_order",
          latestTs: existing.latestTs,
          latestSeq: existing.latestSeq,
        };
      }
      // T2: an equal ts is LWW, tie-broken by seq. Because `ingest` derives
      // `seq` from the stream, a same-ts arrival reuses the stored point's
      // identity `(device, metric, ts, latest_seq)` — i.e. it *is* the stored
      // point re-sent — so it is refused as a re-delivery rather than admitted.
      // A stale ts is refused earlier (T1); a strictly newer ts is admitted
      // below with a fresh seq. See `domains/telemetry/dedup.ts` for the rule.
      if (ts === existing.latestTs) {
        // Dedup gate — identity `(device, metric, ts, seq)`. Without this, a
        // retried at-least-once delivery would append a second ring row
        // (double-count) and burn a seq. Reject without touching latest, ring
        // or nextSeq, mirroring the T1 path.
        const id = streamKeyOf(device, metric, ts, existing.latestSeq);
        for (const key of this.seenPoints) {
          if (key === id) {
            return {
              accepted: false,
              reason: "seen",
              latestTs: existing.latestTs,
              latestSeq: existing.latestSeq,
            };
          }
        }
        this.seenPoints.add(id);
      }
    }

    const seq = existing?.nextSeq ?? 0;
    const recordedAt = this.clock();

    // --- Capacity: FIFO-evict before appending when the ring is full ----
    const current = await this.storage.ring(device, metric);
    let dropped = existing?.dropped ?? 0;
    if (current.length >= this.capacity) {
      await this.storage.evictRingOldest(device, metric);
      dropped += 1;
      this.droppedByDevice.set(device, (this.droppedByDevice.get(device) ?? 0) + 1);
    }

    const next: StreamMeta = {
      device,
      metric,
      latestTs: ts,
      latestValue: value,
      latestSeq: seq,
      nextSeq: seq + 1,
      dropped,
    };

    const sample: Sample = { device, metric, value, ts, seq, recordedAt };

    await this.storage.appendRing(sample);
    await this.storage.appendInflight(sample);
    await this.storage.putMeta(next);

    // Record the accepted point's identity, replacing the stream's previous
    // one (one entry per live stream — see the `seenPoints` field).
    this.seenPoints.add(streamKeyOf(device, metric, ts, seq));

    this.streams.set(key, next);

    return { accepted: true, seq };
  }

  /**
   * Projected state.
   *
   *   - `getState()`                → every stream in the shard.
   *   - `getState(device)`          → every stream of one device.
   *   - `getState(device, metric)`  → exactly that stream (empty when unseen).
   */
  getState(device?: string, metric?: string): MetricState[] {
    const out: MetricState[] = [];
    for (const meta of this.streams.values()) {
      if (meta.latestTs === null) continue;
      if (device !== undefined && meta.device !== device) continue;
      if (metric !== undefined && meta.metric !== metric) continue;
      out.push({
        device: meta.device,
        metric: meta.metric,
        value: meta.latestValue,
        ts: meta.latestTs,
        seq: meta.latestSeq,
      });
    }
    return out;
  }

  /** The ring buffer of one device — every stream, oldest sample first. */
  async getRing(device: string): Promise<Sample[]> {
    const metas = [...this.streams.values()].filter((m) => m.device === device);
    const rows: Sample[] = [];
    for (const meta of metas) {
      rows.push(...(await this.storage.ring(meta.device, meta.metric)));
    }
    return rows.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Samples accepted but not yet flushed downstream.
   *
   *   - `pending()`          → the whole shard's inflight rows.
   *   - `pending(device)`    → one device's inflight rows.
   *
   * A10's drain consumes exactly this; how rows leave the journal is its
   * concern, not this unit's.
   */
  async pending(device?: string): Promise<Sample[]> {
    if (device !== undefined) return this.storage.inflight(device);
    const rows: Sample[] = [];
    for (const d of this.devices()) rows.push(...(await this.storage.inflight(d)));
    return rows.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Drain delivered rows from the journal — the second half of the flush.
   *
   * Called by {@link flushShard} *after* R2 has durably accepted a window, so
   * that a row is deleted only once it can no longer be lost. Both steps are
   * idempotent: `deleteInflight` tolerates a row that is already gone, and
   * `commitFlushed` refuses to move the high-water mark backwards. A drain
   * interrupted half-way and re-run therefore converges to the same state.
   *
   * Returns the high-water mark it committed.
   */
  async drain(device: string, upToSeq: number): Promise<number> {
    const rows = await this.storage.inflight(device);
    for (const row of rows) {
      if (row.seq <= upToSeq) await this.storage.deleteInflight(device, row.seq);
    }
    await this.storage.commitFlushed(device, upToSeq);
    return upToSeq;
  }

  /**
   * Samples evicted from the ring buffer because a stream was full.
   *
   * `getDropped()` is the whole-shard total (the sum over devices); passing a
   * device narrows it to that device. Rows accepted but not yet flushed are a
   * different question — ask {@link ShardDO.pending} for those.
   */
  getDropped(device?: string): number {
    if (device !== undefined) return this.droppedByDevice.get(device) ?? 0;
    let total = 0;
    for (const count of this.droppedByDevice.values()) total += count;
    return total;
  }

  /** Every device this shard has seen. */
  private devices(): string[] {
    const seen = new Set<string>();
    for (const meta of this.streams.values()) seen.add(meta.device);
    return [...seen];
  }
}

// ---------------------------------------------------------------------------
// In-memory storage — an honest implementation of ShardStorage, for tests
// ---------------------------------------------------------------------------

/**
 * In-memory {@link ShardStorage}.
 *
 * Models the DO's SQLite closely enough that a test failure here is a failure
 * of the shard's logic, not of the fake: rows are per stream and per device,
 * reads are ordered, and eviction removes the oldest row of a stream by seq.
 */
export class InMemoryShardStorage implements ShardStorage {
  private readonly metas = new Map<string, StreamMeta>();
  private readonly rings = new Map<string, Sample[]>();
  private readonly journals = new Map<string, Sample[]>();
  /** Per-device flush high-water mark, mirroring `flush_meta.flushed_seq`. */
  private readonly flushed = new Map<string, number>();

  /** Rows of one stream, oldest first (a copy, so callers cannot mutate it). */
  ring(device: string, metric: string): Promise<Sample[]> {
    return Promise.resolve([...(this.rings.get(streamKey(device, metric)) ?? [])]);
  }

  /** Rows of one device's journal, oldest first. */
  inflight(device: string): Promise<Sample[]> {
    return Promise.resolve([...(this.journals.get(device) ?? [])]);
  }

  /** Drop the oldest ring row of one stream, if any. */
  evictRingOldest(device: string, metric: string): Promise<void> {
    const key = streamKey(device, metric);
    const rows = this.rings.get(key);
    if (rows && rows.length > 0) {
      this.rings.set(key, rows.slice(1));
    }
    return Promise.resolve();
  }

  /** Stream ordering state, or `null` when the stream has never been seen. */
  getMeta(device: string, metric: string): Promise<StreamMeta | null> {
    return Promise.resolve(this.metas.get(streamKey(device, metric)) ?? null);
  }

  /** Upsert stream ordering state. */
  putMeta(meta: StreamMeta): Promise<void> {
    this.metas.set(streamKey(meta.device, meta.metric), { ...meta });
    return Promise.resolve();
  }

  /** Append a sample to the ring for its stream. */
  appendRing(sample: Sample): Promise<void> {
    const key = streamKey(sample.device, sample.metric);
    const rows = this.rings.get(key) ?? [];
    rows.push({ ...sample });
    this.rings.set(key, rows);
    return Promise.resolve();
  }

  /** Append a sample to its device's drain journal. */
  appendInflight(sample: Sample): Promise<void> {
    const rows = this.journals.get(sample.device) ?? [];
    rows.push({ ...sample });
    this.journals.set(sample.device, rows);
    return Promise.resolve();
  }

  /** Per-device dropped total, summed over that device's streams. */
  dropped(device: string): Promise<number> {
    let total = 0;
    for (const meta of this.metas.values()) {
      if (meta.device === device) total += meta.dropped;
    }
    return Promise.resolve(total);
  }

  /** Remove a delivered journal row by `(device, seq)`; a no-op if absent. */
  deleteInflight(device: string, seq: number): Promise<void> {
    const rows = this.journals.get(device);
    if (rows) {
      const kept = rows.filter((row) => row.seq !== seq);
      if (kept.length === 0) this.journals.delete(device);
      else this.journals.set(device, kept);
    }
    return Promise.resolve();
  }

  /** Monotonic flush high-water mark for a device. */
  commitFlushed(device: string, upToSeq: number): Promise<void> {
    const current = this.flushed.get(device) ?? 0;
    if (upToSeq > current) this.flushed.set(device, upToSeq);
    return Promise.resolve();
  }

  /** The device's durable flush high-water mark (0 when never flushed). */
  flushedTo(device: string): Promise<number> {
    return Promise.resolve(this.flushed.get(device) ?? 0);
  }

  /** Every stream's ordering state, for priming a projection. */
  listMeta(): Promise<StreamMeta[]> {
    return Promise.resolve([...this.metas.values()].map((meta) => ({ ...meta })));
  }

  /** Per-device ring occupancy, counted across that device's streams. */
  ringCount(device: string): Promise<number> {
    let total = 0;
    for (const meta of this.metas.values()) {
      if (meta.device !== device) continue;
      total += (this.rings.get(streamKey(meta.device, meta.metric)) ?? []).length;
    }
    return Promise.resolve(total);
  }

  /** The DDL as statements; execution is the SQL adapter's job. */
  ddl(): string[] {
    return shardStatements();
  }
}

/** Re-exported so a consumer can assert on the DDL without a second import. */
export { SHARD_DDL };

// ---------------------------------------------------------------------------
// Sharding
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit offset basis and prime. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over the UTF-8 bytes of the device key, folded to a uint32.
 *
 * FNV-1a is used rather than a language hash because it is specified by its
 * constants — no seed, no version, no platform behaviour — so the same key maps
 * to the same bucket in every process, runtime and deploy.
 */
export function hashDeviceKey(deviceKey: string): number {
  const bytes = new TextEncoder().encode(deviceKey);
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    // Multiply by the FNV prime in 32-bit space (Math.imul keeps it exact).
    hash = Math.imul(hash, FNV_PRIME);
  }
  // `>>> 0` reinterprets the signed result as unsigned.
  return hash >>> 0;
}

/**
 * The shard index a device key belongs to, in `[0, totalShards)`.
 *
 * Deterministic: the same `(deviceKey, totalShards)` always yields the same
 * index, across calls and processes. Distribution is even enough for the
 * workloads here — folding FNV-1a output through a modulo spreads sequential
 * and random keys alike across the range.
 *
 * Throws on a non-positive or non-integer `totalShards`: silently returning a
 * bogus bucket would send a device's writes to the wrong shard.
 */
export function shardIndex(deviceKey: string, totalShards: number): number {
  if (!Number.isInteger(totalShards) || totalShards <= 0) {
    throw new RangeError(`totalShards must be a positive integer, got ${totalShards}`);
  }
  return hashDeviceKey(deviceKey) % totalShards;
}

/** Split a stream key — exported for consumers that store keys themselves. */
export { splitStreamKey };
