/**
 * Telemetry ingest **dedup** — the identity of a point, and a storage-agnostic
 * gate that makes ingest idempotent under at-least-once delivery.
 *
 * ## Why this unit exists
 *
 * Ingest is delivered **at least once**: a device retries on a timeout, the
 * platform edge re-delivers on a transport error, and the same sample can reach
 * a shard twice carrying identical fields. Without a dedup gate the second
 * arrival is appended as a second ring row and counted again — two entries for
 * one physical reading, a dashboard that is wrong by one, and a `next_seq` that
 * skipped a value nobody read.
 *
 * This module names the point and enforces the rule that makes re-delivery a
 * no-op. It is deliberately small and pure: **no I/O, no clock, no exceptions**,
 * so it composes with any store and any transport and is trivially testable.
 *
 * ## The identity rule (documented choice)
 *
 * A point is identified by
 *
 *     (device, variable, ts, seq)
 *
 * within a shard. Two samples are *the same point* iff all four fields are
 * equal. The reasoning for each field, and for the alternative we rejected:
 *
 *   * **device** — different devices are different points, full stop.
 *   * **variable** — a shard keys its streams by `(device, variable)`; identity
 *     must not be looser than the stream it lands in, or two variables at the
 *     same `ts`/`seq` would collide inside the gate.
 *   * **ts** — the reading's timestamp. `ts == latest_ts` under the shard's
 *     ordering rules (INV-T2) is a *tie*, resolved last-write-wins by `seq`;
 *     `ts` alone therefore cannot separate two distinct readings, which is why
 *     `seq` is part of the identity rather than folded into the value.
 *   * **seq** — the per-stream monotonic sequence the shard assigns on accept
 *     (`ShardDO.ingest`, A09). It is the *source-ordered* discriminator that `ts`
 *     is not: a device that sends two different values at the same millisecond
 *     gets two distinct `seq`s and therefore two distinct points, while a
 *     re-delivery of one point carries the `seq` it first received and folds
 *     back onto the entry that exists.
 *
 * `value` is deliberately **not** part of the identity. Identity means "this is
 * the same event", not "this carries the same payload": a re-delivery that
 * disagrees on `value` is still the *same* `(device, variable, ts, seq)` point,
 * and admitting it would defeat the very double-count this gate prevents.
 * Whether a disagreement should be reported is an observability question, and
 * {@link classifyDedup} answers it as {@link DedupOutcome.Conflict} rather than
 * silently admitting the sample.
 *
 * ### Rejected alternative: `(device, variable, ts)`
 *
 * Omitting `seq` looks simpler, but it collapses an INV-T2 tie (`ts ==
 * latest_ts`, a genuinely new reading) into the previous point and would
 * silently *drop* the newer value — a correctness bug traded for a smaller key.
 * The shard already assigns a trustworthy `seq`, so we spend it rather than
 * guess. (Note that a producer which retries a point always sends the same
 * `ts` *and* the `seq` it first received, so the retry still matches; the tie is
 * expressed by a *fresh* `seq`, which is exactly what `ShardDO.ingest` assigns a
 * reading at a newer `ts`.)
 *
 * ### Rejected alternative: `(device, variable, ts, value)`
 *
 * This treats "same instant, different value" as a distinct point. That is
 * indistinguishable from a re-delivery that changed its payload, so it re-opens
 * the double-count the gate exists to close.
 *
 * ## Scope
 *
 * The rule is scoped to a shard: `device` already determines the shard via
 * `shardIndex` (A09), so a key built from the fields above is unique within the
 * one store that holds it. This unit does not model projects, tenants or
 * metadata — those are other units' concerns (see the assignment non-goals).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Separator for the composite identity key.
 *
 * NUL (`\u0000`) cannot occur in any field: device and variable keys are
 * normalised/validated to bounded, NUL-free strings upstream, and the numeric
 * fields render as digits. So `a\0b\0c\0d` can never be produced by two
 * different tuples, and the key is injective — the property a keyed store needs.
 */
const IDENTITY_SEPARATOR = "\u0000";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** The fields that constitute a point's identity, in `(device, variable, ts, seq)` order. */
export interface PointIdentity {
  readonly device: string;
  readonly variable: string;
  /** Unix epoch milliseconds. */
  readonly ts: number;
  /** Per-stream monotonic sequence assigned on accept (A09). */
  readonly seq: number;
}

/**
 * Render a {@link PointIdentity} as the single string a keyed store indexes on.
 *
 * Pure and total: every well-formed identity maps to exactly one key, and two
 * identities share a key iff all four fields are equal. Callers may persist the
 * key (e.g. `seen_points(key TEXT PRIMARY KEY)`) or keep it in a `Set`; either
 * way the same string is the same point.
 */
export function dedupKey(identity: PointIdentity): string {
  return [
    identity.device,
    identity.variable,
    identity.ts,
    identity.seq,
  ].join(IDENTITY_SEPARATOR);
}

/** True when two identities denote the same point, field for field. */
export function isSamePoint(a: PointIdentity, b: PointIdentity): boolean {
  return (
    a.device === b.device &&
    a.variable === b.variable &&
    a.ts === b.ts &&
    a.seq === b.seq
  );
}

// ---------------------------------------------------------------------------
// Dedup gate
// ---------------------------------------------------------------------------

/** What an ingest attempt means for a point's identity. */
export const DedupOutcome = {
  /** The identity has never been seen: record it. */
  Fresh: "fresh",
  /** The identity is already recorded: the sample is a re-delivery, not a point. */
  Duplicate: "duplicate",
  /** Known identity, but the incoming payload disagrees with the recorded one. */
  Conflict: "conflict",
} as const;

export type DedupOutcome = (typeof DedupOutcome)[keyof typeof DedupOutcome];

/**
 * What a store knows about a previously-seen point's payload.
 *
 * Named as its own seam field rather than a boolean so {@link classifyDedup}
 * can tell a true re-delivery from a same-identity-different-value arrival.
 */
export interface SeenPoint {
  readonly value: number | null;
}

/** The outcome of classifying one arrival, with its reason made explicit. */
export interface DedupDecision {
  readonly outcome: DedupOutcome;
  /** What to do: `true` only for {@link DedupOutcome.Fresh}. */
  readonly record: boolean;
  /**
   * Whether the store should now remember this identity. `true` for a fresh
   * point and for a conflict (which must not be re-classified forever as
   * fresh); `false` for a duplicate, which is already remembered.
   */
  readonly remember: boolean;
}

/**
 * The storage-agnostic remember/recall seam.
 *
 * Small on purpose — three operations, all promise-based, no SQL and no
 * Cloudflare type in sight — so the gate can be driven by a `Map`, a Durable
 * Object's SQLite, or a test double with the identical shape. Mirrors the
 * sibling seams in `domains/telemetry/*` and `platform/durable-objects/*`.
 */
export interface DedupStore {
  /** The stored payload for an identity, or `null` when never seen. */
  lookup(key: string): Promise<SeenPoint | null>;
  /** Compare-and-put the payload for an identity, inserting it if absent. */
  remember(key: string, point: SeenPoint): Promise<void>;
}

/** The point being classified: its identity plus the value it carries. */
export interface IncomingPoint extends PointIdentity {
  readonly value: number | null;
}

/**
 * Classify one arrival against what the store already holds — and, when it is
 * fresh or conflicting, record it.
 *
 * The gate is **idempotent by construction**: it is a pure function of
 * `(store, point)`, and a second call with the same point finds the identity it
 * wrote and returns {@link DedupOutcome.Duplicate} without touching the store
 * again. Nothing here reads a clock or a global, so the same point always gets
 * the same answer.
 *
 * Values are compared with `Object.is`, not `===`, so `NaN` does not compare
 * unequal to itself and a stored `NaN` reading is not misread as a conflict.
 * (`null`, the one other non-number reading, is handled by `===` identically.)
 */
export async function classifyDedup(
  store: DedupStore,
  point: IncomingPoint,
): Promise<DedupDecision> {
  const key = dedupKey(point);
  const seen = await store.lookup(key);

  if (seen !== null) {
    // A known identity is a re-delivery. It must never be recorded again; the
    // only question is whether its payload agrees with what we already have.
    const agrees = Object.is(seen.value, point.value);
    return {
      outcome: agrees ? DedupOutcome.Duplicate : DedupOutcome.Conflict,
      record: false,
      remember: false,
    };
  }

  await store.remember(key, { value: point.value });
  return { outcome: DedupOutcome.Fresh, record: true, remember: false };
}

// ---------------------------------------------------------------------------
// In-memory store — an honest implementation of the seam, for tests and dev
// ---------------------------------------------------------------------------

/**
 * In-memory {@link DedupStore}, keyed by {@link dedupKey}.
 *
 * Models a keyed store closely enough that a test failure here is a failure of
 * the gate's logic, not of the fake: `lookup` returns a copy so a caller cannot
 * mutate what is stored, and `remember` inserts only when the key is absent
 * (first write wins), which is what makes a re-delivery a no-op.
 */
export class InMemoryDedupStore implements DedupStore {
  private readonly seen = new Map<string, SeenPoint>();

  /** The stored payload for an identity, or `null` when never seen. */
  lookup(key: string): Promise<SeenPoint | null> {
    const point = this.seen.get(key);
    return Promise.resolve(point === undefined ? null : { ...point });
  }

  /** Insert the payload for an identity if absent; an existing key is kept. */
  remember(key: string, point: SeenPoint): Promise<void> {
    if (!this.seen.has(key)) this.seen.set(key, { ...point });
    return Promise.resolve();
  }

  /** How many distinct points are remembered (its double-count surface). */
  get size(): number {
    return this.seen.size;
  }

  /** Every remembered key, for assertions. */
  keys(): string[] {
    return [...this.seen.keys()];
  }
}
