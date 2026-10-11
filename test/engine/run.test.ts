import { describe, expect, it } from "vitest";
import {
  AutomationEngine,
  InMemoryProjection,
  MAX_EVENT_DEPTH,
  MAX_STEPS,
  MAX_TRACKED_RULES,
  RecordingExecutor,
  type Action,
  type Condition,
  type ProjectionReader,
  type Rule,
} from "../../worker/src/platform/engine/run";

/**
 * Spec tests for the automation DAG engine (A21) — ST-U1 and ST-U3.
 *
 * Every seam is injected and the *real* {@link AutomationEngine} is exercised
 * over the in-memory seams the module ships, so each assertion is about the
 * engine's own behaviour: no mocking of the code under test, no clock but the
 * one the test owns.
 *
 * The six contracts, and the invariant each pins:
 *
 *   1. **Self-trigger stops** (ST-U1 / INV-U1, INV-U4) — a rule whose
 *      `set_variable` wakes itself terminates at the depth cap, and the number
 *      of executions is exactly the cap plus one — not unbounded.
 *   2. **Cooldown suppresses oscillation** (ST-U3 / INV-U3) — 100 oscillations
 *      inside one cooldown window execute the rule once, not 100 times.
 *   3. **Duplicate event id runs once per run** — a repeated `emit_event` id
 *      delivers one event within a run and does not leak across runs.
 *   4. **Oversize graph is rejected** — >100 steps is a rejection, not a run.
 *   5. **Conditions branch** (FR-AUT-03) — `if_variable` and `time_window`
 *      select the true branch and skip the false one from projection values.
 *   6. **Concurrent runs keep their own budget** — two runs interleaved over
 *      one engine each obey {@link MAX_STEPS} exactly as a solo run does, and
 *      the cross-run cooldown memory stays bounded.
 */

const PROJECT = "proj_run";
/** A second, always-known instant for window tests: 12:00:00 UTC. */
const NOON_UTC_MS = Date.UTC(2023, 10, 14, 12, 0, 0);
/** 00:00:00 UTC, just outside a 12:00–13:00 window. */
const MIDNIGHT_UTC_MS = Date.UTC(2023, 10, 14, 0, 0, 0);

interface Harness {
  engine: AutomationEngine;
  projection: InMemoryProjection;
  executor: RecordingExecutor;
  /** Move the engine's clock forward by `ms` (it starts at 0). */
  advance: (ms: number) => void;
  /** The exact instant the engine's clock currently reports. */
  now: () => number;
}

/**
 * A {@link ProjectionReader} that answers `on = 1` and parks its first `budget`
 * reads on a fresh microtask.
 *
 * Parking is the whole point: while one run awaits such a read, the scheduler
 * resumes any *other* run's action loop, so two runs over one engine genuinely
 * interleave — the only way a shared, cross-`await` step counter can be caught
 * resetting under the other run.
 */
class YieldingProjection implements ProjectionReader {
  private parked = 0;

  constructor(private readonly budget = 2) {}

  latestValue(_projectId: string, key: string): Promise<number | null> {
    const value = key === "on" ? 1 : null;
    if (this.parked >= this.budget) return Promise.resolve(value);
    this.parked += 1;
    // `new Promise` (not `Promise.withResolvers`) keeps the module compiling at
    // the repo's `ES2022` lib target.
    return new Promise((resolve) => queueMicrotask(() => resolve(value)));
  }
}

/**
 * A rule whose graph is exactly {@link MAX_STEPS} nodes — one condition plus
 * `MAX_STEPS - 1` actions — and so is accepted. Every node fits the budget, so
 * run alone the rule ends with **zero** `step_limit` refusals: the day the
 * budget is spent exactly is the day nothing is refused.
 */
function budgetProbeRule(id: string): Rule {
  const actions: Action[] = Array.from({ length: MAX_STEPS - 1 }, (_, i) =>
    setVariable(`k${i}`, i),
  );
  return {
    id,
    cooldownMs: 0,
    conditions: [{ type: "if_variable", key: "on", op: "eq", value: 1 }],
    actions,
  };
}

/** The `step_limit` refusals a rule's report carries — zero when it fit its budget. */
function stepLimitCount(report: { rules: readonly { actions: readonly { skipped?: string }[] }[] }): number {
  return report.rules[0].actions.filter((a) => a.skipped === "step_limit").length;
}

/** Build a fully-injected engine whose clock the test drives by hand. */
function harness(): Harness {
  const projection = new InMemoryProjection();
  const executor = new RecordingExecutor();
  let clock = 0;
  const engine = new AutomationEngine({
    projection,
    executor,
    integrations: executor,
    now: () => clock,
  });
  return {
    engine,
    projection,
    executor,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

/** A `set_variable` action, spelled out at the call site. */
function setVariable(key: string, value: number | null): Action {
  return { type: "set_variable", key, value };
}

/** An `emit_event` action with an explicit identity. */
function emitEvent(event: string, eventId?: string, payload?: unknown): Action {
  return { type: "emit_event", event, eventId, payload };
}

/** Every recorded `set_variable` write, in order. */
function setWrites(executor: RecordingExecutor): number {
  return executor.writes.filter((write) => write.kind === "set_variable").length;
}

// ---------------------------------------------------------------------------
// 1. ST-U1 — a self-triggering rule stops at the depth cap
// ---------------------------------------------------------------------------

describe("ST-U1 — self-trigger loop stops at the depth cap (INV-U1, INV-U4)", () => {
  it("terminates a rule that emits the event which triggers it", async () => {
    const h = harness();

    // The rule reacts to `tick`: it sets a variable and re-emits `tick`. Its
    // own emitted event would trigger it again — an infinite cascade in an
    // engine with no depth cap. Each hop carries a *fresh* id so that **depth**,
    // not dedup, is the layer under test; the reported depth of each emitted
    // event lets the test replay the cascade exactly as a dispatcher would.
    const rule = (id: string): Rule => ({
      id: `self-${id}`,
      cooldownMs: 0,
      conditions: [],
      actions: [setVariable("loop", 1), emitEvent("tick", id, {})],
    });

    let depth = 0;
    const executionsAt: number[] = [];
    // No dispatcher here, so the test plays one: it replays each emitted event
    // as the next run, carrying that event's depth forward. The loop stops the
    // moment a run emits nothing — the cap, in miniature.
    for (;;) {
      const report = await h.engine.run([rule(`h${depth}`)], {
        projectId: PROJECT,
        event: "tick",
        depth,
      });
      executionsAt.push(depth);
      // A run that emits nothing ended the cascade; anything else would be an
      // unbounded loop, so the guard is also the assertion's teeth.
      if (report.emittedEvents.length === 0) break;
      expect(report.emittedEvents).toHaveLength(1);
      depth = report.emittedEvents[0].depth;
      if (executionsAt.length > MAX_EVENT_DEPTH + 5) {
        throw new Error("cascade did not stop at the depth cap");
      }
    }

    // The cap is a *stop*, not a slowdown: depth MAX is allowed to emit, the
    // event lands at depth MAX+1, which is refused. So there are exactly
    // MAX_EVENT_DEPTH + 1 runs — the last one emitting nothing.
    expect(executionsAt).toEqual([0, 1, 2, 3, 4, 5]);
    expect(executionsAt).toHaveLength(MAX_EVENT_DEPTH + 1);

    // The final run's emit was refused for depth, and never recorded as emitted.
    const last = await h.engine.run([rule("beyond")], {
      projectId: PROJECT,
      event: "tick",
      depth: MAX_EVENT_DEPTH + 1,
    });
    const lastEmit = last.rules[0].actions.find((a) => a.type === "emit_event");
    expect(lastEmit).toEqual({
      type: "emit_event",
      executed: false,
      skipped: "depth_exceeded",
    });
    expect(last.emittedEvents).toHaveLength(0);
  });

  it("emits its id on every hop, refused only past the depth cap", async () => {
    const h = harness();
    const rule: Rule = {
      id: "self",
      cooldownMs: 0,
      conditions: [],
      actions: [emitEvent("tick", "same-id")],
    };
    // One engine, several hops. The dedup set is per run, so the *same* id on
    // every hop is not a duplicate across runs: depth is the only layer that
    // stops the cascade. Hops below the cap all emit; the cap itself refuses.
    for (let depth = 0; depth < MAX_EVENT_DEPTH; depth += 1) {
      const report = await h.engine.run([rule], {
        projectId: PROJECT,
        event: "tick",
        depth,
      });
      expect(report.emittedEvents.map((e) => e.eventId)).toEqual(["same-id"]);
    }
    const beyond = await h.engine.run([rule], {
      projectId: PROJECT,
      event: "tick",
      depth: MAX_EVENT_DEPTH,
    });
    expect(beyond.emittedEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. ST-U3 — cooldown limits executions under oscillation
// ---------------------------------------------------------------------------

describe("ST-U3 — cooldown prevents a trigger storm (INV-U3)", () => {
  it("executes once for 100 oscillations inside one cooldown window", async () => {
    const h = harness();
    h.projection.set("temp", 31); // the `if_variable` gate holds throughout

    const rule: Rule = {
      id: "oscillating",
      cooldownMs: 10_000, // a 10s window
      conditions: [{ type: "if_variable", key: "temp", op: "gt", value: 30 }],
      actions: [setVariable("cooling", 1)],
    };

    // 100 oscillations, all inside the 10s window: each change re-triggers the
    // rule, but cooldown means at most one execution per window.
    const reports = [];
    for (let i = 0; i < 100; i += 1) {
      h.advance(50); // 50ms per oscillation → 5s total, inside the window
      reports.push(await h.engine.run([rule], { projectId: PROJECT }));
    }

    const executed = reports.filter((r) => r.rules[0].status === "executed");
    const skipped = reports.filter(
      (r) => r.rules[0].status === "skipped_cooldown",
    );

    expect(executed).toHaveLength(1); // not 100
    expect(skipped).toHaveLength(99);
    expect(setWrites(h.executor)).toBe(1);
    expect(h.engine.lastExecution("oscillating")).toBe(50); // the 1st instant
  });

  it("executes once per window once time passes the window", async () => {
    const h = harness();
    const rule: Rule = {
      id: "per-window",
      cooldownMs: 1_000,
      conditions: [],
      actions: [setVariable("x", 1)],
    };

    // Across a span longer than several windows the rule runs once per window.
    // 3 runs, each triggered after the window has elapsed → 3 executions.
    for (let i = 0; i < 3; i += 1) {
      const report = await h.engine.run([rule], { projectId: PROJECT });
      expect(report.rules[0].status).toBe("executed");
      h.advance(1_500); // outlasts the 1s cooldown
    }
    expect(setWrites(h.executor)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Duplicate event id → executed once
// ---------------------------------------------------------------------------

describe("duplicate event id is delivered once per run", () => {
  it("dedupes a repeated id inside one run", async () => {
    const h = harness();
    // One run, the same id emitted twice: the second emit is refused. The
    // dedup set is the run's own, and within a run one id means one event.
    const rule: Rule = {
      id: "dedup",
      cooldownMs: 0,
      conditions: [],
      actions: [emitEvent("webhook", "delivery-1", { n: 1 }), emitEvent("webhook", "delivery-1", { n: 2 })],
    };

    const report = await h.engine.run([rule], { projectId: PROJECT });

    expect(report.emittedEvents).toHaveLength(1);
    expect(report.emittedEvents[0]).toMatchObject({ eventId: "delivery-1", depth: 1 });
    expect(
      report.rules[0].actions.filter((a) => a.type === "emit_event")[1],
    ).toEqual({
      type: "emit_event",
      executed: false,
      skipped: "duplicate_event",
      detail: "delivery-1",
    });
  });

  it("does not leak an id from one run into the next", async () => {
    const h = harness();
    const rule: Rule = {
      id: "dedup",
      cooldownMs: 0,
      conditions: [],
      actions: [emitEvent("webhook", "delivery-1", { n: 1 })],
    };

    // The dedup set is per run, so a *fresh* run emits the same id again. A
    // redelivery is throttled across runs by cooldown, not by event id — the
    // id is an intra-run identity, so nothing crosses the run boundary.
    const first = await h.engine.run([rule], { projectId: PROJECT });
    const second = await h.engine.run([rule], { projectId: PROJECT });

    expect(first.emittedEvents.map((e) => e.eventId)).toEqual(["delivery-1"]);
    expect(second.emittedEvents.map((e) => e.eventId)).toEqual(["delivery-1"]);
  });

  it("refuses an emit with no id (it could not be deduped)", async () => {
    const h = harness();
    const rule: Rule = {
      id: "anonymous",
      cooldownMs: 0,
      conditions: [],
      actions: [emitEvent("webhook")],
    };
    const report = await h.engine.run([rule], { projectId: PROJECT });
    expect(report.emittedEvents).toHaveLength(0);
    expect(report.rules[0].actions[0]).toEqual({
      type: "emit_event",
      executed: false,
      skipped: "missing_event_id",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Graph > 100 steps → rejected
// ---------------------------------------------------------------------------

describe("a graph past the step limit is rejected", () => {
  it("rejects a rule with 101 nodes and runs it not at all", async () => {
    const h = harness();
    const conditions: Condition[] = Array.from({ length: MAX_STEPS }, () => ({
      type: "time_window",
      startMinute: 0,
      endMinute: 1440,
    }));
    const rule: Rule = {
      id: "too-big",
      cooldownMs: 0,
      conditions,
      actions: [setVariable("x", 1)], // 100 + 1 = 101 > MAX_STEPS
    };

    const report = await h.engine.run([rule], { projectId: PROJECT });

    expect(report.rules[0].error).toBe(
      `graph has ${MAX_STEPS + 1} steps, limit is ${MAX_STEPS}`,
    );
    expect(report.rules[0].status).toBe("skipped_no_match");
    expect(report.rules[0].actions).toHaveLength(0);
    expect(report.rules[0].conditions).toHaveLength(0);
    // Nothing ran: no write, and the rule never entered its cooldown.
    expect(setWrites(h.executor)).toBe(0);
    expect(h.engine.lastExecution("too-big")).toBeUndefined();
  });

  it("accepts a rule of exactly 100 steps", async () => {
    const h = harness();
    const actions: Action[] = Array.from({ length: MAX_STEPS }, (_, i) =>
      setVariable(`k${i}`, i),
    );
    const rule: Rule = { id: "at-limit", cooldownMs: 0, conditions: [], actions };

    const report = await h.engine.run([rule], { projectId: PROJECT });

    expect(report.rules[0].error).toBeUndefined();
    expect(report.rules[0].status).toBe("executed");
    expect(report.rules[0].actions).toHaveLength(MAX_STEPS);
    expect(setWrites(h.executor)).toBe(MAX_STEPS);
  });
});

// ---------------------------------------------------------------------------
// 5. Conditions branch true/false from projection values
// ---------------------------------------------------------------------------

describe("conditions branch from projection values (FR-AUT-03)", () => {
  it("runs actions when if_variable holds, skips them when it does not", async () => {
    const h = harness();
    const rule: Rule = {
      id: "threshold",
      cooldownMs: 0,
      conditions: [{ type: "if_variable", key: "temp", op: "gt", value: 30 }],
      actions: [setVariable("alarm", 1)],
    };

    // The projection is unset: `temp` is unknown → fail closed → no action.
    const unknown = await h.engine.run([rule], { projectId: PROJECT });
    expect(unknown.rules[0].conditions).toEqual([false]);
    expect(unknown.rules[0].actions).toHaveLength(0);

    // temp = 25 → false branch.
    h.projection.set("temp", 25);
    const low = await h.engine.run([rule], { projectId: PROJECT });
    expect(low.rules[0].conditions).toEqual([false]);

    // temp = 30 is *not* > 30 → still false.
    h.projection.set("temp", 30);
    const equal = await h.engine.run([rule], { projectId: PROJECT });
    expect(equal.rules[0].conditions).toEqual([false]);

    // temp = 31 → true branch, the action runs.
    h.projection.set("temp", 31);
    const high = await h.engine.run([rule], { projectId: PROJECT });
    expect(high.rules[0].conditions).toEqual([true]);
    expect(high.rules[0].status).toBe("executed");
    // Only the `31` run executed: the unknown/25/30 runs skipped (no action)
    // and each *did* consume the rule's cooldown slot (cooldownMs = 0 records
    // the execution) — so exactly one write was made.
    expect(setWrites(h.executor)).toBe(1); // only `high` ran its action
  });

  it("requires every condition (logical AND)", async () => {
    const h = harness();
    h.projection.set("temp", 31); // first condition holds
    const rule: Rule = {
      id: "and",
      cooldownMs: 0,
      conditions: [
        { type: "if_variable", key: "temp", op: "gt", value: 30 },
        { type: "if_variable", key: "humidity", op: "lt", value: 40 }, // unknown → false
      ],
      actions: [setVariable("alarm", 1)],
    };

    const report = await h.engine.run([rule], { projectId: PROJECT });
    expect(report.rules[0].conditions).toEqual([true, false]);
    expect(report.rules[0].status).toBe("skipped_no_match");
    expect(setWrites(h.executor)).toBe(0);
  });

  it("evaluates time_window against the injected clock in UTC", async () => {
    const h = harness();
    const rule: Rule = {
      id: "window",
      cooldownMs: 0,
      conditions: [
        { type: "time_window", startMinute: 12 * 60, endMinute: 13 * 60 },
      ],
      actions: [setVariable("daytime", 1)],
    };

    // At 00:00 UTC the window is closed (left-closed/right-open).
    h.advance(MIDNIGHT_UTC_MS);
    const night = await h.engine.run([rule], { projectId: PROJECT });
    expect(night.rules[0].conditions).toEqual([false]);

    // At 12:00 UTC exactly, the window's inclusive start → open.
    h.advance(NOON_UTC_MS - MIDNIGHT_UTC_MS);
    const noon = await h.engine.run([rule], { projectId: PROJECT });
    expect(noon.rules[0].conditions).toEqual([true]);
    expect(noon.rules[0].status).toBe("executed");
  });

  it("wraps a window across midnight", async () => {
    const h = harness();
    const rule: Rule = {
      id: "overnight",
      cooldownMs: 0,
      conditions: [{ type: "time_window", startMinute: 22 * 60, endMinute: 6 * 60 }],
      actions: [setVariable("night", 1)],
    };

    h.advance(MIDNIGHT_UTC_MS + 60 * 60_000); // 01:00 UTC — inside the wrap
    const one = await h.engine.run([rule], { projectId: PROJECT });
    expect(one.rules[0].conditions).toEqual([true]);

    h.advance(Date.UTC(2023, 10, 14, 12, 0, 0) - (MIDNIGHT_UTC_MS + 60 * 60_000));
    const noon = await h.engine.run([rule], { projectId: PROJECT });
    expect(noon.rules[0].conditions).toEqual([false]);
  });
});

// ---------------------------------------------------------------------------
// The remaining action kinds, and the shapes a caller reads back
// ---------------------------------------------------------------------------

describe("actions and report shape", () => {
  it("records a delay as a non-blocking intent for the scheduler", async () => {
    const h = harness();
    const rule: Rule = {
      id: "delayed",
      cooldownMs: 0,
      conditions: [],
      actions: [{ type: "delay", durationMs: 60_000 }],
    };

    const report = await h.engine.run([rule], { projectId: PROJECT });

    expect(report.rules[0].actions).toEqual([{ type: "delay", executed: true }]);
    const delay = h.executor.writes.find((w) => w.kind === "delay");
    expect(delay?.detail).toMatchObject({ ruleId: "delayed", durationMs: 60_000 });
  });

  it("calls an integration and surfaces a seam failure without throwing", async () => {
    const projection = new InMemoryProjection();
    const executor = new RecordingExecutor(new Set(["call_integration"]));
    const engine = new AutomationEngine({
      projection,
      executor,
      integrations: executor, // configured to refuse every call
      now: () => 0,
    });
    const rule: Rule = {
      id: "integrate",
      cooldownMs: 0,
      conditions: [],
      actions: [{ type: "call_integration", integrationId: "slack", payload: { text: "hi" } }],
    };

    const report = await engine.run([rule], { projectId: PROJECT });

    // The pipeline carried on and recorded the failure rather than unwinding.
    expect(report.rules[0].actions[0]).toEqual({
      type: "call_integration",
      executed: false,
      skipped: "executor_error",
      detail: "call_integration refused",
    });
  });

  it("reports each rule with its own status in one run", async () => {
    const h = harness();
    const rules: Rule[] = [
      {
        id: "a",
        cooldownMs: 0,
        conditions: [{ type: "if_variable", key: "k", op: "eq", value: 1 }],
        actions: [setVariable("x", 1)],
      },
      { id: "b", cooldownMs: 0, conditions: [], actions: [setVariable("y", 1)] },
    ];
    h.projection.set("k", 1);

    const report = await h.engine.run(rules, { projectId: PROJECT });
    expect(report.rules.map((r) => r.ruleId)).toEqual(["a", "b"]);
    expect(report.rules.every((r) => r.status === "executed")).toBe(true);
    expect(report.maxSteps).toBe(MAX_STEPS);
    expect(report.depth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrency — a run's budget and dedup set are its own
// ---------------------------------------------------------------------------

describe("concurrent runs keep their own step budget (INV: one run, one budget)", () => {
  it("gives each of two interleaved runs the budget a solo run gets", async () => {
    // The baseline: the rule alone spends its budget exactly and is refused
    // nothing. This is the state each concurrent run must reproduce.
    const soloExec = new RecordingExecutor();
    const solo = await new AutomationEngine({
      projection: new YieldingProjection(),
      executor: soloExec,
      integrations: soloExec,
    }).run([budgetProbeRule("solo")], { projectId: PROJECT });
    expect(solo.rules[0].status).toBe("executed");
    expect(solo.rules[0].actions).toHaveLength(MAX_STEPS - 1);
    expect(stepLimitCount(solo)).toBe(0); // a solo run refuses nothing

    // Two runs over ONE engine: the first parks on its projection read while
    // the second starts, so their action loops genuinely overlap. This is the
    // shape a background dispatcher creates when it does not await a run
    // (see test/telemetry/events.test.ts).
    const exec = new RecordingExecutor();
    const engine = new AutomationEngine({
      projection: new YieldingProjection(),
      executor: exec,
      integrations: exec,
    });
    const [first, second] = await Promise.all([
      engine.run([budgetProbeRule("first")], { projectId: PROJECT }),
      engine.run([budgetProbeRule("second")], { projectId: PROJECT }),
    ]);

    // Each run must reach the solo state: every action its graph declares, and
    // not one `step_limit` refusal. A counter shared between the runs (reset at
    // the top of each `run`) would make one run spend budget the other had
    // already consumed, so refusals would appear and executed actions would
    // fall short — both directions are pinned here.
    for (const report of [first, second]) {
      expect(report.rules[0].status).toBe("executed");
      expect(report.rules[0].actions).toHaveLength(MAX_STEPS - 1);
      expect(stepLimitCount(report)).toBe(0);
    }
    // 2 rules × (MAX_STEPS - 1) writes, none swallowed by the other run's budget.
    expect(setWrites(exec)).toBe(2 * (MAX_STEPS - 1));
  });

  it("keeps an interleaved run's dedup set independent of the other run's", async () => {
    const rule: Rule = {
      id: "shared-id",
      cooldownMs: 0,
      conditions: [],
      actions: [emitEvent("tick", "same-id")],
    };
    const exec = new RecordingExecutor();
    const engine = new AutomationEngine({
      projection: new YieldingProjection(),
      executor: exec,
      integrations: exec,
    });

    // Both runs emit the *same* event id; because the dedup set is per run,
    // each delivers one event. A shared set would let whichever ran second see
    // a duplicate and emit nothing.
    const [a, b] = await Promise.all([
      engine.run([rule], { projectId: PROJECT }),
      engine.run([rule], { projectId: PROJECT }),
    ]);
    expect(a.emittedEvents.map((e) => e.eventId)).toEqual(["same-id"]);
    expect(b.emittedEvents.map((e) => e.eventId)).toEqual(["same-id"]);
  });
});

describe("cross-run state is bounded", () => {
  it("caps the cooldown memory at MAX_TRACKED_RULES, however many rules it sees", async () => {
    const h = harness();
    // Never two executions of one rule inside its (huge) window, so this is
    // purely about how many *distinct* rules the instance remembers.
    const overflow = MAX_TRACKED_RULES + 250;
    for (let i = 0; i < overflow; i += 1) {
      await h.engine.run(
        [{ id: `rule-${i}`, cooldownMs: 1_000_000, conditions: [], actions: [] }],
        { projectId: PROJECT },
      );
    }

    // Bounded — not one entry per rule ever seen — and still functional: the
    // most recent rule's cooldown is retained, so it is throttled on a re-run.
    expect(h.engine.trackedRuleCount).toBe(MAX_TRACKED_RULES);
    const recent = await h.engine.run(
      [{ id: `rule-${overflow - 1}`, cooldownMs: 1_000_000, conditions: [], actions: [] }],
      { projectId: PROJECT },
    );
    expect(recent.rules[0].status).toBe("skipped_cooldown");
  });

  it("evicts the stalest cooldown first, never the freshest", async () => {
    const h = harness();
    for (let i = 0; i < MAX_TRACKED_RULES; i += 1) {
      await h.engine.run(
        [{ id: `r${i}`, cooldownMs: 1_000_000, conditions: [], actions: [] }],
        { projectId: PROJECT },
      );
      h.advance(1); // each later rule executed at a strictly later instant
    }

    // A new, distinct rule overflows the map; the earliest-executed entry — the
    // one whose cooldown is closest to lapsing — is the one forgotten.
    await h.engine.run(
      [{ id: "newcomer", cooldownMs: 1_000_000, conditions: [], actions: [] }],
      { projectId: PROJECT },
    );

    expect(h.engine.trackedRuleCount).toBe(MAX_TRACKED_RULES);
    expect(h.engine.lastExecution("r0")).toBeUndefined(); // stalest, evicted
    expect(h.engine.lastExecution("newcomer")).toBeDefined();
    expect(h.engine.lastExecution(`r${MAX_TRACKED_RULES - 1}`)).toBeDefined(); // freshest, kept
  });
});
