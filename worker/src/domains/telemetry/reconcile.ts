/**
 * A12 — shard→projection reconcile.
 *
 * A shard (A09) is the authoritative write path: for every `(device, metric)`
 * stream it keeps the latest accepted `(value, ts, seq)`. A project's DO (A11)
 * holds *the current picture*, updated by pushes forwarded from the shard. When
 * a push is lost in transit — a crash between the shard's accept and the
 * projection's upsert, a dropped message, a replayed deploy — the projection
 * silently drifts *behind* the shard. Nothing reads a stale dashboard as wrong,
 * so the drift has to be repaired deliberately.
 *
 * This module is that repair, expressed as a **pure function over the existing
 * seams**: it reads the shard's authoritative latest, compares it with the
 * projection's stored row, and replays the missing point(s) through the very
 * path a live push would take ({@link ProjectDO.receivePush}). It touches no
 * storage of its own, holds no clock, and does no I/O beyond the two seams it
 * is handed — so it is trivially testable and safe to run on a timer.
 *
 * ## Convergence (ST-M5)
 *
 * "Converged" means the projection's row for a stream equals the shard's latest
 * for that stream — same `(value, ts, seq)`. After a run, every stream the
 * shard knows about is converged: a stream whose projection is missing or
 * behind has its gap replayed, and a stream already at the shard's latest is
 * left alone.
 *
 * ## Idempotency (INV-T2 / D4.5)
 *
 * The operation is idempotent **by `(device, seq)`**: a point whose `seq` the
 * projection already holds is skipped before it is ever pushed, so replaying
 * the same point — on a second run, or in a retry after a partial failure —
 * neither changes stored state nor is counted as a replay. Combined with the
 * projection's own ordering gate (which refuses to roll a stream backwards),
 * a reconcile can therefore run any number of times, concurrently or in
 * sequence, and converge to the same picture.
 */

import type {
  MetricState,
  Sample,
} from "../../platform/durable-objects/shard-do";
import type {
  PushResult,
  StateRow,
} from "../../platform/durable-objects/project-do";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The shard-side surface the reconcile reads.
 *
 * Declared structurally (not as the `ShardDO` class) so the reconcile is
 * coupled to the *reads* it needs and a test can supply a minimal stub. A real
 * {@link ShardDO} satisfies it as-is.
 *
 *   - `getState()` returns the authoritative latest `(value, ts, seq)` for
 *     every live `(device, metric)` stream — the ground truth.
 *   - `getRing(device)` returns that device's retained samples, newest-seq
 *     last, which supplies the *intermediate* points a behind projection is
 *     missing, not just the latest.
 */
export interface ReconcileShard {
  getState(device?: string, metric?: string): MetricState[];
  getRing(device: string): Promise<Sample[]>;
}

/**
 * The projection-side surface the reconcile drives.
 *
 * Declared structurally so a real {@link ProjectDO} satisfies it unchanged: it
 * reads projected rows and receives replayed points through `receivePush` —
 * the same receipt a live shard→project push uses, so a reconciled projection
 * is indistinguishable from one that never drifted.
 */
export interface ReconcileProject {
  getState(device?: string, variable?: string): StateRow[];
  receivePush(input: {
    device: string;
    variable: string;
    value: number | null;
    ts: number;
    seq: number;
  }): Promise<PushResult>;
}

/** Both ends of a reconcile: the authoritative shard and the projection to repair. */
export interface ReconcileOptions {
  readonly shard: ReconcileShard;
  readonly project: ReconcileProject;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** What one {@link reconcileProjection} call did. */
export interface ReconcileReport {
  /** Shard streams examined (one per live `(device, metric)`). */
  readonly scanned: number;
  /** Points pushed into the projection to close the gaps. */
  readonly replayed: number;
  /** Streams whose projection now matches the shard's latest. */
  readonly converged: number;
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Replay the points a stream is missing into the projection.
 *
 * Walks the shard's retained samples for the stream in ascending `seq`, pushing
 * only those strictly newer than what the projection already holds; the shard's
 * authoritative latest is appended when the ring has evicted it (FIFO), so
 * convergence never depends on the ring still being intact. Every push is
 * guarded by an idempotency check on `(device, seq)` *before* it is attempted,
 * so a point the projection already has is skipped rather than re-sent.
 *
 * Returns the number of points actually accepted by the projection.
 */
async function replayStream(
  options: ReconcileOptions,
  target: MetricState,
): Promise<number> {
  const { shard, project } = options;
  const { device, metric } = target;

  // The missing points: retained samples newer than the projection's seq,
  // oldest first so the last one pushed is the stream's latest.
  const retained = (await shard.getRing(device))
    .filter((row) => row.metric === metric)
    .sort((a, b) => a.seq - b.seq);

  const points: { value: number | null; ts: number; seq: number }[] = retained.map(
    (row) => ({ value: row.value, ts: row.ts, seq: row.seq }),
  );

  // If the ring no longer carries the shard's latest (it was evicted), the
  // authoritative latest from `getState` still has to land, appended last.
  const lastSeq = points.length > 0 ? points[points.length - 1].seq : -1;
  if (lastSeq < target.seq) {
    points.push({ value: target.value, ts: target.ts, seq: target.seq });
  }

  let replayed = 0;
  for (const point of points) {
    // Idempotency by `(device, seq)`: a seq the projection already holds is
    // never re-sent, so a replay cannot change state or be double-counted.
    const stored = project.getState(device, metric)[0] ?? null;
    if (stored !== null && stored.seq >= point.seq) continue;

    const result = await project.receivePush({
      device,
      variable: metric,
      value: point.value,
      ts: point.ts,
      seq: point.seq,
    });
    if (result.accepted) replayed += 1;
  }

  return replayed;
}

/**
 * Reconcile a project's projection against a shard's authoritative state.
 *
 * For every stream the shard knows, the projection is compared with the
 * shard's latest `(value, ts, seq)`. A stream whose projection is missing, or
 * behind (`seq_shard > seq_projection`), has its missing points replayed via
 * {@link ReconcileProject.receivePush}; a stream already at the shard's latest
 * is left untouched. The call is pure over the two seams — no clock, no storage
 * of its own — so it is safe to run repeatedly.
 *
 * Streams are visited in a deterministic `(device, metric)` order, so a run's
 * report is stable regardless of the shard's internal map insertion order.
 *
 * Returns a {@link ReconcileReport}: how many streams were scanned, how many
 * points were replayed, and how many streams ended converged.
 */
export async function reconcileProjection(
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  const { shard, project } = options;

  // Snapshot the authoritative latest per stream, in a stable order.
  const targets = [...shard.getState()].sort(
    (a, b) => a.device.localeCompare(b.device) || a.metric.localeCompare(b.metric),
  );

  let replayed = 0;
  let converged = 0;

  for (const target of targets) {
    const stored = project.getState(target.device, target.metric)[0] ?? null;

    // Already at least as new as the shard: nothing to replay. (`seq` is a
    // per-stream monotonic counter, so `seq >= shard seq` means the projection
    // has seen this point or a later one.)
    if (stored !== null && stored.seq >= target.seq) {
      converged += 1;
      continue;
    }

    replayed += await replayStream(options, target);

    // Converged iff the projection now holds exactly the shard's latest.
    const after = project.getState(target.device, target.metric)[0] ?? null;
    if (
      after !== null &&
      after.seq === target.seq &&
      after.ts === target.ts &&
      after.value === target.value
    ) {
      converged += 1;
    }
  }

  return { scanned: targets.length, replayed, converged };
}
