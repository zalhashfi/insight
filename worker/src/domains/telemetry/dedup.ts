/**
 * Telemetry ingest **dedup** — the identity of a point, and the one rule that
 * makes ingest idempotent under at-least-once delivery.
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
 * This module names the point. It is deliberately small and pure: **no I/O, no
 * clock, no exceptions**, so it composes with any store and any transport and is
 * trivially testable. The gate that *applies* this rule is
 * {@link ShardDO.ingest}, which refuses a re-delivery of the stream's current
 * point with `{ reason: "seen" }`.
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
 *     back onto the entry that exists. The bare `ingest` API expresses this by
 *     reusing `latest_seq` for a same-`ts` arrival, so the retry's identity is
 *     exactly the stored point's.
 *
 * `value` is deliberately **not** part of the identity. Identity means "this is
 * the same event", not "this carries the same payload": a re-delivery that
 * disagrees on `value` is still the *same* `(device, variable, ts, seq)` point,
 * and admitting it would defeat the very double-count this gate prevents.
 *
 * ### Rejected alternative: `(device, variable, ts)`
 *
 * Omitting `seq` looks simpler, but it collapses an INV-T2 tie (`ts ==
 * latest_ts`, a genuinely new reading) into the previous point and would
 * silently *drop* the newer value — a correctness bug traded for a smaller key.
 * The shard already assigns a trustworthy `seq`, so we spend it rather than
 * guess.
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
 * metadata — those are other units' concerns.
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
 * identities share a key iff all four fields are equal. {@link ShardDO.ingest}
 * keeps these in a `Set`; a persistable store could equally use the same string
 * as a `seen_points(key TEXT PRIMARY KEY)`. Either way the same string is the
 * same point.
 */
export function dedupKey(identity: PointIdentity): string {
  return [
    identity.device,
    identity.variable,
    identity.ts,
    identity.seq,
  ].join(IDENTITY_SEPARATOR);
}
