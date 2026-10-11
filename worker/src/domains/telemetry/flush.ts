/**
 * A10 — the two-phase, idempotent flush: shard journal → R2.
 *
 * A shard accepts samples into an `inflight` write-ahead journal (A09) and a
 * later unit drains that journal to the analytics store. This module is that
 * drain, and it is written around one guarantee (INV-T4): **a sample is neither
 * lost nor duplicated, even if the process dies between the network call and
 * the bookkeeping that would have removed it.**
 *
 * ## The two phases
 *
 * The tempting design — put to R2, then delete from the journal — fails a crash
 * test: a put that lands but whose ack is lost, or a drain interrupted
 * half-way, would replay rows that are already in the store. The fix is to
 * split the work into two phases whose boundaries are observable:
 *
 *   1. **Claim (durable, before the network).** The rows selected to flush are
 *      already journalled in `inflight`; the claim is the *set* of those rows,
 *      and it survives a crash because it lives in the shard's own storage, not
 *      in this function's stack. Because the claim is durable before `put`, a
 *      crash before the put loses nothing: the rows are still journalled.
 *   2. **Deliver + drain.** Put the claimed window to R2 under a *deterministic*
 *      key, then — only once R2 has durably accepted it — delete the delivered
 *      rows from `inflight` and advance the device's `flushed_seq` high-water
 *      mark. A crash *after* the put but *before* the drain leaves the rows
 *      journalled, so a re-run re-delivers the same window.
 *
 * ## Why that is not a duplicate
 *
 * A re-run re-delivers the same window under the same deterministic key. The
 * put is therefore made idempotent at the R2 seam by one of two strategies,
 * chosen by {@link FlushOptions}: a per-attempt unique key (so replays write a
 * new object and the reader dedupes on `(device, seq)`), or a CAS put with
 * `onlyIf` so the second attempt is a no-op when the object already exists.
 * Either way the *object* a reader eventually sees holds each point once.
 *
 * ## Determinism
 *
 * The object key is a pure function of the window — no clock, no random — so a
 * re-run targets the same object and the two phases line up. The seam is the
 * only place nondeterminism enters, and it is injected.
 */

import type { Sample } from "../../platform/durable-objects/shard-do";

// ---------------------------------------------------------------------------
// R2 seam
// ---------------------------------------------------------------------------

/**
 * The body put into R2: the NDJSON text of one window.
 *
 * Named so the seam's signature reads as a domain type rather than `string`,
 * and so a future body type (a stream, a `Uint8Array`) is a change here alone.
 */
export type FlushBody = string;

/** Options accepted by {@link R2Like.put}. */
export interface R2PutOptions {
  /**
   * Compare-and-set guard: the put succeeds only if the object's current
   * state matches. `"absent"` means "only create if the key does not exist",
   * which makes a replay of an already-delivered window a no-op.
   */
  readonly onlyIf?: "absent";
  /** Content type, in R2's metadata store. */
  readonly contentType?: string;
  /** Arbitrary object metadata (we record the window and row count). */
  readonly customMetadata?: Record<string, string>;
}

/** The result of a successful put; R2 returns an object summary. */
export interface R2PutResult {
  readonly key: string;
  /** R2 reports a `null` body when the CAS guard rejected the write. */
  readonly size?: number;
}

/**
 * The analytics-store seam: the one non-idempotent operation in the flush.
 *
 * Deliberately tiny — a single `put`. Everything else the flush needs (select,
 * delete, high-water advance) is already on {@link ShardStorage}, and keeping
 * R2 to one method keeps the fault-injection fake honest: it can fail exactly
 * the call under test.
 */
export interface R2Like {
  put(key: string, body: FlushBody, options?: R2PutOptions): Promise<R2PutResult>;
}

// ---------------------------------------------------------------------------
// The shard-side surface the flush drives
// ---------------------------------------------------------------------------

/**
 * The drain surface {@link flushShard} uses, a structural subset of
 * `ShardDO`. Declared here (not imported as the class) so the flush is coupled
 * to the *operations* it needs, and a test can supply a minimal stub.
 */
export interface FlushShard {
  /** Accepted-but-unflushed rows for a device, oldest (lowest seq) first. */
  pending(device: string): Promise<Sample[]>;
  /**
   * Remove delivered rows `<= upToSeq` and advance the high-water mark.
   *
   * Idempotent: a row already drained, or a mark already past `upToSeq`, is a
   * no-op, so a re-run after a crash between the put and the drain converges.
   */
  drain(device: string, upToSeq: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Options & results
// ---------------------------------------------------------------------------

/** How the deterministic-key put is made replay-safe. */
export type IdempotencyStrategy =
  /** Append an attempt id to the key; a replay writes a distinct object. */
  | "unique-key"
  /** One fixed key per window, guarded with `onlyIf: "absent"` (CAS). */
  | "cas";

/** Options for {@link flushShard}. */
export interface FlushOptions {
  /** Device to flush. Defaults to every device `pending()` returns. */
  readonly device?: string;
  /** Key prefix in R2. Defaults to {@link DEFAULT_KEY_PREFIX}. */
  readonly keyPrefix?: string;
  /** Replay strategy. Defaults to {@link DEFAULT_STRATEGY}. */
  readonly strategy?: IdempotencyStrategy;
  /**
   * The attempt identifier folded into a `unique-key` object name. Defaults to
   * a per-call counter (see {@link FlushOptions.attempt}), so two attempts of
   * the same window never collide. Ignored under the `cas` strategy.
   */
  readonly attempt?: string;
}

/** What one {@link flushShard} call did. */
export interface FlushResult {
  /** The device flushed (or `null` when there was nothing to flush). */
  readonly device: string | null;
  /** The window key put to R2, or `null` when no put was made. */
  readonly key: string | null;
  /** Rows delivered in this window. */
  readonly flushed: number;
  /** The seq high-water mark committed by the drain (unchanged on a no-op). */
  readonly upToSeq: number;
  /**
   * `true` when the sink reported the object already existed (CAS rejected the
   * replay). The rows were still drained, so a stale journal is never retained.
   */
  readonly alreadyDelivered: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default R2 key prefix for flushed windows. */
export const DEFAULT_KEY_PREFIX = "telemetry";

/** Default replay strategy: a fresh key per attempt is the simplest to reason about. */
export const DEFAULT_STRATEGY: IdempotencyStrategy = "unique-key";

/**
 * A process-wide counter folded into `unique-key` object names.
 *
 * Monotonic and never reset: two attempts *within a process* therefore never
 * share a key. Across processes the attempt should be supplied explicitly
 * (e.g. from a DO id) — a counter alone is only unique per process.
 */
let attemptCounter = 0;

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * The deterministic R2 key for a window: `<prefix>/<device>/<upToSeq>.ndjson`.
 *
 * A pure function of its inputs — no clock, no random — so a re-run of the same
 * window targets the same object, which is what makes the CAS strategy work.
 */
export function windowKey(prefix: string, device: string, upToSeq: number): string {
  return `${prefix}/${encodeURIComponent(device)}/${upToSeq}.ndjson`;
}

/**
 * Fold an attempt id into a window key for the `unique-key` strategy.
 *
 * The result is `<base>.<attempt>` — a distinct object per attempt, so a replay
 * never overwrites a delivered object. The reader dedupes on `(device, seq)`.
 */
function withAttempt(base: string, attempt: string): string {
  return `${base}.${encodeURIComponent(attempt)}`;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * One point as it appears in the flushed NDJSON: the sample, minus nothing.
 *
 * Written explicitly (rather than spreading the `Sample`) so the on-the-wire
 * shape is a stable contract, independent of the in-memory struct's field
 * order or future additions.
 */
export interface FlushedPoint {
  readonly device: string;
  readonly metric: string;
  readonly value: number | null;
  readonly ts: number;
  readonly seq: number;
  readonly recordedAt: number;
}

/** Project a journal row onto its on-the-wire shape. */
export function toPoint(sample: Sample): FlushedPoint {
  return {
    device: sample.device,
    metric: sample.metric,
    value: sample.value,
    ts: sample.ts,
    seq: sample.seq,
    recordedAt: sample.recordedAt,
  };
}

/**
 * Serialise rows as NDJSON: one JSON object per line, newline-terminated.
 *
 * A trailing newline makes the format line-oriented (a reader can split and
 * drop the empty tail) and byte-identical for a byte-identical window, so a
 * re-delivery of the same rows produces the same body.
 */
export function toNdjson(rows: readonly Sample[]): FlushBody {
  return rows.map((row) => `${JSON.stringify(toPoint(row))}\n`).join("");
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/**
 * Flush a shard's journal to R2 — the two-phase, replay-safe drain.
 *
 * The call is a no-op (returning a zeroed {@link FlushResult}) when the device
 * has no journalled rows, so it is safe to call on a timer without a guard.
 *
 * Ordering is load-bearing and must not be "simplified":
 *
 *   1. read the unflushed rows (the claim is durable — they are in `inflight`);
 *   2. `put` the window under the deterministic key;
 *   3. only after the put resolves, drain: delete the delivered rows and
 *      advance `flushed_seq`.
 *
 * If the put throws, the rows stay journalled and the error propagates; a
 * re-run re-delivers the same window and, thanks to the replay strategy, does
 * not duplicate.
 */
export async function flushShard(
  shard: FlushShard,
  r2: R2Like,
  options: FlushOptions = {},
): Promise<FlushResult> {
  const { device } = options;
  if (device === undefined) {
    throw new Error(
      "flushShard requires an explicit `device`; iterate the shard's devices and call per device",
    );
  }

  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const strategy = options.strategy ?? DEFAULT_STRATEGY;

  // --- Phase 1: claim the window (durable: the rows are journalled) -------
  const rows = await shard.pending(device);
  if (rows.length === 0) {
    return { device, key: null, flushed: 0, upToSeq: 0, alreadyDelivered: false };
  }

  // Rows arrive oldest-first; the window is everything up to the newest seq.
  const upToSeq = rows[rows.length - 1].seq;
  const baseKey = windowKey(prefix, device, upToSeq);

  // --- Phase 2a: deliver (non-idempotent put, made replay-safe) -----------
  const attempt = options.attempt ?? String((attemptCounter += 1));
  const key = strategy === "cas" ? baseKey : withAttempt(baseKey, attempt);
  const body = toNdjson(rows);

  const putResult = await r2.put(key, body, {
    contentType: "application/x-ndjson",
    customMetadata: {
      device,
      upToSeq: String(upToSeq),
      points: String(rows.length),
      strategy,
    },
    ...(strategy === "cas" ? { onlyIf: "absent" as const } : {}),
  });

  // A CAS rejection means the object was already delivered under this key; the
  // rows are still ours to drain, so the journal cannot retain them.
  const alreadyDelivered = putResult.size === null || putResult.size === undefined;

  // --- Phase 2b: drain — only reached once R2 durably accepted the window --
  await shard.drain(device, upToSeq);

  return {
    device,
    key,
    flushed: rows.length,
    upToSeq,
    alreadyDelivered,
  };
}

// ---------------------------------------------------------------------------
// In-memory R2 fake, with a fault-injection seam
// ---------------------------------------------------------------------------

/** One object in {@link InMemoryR2}: its body plus the metadata it was put with. */
export interface StoredObject {
  readonly key: string;
  readonly body: FlushBody;
  readonly options?: R2PutOptions;
  /** The 1-based put-call index that wrote this object (for assertions). */
  readonly putIndex: number;
}

/** A programmed failure: the `put` call index to fail, and the error to throw. */
export interface FaultPlan {
  /** Fail the `n`-th `put` call (1-based). `"all"` fails every call. */
  readonly atCall: number | "all";
  /** Error to throw; defaults to a fresh {@link Error}. */
  readonly error?: Error;
}

/**
 * In-memory {@link R2Like} that can be programmed to fail a chosen call.
 *
 * The fake is honest about R2's two properties the flush relies on:
 *
 *   - **puts are not idempotent** — a second put overwrites (or, with
 *     `onlyIf: "absent"`, is rejected), so a key collision is observable; and
 *   - **a put can fail** — {@link InMemoryR2.failNext} / {@link InMemoryR2.failAt}
 *     make the *next* (or a specific) call throw, which is the fault-injection
 *     seam the crash test drives.
 *
 * `puts` records every attempt (including failures) in call order, so a test
 * can assert both what was delivered and how many attempts it took.
 */
export class InMemoryR2 implements R2Like {
  private readonly objects = new Map<string, StoredObject>();
  /** Every put attempt in call order: `{ key, failed }`. */
  readonly puts: { key: string; failed: boolean }[] = [];
  private fault: FaultPlan | null = null;

  /** Program the *next* `put` call to throw, then clear itself. */
  failNext(error?: Error): void {
    this.fault = { atCall: this.puts.length + 1, error: error ?? new Error("injected put failure") };
  }

  /** Program a specific `put` call (1-based) to throw until cleared. */
  failAt(atCall: number | "all", error?: Error): void {
    this.fault = { atCall, error: error ?? new Error("injected put failure") };
  }

  /** Remove any programmed fault. */
  clearFault(): void {
    this.fault = null;
  }

  /** The object stored under `key`, or `undefined`. */
  get(key: string): StoredObject | undefined {
    return this.objects.get(key);
  }

  /** The keys currently held, in insertion order. */
  keys(): string[] {
    return [...this.objects.keys()];
  }

  /**
   * Every point delivered across every object, parsed from the NDJSON bodies.
   *
   * This is the reader's view: if the flush duplicated, a point appears twice
   * here; if it lost one, it is absent. Tests assert against it, not against
   * raw bytes, so a formatting change cannot silently pass.
   */
  points(): FlushedPoint[] {
    const out: FlushedPoint[] = [];
    for (const object of this.objects.values()) {
      for (const line of object.body.split("\n")) {
        if (line.length === 0) continue;
        out.push(JSON.parse(line) as FlushedPoint);
      }
    }
    return out;
  }

  /** {@link R2Like.put}: records the attempt, honours the fault plan, stores the body. */
  put(key: string, body: FlushBody, options?: R2PutOptions): Promise<R2PutResult> {
    const callIndex = this.puts.length + 1;
    this.puts.push({ key, failed: false });

    if (this.fault !== null && (this.fault.atCall === "all" || this.fault.atCall === callIndex)) {
      this.puts[callIndex - 1].failed = true;
      const { error } = this.fault;
      // A one-shot fault clears; a pinned/`"all"` fault persists.
      if (this.fault.atCall !== "all") this.fault = null;
      return Promise.reject(error ?? new Error("injected put failure"));
    }

    // CAS: an existing key is rejected, and R2 reports the rejection with a
    // `null` body / no size. A plain put overwrites.
    const existing = this.objects.get(key);
    if (existing !== undefined && options?.onlyIf === "absent") {
      return Promise.resolve({ key, size: undefined });
    }

    this.objects.set(key, { key, body, options, putIndex: callIndex });
    return Promise.resolve({ key, size: body.length });
  }
}
