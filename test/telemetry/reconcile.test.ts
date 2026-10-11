import { describe, expect, it } from "vitest";
import {
  InMemoryShardStorage,
  ShardDO,
} from "../../worker/src/platform/durable-objects/shard-do";
import {
  InMemoryProjectStorage,
  ProjectDO,
} from "../../worker/src/platform/durable-objects/project-do";
import { reconcileProjection } from "../../worker/src/domains/telemetry/reconcile";

/**
 * Spec tests for A12 (`reconcileProjection`) — shard→projection reconcile.
 *
 * The reconcile is a pure function over two seams: a shard's authoritative
 * state and a project's projection. Each case pins one property:
 *
 *   1. **Convergence** (ST-M5) — a projection that lost a push (or a run of
 *      them) is brought up to the shard's latest `(value, ts, seq)`.
 *   2. **Idempotency** (INV-T2 / D4.5) — running reconcile twice replays
 *      nothing the second time and leaves the projection byte-identical: no
 *      duplicate, no corruption, keyed by `(device, seq)`.
 *   3. **Already-converged** — nothing to repair means `replayed === 0`.
 *   4. **Independence** — devices and metrics reconcile separately; repairing
 *      one never disturbs another.
 *
 * The shard and project are the real classes over the in-memory storage seams,
 * so a failure here is a failure of the reconcile's logic, not of a fake.
 */

const DEVICE = "dev_alpha";
const METRIC = "temperature";
const FIXED_NOW = 1_700_000_000_123;
const BASE_TS = 1_000_000;

/** An initialised shard and project sharing fresh in-memory storage. */
async function pair(): Promise<{ shard: ShardDO; project: ProjectDO }> {
  const shardStorage = new InMemoryShardStorage();
  const shard = new ShardDO({ storage: shardStorage, now: () => FIXED_NOW });
  await shard.init();

  const projectStorage = new InMemoryProjectStorage();
  const project = new ProjectDO({ storage: projectStorage, now: () => FIXED_NOW });
  await project.init();

  return { shard, project };
}

/** Ingest one sample into a shard, requiring acceptance. */
async function accept(
  shard: ShardDO,
  input: { device?: string; metric?: string; value: number | null; ts: number },
): Promise<void> {
  const result = await shard.ingest({
    device: input.device ?? DEVICE,
    metric: input.metric ?? METRIC,
    value: input.value,
    ts: input.ts,
  });
  if (!result.accepted) throw new Error(`ingest unexpectedly rejected at ts=${input.ts}`);
}

/** Push one point into a project, requiring acceptance. */
async function push(
  project: ProjectDO,
  input: { device?: string; variable?: string; value: number | null; ts: number; seq: number },
): Promise<void> {
  const result = await project.receivePush({
    device: input.device ?? DEVICE,
    variable: input.variable ?? METRIC,
    value: input.value,
    ts: input.ts,
    seq: input.seq,
  });
  if (!result.accepted) throw new Error(`push unexpectedly rejected at seq=${input.seq}`);
}

/** The projection's row for a stream, or `null` when unseen. */
function row(project: ProjectDO, device = DEVICE, variable = METRIC) {
  return project.getState(device, variable)[0] ?? null;
}

/** All projected rows keyed by `device|variable`, for whole-state comparison. */
function snapshot(project: ProjectDO): string {
  return project
    .getState()
    .map((r) => `${r.device}|${r.variable}|${r.value}|${r.ts}|${r.seq}`)
    .sort()
    .join("\n");
}

// ---------------------------------------------------------------------------
// 1. Convergence — a lost push is repaired
// ---------------------------------------------------------------------------
describe("reconcileProjection — convergence (ST-M5)", () => {
  it("brings a projection missing a push up to the shard's latest", async () => {
    const { shard, project } = await pair();
    // The shard accepts three; the projection only ever heard the first push —
    // the last two were lost in transit.
    await accept(shard, { value: 20, ts: BASE_TS });
    await accept(shard, { value: 21, ts: BASE_TS + 1 });
    await accept(shard, { value: 22, ts: BASE_TS + 2 });
    expect(row(project)).toBeNull();

    const report = await reconcileProjection({ shard, project });

    expect(report.scanned).toBe(1);
    expect(report.replayed).toBe(3);
    expect(report.converged).toBe(1);
    // The projection now holds exactly the shard's latest.
    expect(row(project)).toMatchObject({
      device: DEVICE,
      variable: METRIC,
      value: 22,
      ts: BASE_TS + 2,
      seq: 2,
    });
  });

  it("closes a partial gap, replaying only the missing points", async () => {
    const { shard, project } = await pair();
    for (let i = 0; i < 5; i += 1) await accept(shard, { value: i, ts: BASE_TS + i });
    // The projection saw seq 0 and 1, then the push path dropped the rest.
    await push(project, { value: 0, ts: BASE_TS, seq: 0 });
    await push(project, { value: 1, ts: BASE_TS + 1, seq: 1 });

    const report = await reconcileProjection({ shard, project });

    expect(report.replayed).toBe(3);
    expect(report.converged).toBe(1);
    expect(row(project)).toMatchObject({ value: 4, ts: BASE_TS + 4, seq: 4 });
  });

  it("repairs a projection that never received anything", async () => {
    const { shard, project } = await pair();
    await accept(shard, { value: 42, ts: BASE_TS });
    expect(row(project)).toBeNull();

    const report = await reconcileProjection({ shard, project });

    expect(report.replayed).toBe(1);
    expect(report.converged).toBe(1);
    expect(row(project)).toMatchObject({ value: 42, ts: BASE_TS, seq: 0 });
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency — twice is the same as once (INV-T2 / D4.5)
// ---------------------------------------------------------------------------
describe("reconcileProjection — idempotency (INV-T2/D4.5)", () => {
  it("a second run replays nothing and does not corrupt state", async () => {
    const { shard, project } = await pair();
    for (let i = 0; i < 4; i += 1) await accept(shard, { value: i, ts: BASE_TS + i });
    await push(project, { value: 0, ts: BASE_TS, seq: 0 });

    const first = await reconcileProjection({ shard, project });
    expect(first.replayed).toBe(3);
    const afterFirst = snapshot(project);

    const second = await reconcileProjection({ shard, project });

    // Nothing new to replay, and the projection is byte-identical.
    expect(second.scanned).toBe(1);
    expect(second.replayed).toBe(0);
    expect(second.converged).toBe(1);
    expect(snapshot(project)).toBe(afterFirst);
  });

  it("replaying an already-present seq is a no-op keyed by (device, seq)", async () => {
    const { shard, project } = await pair();
    await accept(shard, { value: 7, ts: BASE_TS });
    // The projection already holds the shard's latest point.
    await push(project, { value: 7, ts: BASE_TS, seq: 0 });

    const report = await reconcileProjection({ shard, project });

    // The stream is converged and nothing is re-sent, so a concurrent/duplicate
    // reconcile cannot double-apply the same `(device, seq)`.
    expect(report.replayed).toBe(0);
    expect(row(project)).toMatchObject({ value: 7, ts: BASE_TS, seq: 0 });
  });

  it("stays converged across many runs", async () => {
    const { shard, project } = await pair();
    await accept(shard, { value: 5, ts: BASE_TS });

    const snapshots = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      await reconcileProjection({ shard, project });
      snapshots.add(snapshot(project));
    }
    // Every run left exactly the same single-row state.
    expect(snapshots.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Already-converged — nothing to do
// ---------------------------------------------------------------------------
describe("reconcileProjection — already converged", () => {
  it("replays nothing when the projection matches the shard", async () => {
    const { shard, project } = await pair();
    await accept(shard, { value: 10, ts: BASE_TS });
    await accept(shard, { value: 11, ts: BASE_TS + 1 });
    // Both pushes landed normally.
    await push(project, { value: 10, ts: BASE_TS, seq: 0 });
    await push(project, { value: 11, ts: BASE_TS + 1, seq: 1 });

    const report = await reconcileProjection({ shard, project });

    expect(report.scanned).toBe(1);
    expect(report.replayed).toBe(0);
    expect(report.converged).toBe(1);
  });

  it("scans nothing when the shard is empty", async () => {
    const { shard, project } = await pair();

    const report = await reconcileProjection({ shard, project });

    expect(report).toEqual({ scanned: 0, replayed: 0, converged: 0 });
  });
});

// ---------------------------------------------------------------------------
// 4. Independence — devices and metrics reconcile separately
// ---------------------------------------------------------------------------
describe("reconcileProjection — independent streams", () => {
  it("reconciles several devices and metrics without cross-talk", async () => {
    const { shard, project } = await pair();

    // Three independent streams with differing degrees of drift.
    await accept(shard, { device: "dev_a", metric: "temp", value: 1, ts: BASE_TS });
    await accept(shard, { device: "dev_a", metric: "temp", value: 2, ts: BASE_TS + 1 });
    await accept(shard, { device: "dev_b", metric: "temp", value: 9, ts: BASE_TS });
    await accept(shard, { device: "dev_a", metric: "humidity", value: 55, ts: BASE_TS });

    // dev_a/temp has the first point only; dev_a/humidity is fully caught up;
    // dev_b/temp is entirely missing.
    await push(project, { device: "dev_a", variable: "temp", value: 1, ts: BASE_TS, seq: 0 });
    await push(project, { device: "dev_a", variable: "humidity", value: 55, ts: BASE_TS, seq: 0 });

    const report = await reconcileProjection({ shard, project });

    expect(report.scanned).toBe(3);
    expect(report.replayed).toBe(2); // dev_a/temp seq 1, dev_b/temp seq 0
    expect(report.converged).toBe(3);

    expect(row(project, "dev_a", "temp")).toMatchObject({ value: 2, ts: BASE_TS + 1, seq: 1 });
    expect(row(project, "dev_b", "temp")).toMatchObject({ value: 9, ts: BASE_TS, seq: 0 });
    expect(row(project, "dev_a", "humidity")).toMatchObject({ value: 55, ts: BASE_TS, seq: 0 });
  });

  it("repairs only the stale stream of a mixed pair", async () => {
    const { shard, project } = await pair();
    await accept(shard, { device: "dev_a", metric: "temp", value: 1, ts: BASE_TS });
    await accept(shard, { device: "dev_b", metric: "temp", value: 1, ts: BASE_TS });
    await accept(shard, { device: "dev_b", metric: "temp", value: 2, ts: BASE_TS + 1 });

    // dev_a is caught up; dev_b is one point behind.
    await push(project, { device: "dev_a", variable: "temp", value: 1, ts: BASE_TS, seq: 0 });
    await push(project, { device: "dev_b", variable: "temp", value: 1, ts: BASE_TS, seq: 0 });

    const before = snapshot(project);
    const report = await reconcileProjection({ shard, project });

    expect(report.replayed).toBe(1);
    expect(row(project, "dev_a", "temp")).toMatchObject({ value: 1, seq: 0 });
    expect(row(project, "dev_b", "temp")).toMatchObject({ value: 2, ts: BASE_TS + 1, seq: 1 });
    // dev_a's row is untouched: the repair was confined to dev_b.
    expect(snapshot(project)).not.toBe(before);
    expect(row(project, "dev_a", "temp")!.value).toBe(1);
  });
});
