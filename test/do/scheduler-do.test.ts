import { describe, expect, it } from "vitest";
import {
  DELAY_STATUS,
  SCHEDULER_DDL,
  InMemoryAlarmSink,
  InMemorySchedulerStorage,
  NoopExecutor,
  SchedulerDO,
  type ActionExecutor,
  type AlarmSink,
  type DelayRow,
  type SchedulerStorage,
} from "../../worker/src/platform/durable-objects/scheduler-do";
import type { ActionWriteResult } from "../../worker/src/platform/engine/run";

/**
 * Spec tests for the A22 scheduler (`SchedulerDO`) — the single alarm over
 * injected seams, and the exactly-once delay queue behind it (D3.7 / FR-AUT-05
 * / INV-U2 / ST-U2).
 *
 * Every dependency is injected, so each contract is asserted against state the
 * test owns outright and no `Date.now()` or platform timer leaks in:
 *
 *   - a {@link SchedulerStorage} seam — here {@link InMemorySchedulerStorage},
 *     whose `claimDelays` models the compare-and-set (`WHERE status='pending'`)
 *     the invariant rests on;
 *   - an {@link AlarmSink} — here {@link InMemoryAlarmSink}, whose `armed`
 *     history makes "the earliest candidate won" observable;
 *   - a {@link Clock} — pinned by the test, so "due" and "early" are exact;
 *   - a recording {@link ActionExecutor} — so "executed" is a witness, and a
 *     second execution would be a second witness.
 *
 * The four contracts:
 *
 *   1. **Restart** (ST-U2) — a fresh incarnation of the DO in a **new** object
 *      over the **same** storage, at or just before the alarm, fires the job
 *      exactly once: not zero (the restart did not lose it) and not two (the
 *      claim guard held).
 *   2. **Earliest candidate** — the single alarm is `min(schedule, sunset,
 *      delay, ext-poll)`, and the plan names which candidate produced it.
 *   3. **At-least-once ≠ double execute** — a claimed/`done` job is not
 *      re-executed on a second alarm tick.
 *   4. **Non-blocking** — a delay far longer than the request that recorded it
 *      still fires, on a later tick, exactly once.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

/** One recorded execution — the witness a test counts. */
interface Execution {
  readonly id: string;
  readonly ruleId: string;
  readonly at: number;
}

/**
 * An {@link ActionExecutor} that records every call and can be told to fail
 * specific job ids, so "executed once" is a real witness and the failure path is
 * exercisable.
 */
class RecordingExecutor implements ActionExecutor {
  readonly calls: Execution[] = [];

  constructor(
    private readonly clock: () => number,
    private readonly failing: ReadonlySet<string> = new Set(),
  ) {}

  execute(row: DelayRow): Promise<ActionWriteResult> {
    this.calls.push({ id: row.id, ruleId: row.ruleId, at: this.clock() });
    return Promise.resolve(
      this.failing.has(row.id) ? { ok: false, error: `${row.id} refused` } : { ok: true },
    );
  }
}

/**
 * A world the test owns: the injected clock, the storages and alarm slots a DO
 * instance is built over. `restart()` returns a **new** {@link SchedulerDO} over
 * the **same** storage and alarm — the eviction/rehydration ST-U2 models, where
 * every scrap of in-memory state is gone and only durable state remains.
 */
function world(options: { failing?: ReadonlySet<string> } = {}) {
  let now = T0;
  const clock = () => now;
  const baseStorage = new InMemorySchedulerStorage();
  const baseAlarm = new InMemoryAlarmSink();
  const executor = new RecordingExecutor(clock, options.failing ?? new Set());

  const build = (storage: SchedulerStorage, alarm: AlarmSink) =>
    new SchedulerDO({ storage, alarm, executor, now: clock });

  let instance = build(baseStorage, baseAlarm);

  return {
    /** The live DO instance. */
    get current() {
      return instance;
    },
    baseStorage,
    baseAlarm,
    executor,
    /** Move the injected clock (the only way time passes here). */
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    /**
     * Evict and rehydrate: a brand-new DO over the same storage and alarm, its
     * constructor having re-read storage and re-armed the same alarm.
     */
    restart(): SchedulerDO {
      instance = build(baseStorage, baseAlarm);
      return instance;
    },
    /** A second, independent DO over the same storage/alarm (a racing isolate). */
    sibling(): SchedulerDO {
      return build(baseStorage, baseAlarm);
    },
  };
}

/** Count executions of one job id — the assertion "exactly once" is stated on. */
function count(calls: readonly Execution[], id: string): number {
  return calls.filter((call) => call.id === id).length;
}

// ---------------------------------------------------------------------------
// ST-U2 — restart at / just before the alarm → exactly one execution
// ---------------------------------------------------------------------------

describe("ST-U2: restart around the alarm fires exactly once (INV-U2)", () => {
  it("fires exactly once when restarted just before the alarm", async () => {
    const w = world();
    await w.current.init();

    // A delay due in 60s; the single alarm now points at it.
    await w.current.enqueueDelay({
      id: "job_1",
      projectId: "proj_a",
      ruleId: "rule_1",
      durationMs: 60_000,
    });
    expect(await w.current.getAlarm()).toBe(T0 + 60_000);

    // Restart *just before* the instant: 1ms early.
    w.advance(59_999);
    const revived = w.restart();
    await revived.init();

    // The rehydrated instance re-read from storage and re-armed the same alarm.
    expect(await revived.getAlarm()).toBe(T0 + 60_000);

    // The instant arrives; the re-armed alarm fires once.
    w.advance(1);
    const report = await revived.alarm();

    expect(report.executed.map((outcome) => outcome.id)).toEqual(["job_1"]);
    expect(count(w.executor.calls, "job_1")).toBe(1);
    expect(await w.baseStorage.getDelay("job_1")).toMatchObject({ status: "done" });
  });

  it("fires exactly once when restarted after the alarm fired but before it executed", async () => {
    const w = world();
    await w.current.init();
    await w.current.enqueueDelay({
      id: "job_1",
      projectId: "proj_a",
      ruleId: "rule_1",
      durationMs: 1_000,
    });

    w.advance(1_000);

    // Model the platform's at-least-once wake exactly: two independent DO
    // instances over the same storage both observe the same alarm instant.
    const first = w.sibling();
    const second = w.sibling();

    const a = await first.alarm();
    const b = await second.alarm();

    expect(count(w.executor.calls, "job_1")).toBe(1); // not zero, not two
    const fired = [...a.executed, ...b.executed].filter((o) => o.id === "job_1");
    expect(fired).toHaveLength(1); // exactly one of the two wakes ran it
  });

  it("does not fire before the due instant, and still fires exactly once after it", async () => {
    const w = world();
    await w.current.init();
    await w.current.enqueueDelay({
      id: "job_1",
      projectId: "proj_a",
      ruleId: "rule_1",
      durationMs: 60_000,
    });

    // An alarm delivered EARLY (the runtime may wake ahead of the instant)
    // executes nothing and re-arms the same instant.
    w.advance(59_000);
    const early = await w.current.alarm();
    expect(early.executed).toEqual([]);
    expect(count(w.executor.calls, "job_1")).toBe(0);
    expect(early.armedFor).toBe(T0 + 60_000);

    // The instant finally arrives: one execution, and only one.
    w.advance(1_000);
    await w.current.alarm();
    const late = await w.current.alarm(); // a duplicate tick
    expect(count(w.executor.calls, "job_1")).toBe(1);
    expect(late.executed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The single alarm is min(schedule, sunset, delay, ext-poll)
// ---------------------------------------------------------------------------

describe("the single alarm picks the earliest candidate", () => {
  it("arms the earliest of schedule/sunset/delay/ext-poll and names its kind", async () => {
    const w = world();
    await w.current.init();

    // schedule earliest; sunset + ext-poll later; a delay last.
    await w.current.scheduleAt(T0 + 1_000);
    await w.current.sunsetAt(T0 + 5_000);
    await w.current.extPollAt(T0 + 9_000);
    await w.current.enqueueDelay({
      id: "job_1",
      projectId: "proj_a",
      ruleId: "rule_1",
      dueAt: T0 + 20_000,
    });

    const plan = await w.current.nextWakePlan();
    expect(plan.at).toBe(T0 + 1_000);
    expect(plan.candidates).toEqual([{ kind: "schedule", at: T0 + 1_000 }]);
    expect(await w.current.getAlarm()).toBe(T0 + 1_000);
  });

  it("re-derives the alarm as each kind is registered and cleared", async () => {
    const w = world();
    await w.current.init();

    // Nothing scheduled → no alarm.
    expect(await w.current.getAlarm()).toBeNull();

    await w.current.sunsetAt(T0 + 8_000);
    expect(await w.current.getAlarm()).toBe(T0 + 8_000);

    // A sooner delay takes over the single slot.
    await w.current.enqueueDelay({
      id: "job_1",
      projectId: "proj_a",
      ruleId: "rule_1",
      dueAt: T0 + 3_000,
    });
    expect(await w.current.getAlarm()).toBe(T0 + 3_000);

    // A sooner schedule takes over in turn.
    await w.current.scheduleAt(T0 + 1_000);
    expect(await w.current.getAlarm()).toBe(T0 + 1_000);

    // Clearing the soonest candidate falls back to the next earliest.
    await w.current.scheduleAt(null);
    expect(await w.current.getAlarm()).toBe(T0 + 3_000);

    // The history shows the argmin was recomputed on every write, not merely
    // overwritten by the last registration.
    expect(w.baseAlarm.armed).toEqual([
      T0 + 8_000,
      T0 + 3_000,
      T0 + 1_000,
      T0 + 3_000,
    ]);
  });

  it("reports every candidate tied for the earliest instant", async () => {
    const w = world();
    await w.current.init();

    await w.current.scheduleAt(T0 + 2_000);
    await w.current.enqueueDelay({
      id: "job_1",
      projectId: "proj_a",
      ruleId: "rule_1",
      dueAt: T0 + 2_000,
    });

    const plan = await w.current.nextWakePlan();
    expect(plan.at).toBe(T0 + 2_000);
    expect(plan.candidates.map((c) => c.kind)).toEqual(["schedule", "delay"]);
  });

  it("ignores a due action once it is no longer pending", async () => {
    const w = world();
    await w.current.init();
    await w.current.enqueueDelay({
      id: "job_1",
      projectId: "proj_a",
      ruleId: "rule_1",
      dueAt: T0 + 4_000,
    });

    // A claimed/done row is not a reason to wake — only pending work is. The
    // re-derivation is what makes the alarm follow the register, so it must be
    // asked again after the status changed.
    await w.baseStorage.setDelayStatus("job_1", "done");
    await w.current.refreshAlarm();
    expect(await w.current.getAlarm()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// At-least-once alarm must not double-execute (the claim guard)
// ---------------------------------------------------------------------------

describe("a claimed job is not re-executed on a second alarm tick", () => {
  it("executes once across a wake and a duplicate wake", async () => {
    const w = world();
    await w.current.init();
    await w.current.enqueueDelay({
      id: "job_1",
      projectId: "proj_a",
      ruleId: "rule_1",
      durationMs: 1_000,
    });

    w.advance(1_000);
    const first = await w.current.alarm();
    const second = await w.current.alarm();

    expect(first.executed.map((o) => o.id)).toEqual(["job_1"]);
    expect(second.executed).toEqual([]); // the claim guard held
    expect(count(w.executor.calls, "job_1")).toBe(1);
  });

  it("claims atomically, so two racing wakes cannot both execute one job", async () => {
    const w = world();
    await w.current.init();
    await w.current.enqueueDelay({
      id: "job_1",
      projectId: "proj_a",
      ruleId: "rule_1",
      dueAt: T0,
    });

    const a = w.sibling();
    const b = w.sibling();
    const [ra, rb] = await Promise.all([a.alarm(), b.alarm()]);

    expect(count(w.executor.calls, "job_1")).toBe(1);
    expect([...ra.executed, ...rb.executed]).toHaveLength(1);
    expect(await w.baseStorage.getDelay("job_1")).toMatchObject({ status: "done" });
  });

  it("drains several due jobs exactly once each, in due order", async () => {
    const w = world();
    await w.current.init();
    for (const [id, dueAt] of [
      ["job_c", T0 + 300],
      ["job_a", T0 + 100],
      ["job_b", T0 + 100],
    ] as const) {
      await w.current.enqueueDelay({
        id,
        projectId: "proj_a",
        ruleId: "rule_1",
        dueAt,
      });
    }

    w.advance(1_000);
    const report = await w.current.alarm();

    // Earliest due first; equal dues tie-broken by id, deterministically.
    expect(report.executed.map((o) => o.id)).toEqual(["job_a", "job_b", "job_c"]);
    expect(w.executor.calls.map((c) => c.id)).toEqual(["job_a", "job_b", "job_c"]);

    // A duplicate tick afterwards executes none of them again.
    await w.current.alarm();
    expect(count(w.executor.calls, "job_a")).toBe(1);
    expect(count(w.executor.calls, "job_b")).toBe(1);
    expect(count(w.executor.calls, "job_c")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Non-blocking delay (FR-AUT-05)
// ---------------------------------------------------------------------------

describe("a delay longer than the request still fires (non-blocking)", () => {
  it("records a far-future delay without waiting for it, and fires it exactly once", async () => {
    const w = world();
    await w.current.init();

    // The recording call returns immediately — a delay of 24h does not block
    // the request that asked for it (FR-AUT-05 / INV-U2).
    const recorded = await w.current.enqueueDelay({
      id: "job_long",
      projectId: "proj_a",
      ruleId: "rule_night",
      durationMs: 24 * 60 * 60 * 1000,
      payload: { rise: 2 },
    });

    expect(recorded.ok).toBe(true);
    expect(w.executor.calls).toEqual([]); // nothing ran synchronously
    expect(await w.current.getAlarm()).toBe(T0 + 86_400_000);

    // Most of the day passes; still nothing fires, because nothing is due.
    w.advance(86_399_000);
    expect((await w.current.alarm()).executed).toEqual([]);
    expect(w.executor.calls).toEqual([]);

    // The instant arrives: it fires — once — and the armed alarm clears.
    w.advance(1_000);
    const report = await w.current.alarm();
    expect(report.executed.map((o) => o.id)).toEqual(["job_long"]);
    expect(count(w.executor.calls, "job_long")).toBe(1);
    expect(await w.current.getAlarm()).toBeNull();
  });

  it("keeps firing a sequence of delays, each exactly once", async () => {
    const w = world();
    await w.current.init();

    await w.current.enqueueDelay({
      id: "job_1",
      projectId: "proj_a",
      ruleId: "rule_1",
      durationMs: 1_000,
    });
    await w.current.enqueueDelay({
      id: "job_2",
      projectId: "proj_a",
      ruleId: "rule_2",
      durationMs: 2_000,
    });

    w.advance(1_000);
    expect((await w.current.alarm()).executed.map((o) => o.id)).toEqual(["job_1"]);
    // job_2 is not due yet, so it is still pending and the alarm re-arms for it.
    expect(await w.current.getAlarm()).toBe(T0 + 2_000);

    w.advance(1_000);
    expect((await w.current.alarm()).executed.map((o) => o.id)).toEqual(["job_2"]);

    expect(w.executor.calls.map((c) => c.id)).toEqual(["job_1", "job_2"]);
  });
});

// ---------------------------------------------------------------------------
// Failure and input handling
// ---------------------------------------------------------------------------

describe("failure and input handling", () => {
  it("marks a failed execution terminal so it is not re-run", async () => {
    const w = world({ failing: new Set(["job_bad"]) });
    await w.current.init();
    await w.current.enqueueDelay({
      id: "job_bad",
      projectId: "proj_a",
      ruleId: "rule_1",
      dueAt: T0,
    });

    const report = await w.current.alarm();
    expect(report.executed).toEqual([
      { id: "job_bad", ruleId: "rule_1", executed: false, reason: "executor_failed", error: "job_bad refused" },
    ]);
    expect(await w.baseStorage.getDelay("job_bad")).toMatchObject({ status: "failed" });

    // A later tick does not execute it again.
    await w.current.alarm();
    expect(count(w.executor.calls, "job_bad")).toBe(1);
  });

  it("reports a malformed delay as a value rather than scheduling it", async () => {
    const w = world();
    await w.current.init();

    expect(await w.current.enqueueDelay({ id: "  ", projectId: "p", ruleId: "r", durationMs: 1 })).toEqual({
      ok: false,
      reason: "invalid_input",
      field: "id",
    });
    expect(
      await w.current.enqueueDelay({ id: "j", projectId: "p", ruleId: "r", durationMs: -1 }),
    ).toEqual({ ok: false, reason: "invalid_input", field: "durationMs" });
    expect(
      await w.current.enqueueDelay({ id: "j", projectId: "p", ruleId: "r", durationMs: Number.NaN }),
    ).toEqual({ ok: false, reason: "invalid_input", field: "durationMs" });
    expect(
      await w.current.enqueueDelay({ id: "j", projectId: "p", ruleId: "r", dueAt: Number.POSITIVE_INFINITY }),
    ).toEqual({ ok: false, reason: "invalid_input", field: "dueAt" });

    // Nothing was stored and no alarm was armed.
    expect(await w.baseStorage.listDelays()).toEqual([]);
    expect(await w.current.getAlarm()).toBeNull();
  });

  it("defaults the executor to a successful no-op", async () => {
    const storage = new InMemorySchedulerStorage();
    const alarm = new InMemoryAlarmSink();
    const scheduler = new SchedulerDO({ storage, alarm, now: () => T0 });
    await scheduler.init();
    await scheduler.enqueueDelay({ id: "job_1", projectId: "p", ruleId: "r", dueAt: T0 });

    expect(scheduler.handler()).toBeTypeOf("function");
    const report = await scheduler.alarm();
    expect(report.executed).toEqual([{ id: "job_1", ruleId: "r", executed: true }]);
    expect(await storage.getDelay("job_1")).toMatchObject({ status: "done" });
    expect(new NoopExecutor()).toBeInstanceOf(NoopExecutor);
  });
});

// ---------------------------------------------------------------------------
// Shape: statuses, DDL
// ---------------------------------------------------------------------------

describe("vocabulary and schema", () => {
  it("names the four lifecycle statuses, with pending the only claimable one", () => {
    expect([...DELAY_STATUS]).toEqual(["pending", "claimed", "done", "failed"]);
  });

  it("declares the delay table with a status column and a due index", () => {
    const statements = SCHEDULER_DDL.statements();
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every((statement) => statement.endsWith(";"))).toBe(true);

    const sql = SCHEDULER_DDL.sql;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS automation_delays");
    // The status column is the claim's ground truth, so its default is
    // load-bearing and asserted rather than left to the reader.
    expect(sql).toMatch(/status\s+TEXT\s+NOT NULL DEFAULT 'pending'/);
    expect(sql).toContain("idx_automation_delays_pending_due");
    expect([...SCHEDULER_DDL.tables]).toEqual([
      "automation_delays",
      "scheduler_alarm",
      "scheduler_register",
    ]);
  });
});
