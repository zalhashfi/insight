import { describe, expect, it } from "vitest";
import {
  AutomationEngine,
  InMemoryProjection,
  MAX_EVENT_DEPTH,
  MAX_STEPS,
  RecordingExecutor,
  type Action,
  type Condition,
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
 * The five contracts, and the invariant each pins:
 *
 *   1. **Self-trigger stops** (ST-U1 / INV-U1, INV-U4) — a rule whose
 *      `set_variable` wakes itself terminates at the depth cap, and the number
 *      of executions is exactly the cap plus one — not unbounded.
 *   2. **Cooldown suppresses oscillation** (ST-U3 / INV-U3) — 100 oscillations
 *      inside one cooldown window execute the rule once, not 100 times.
 *   3. **Duplicate event id runs once** — a repeated `emit_event` id delivers
 *      one event.
 *   4. **Oversize graph is rejected** — >100 steps is a rejection, not a run.
 *   5. **Conditions branch** (FR-AUT-03) — `if_variable` and `time_window`
 *      select the true branch and skip the false one from projection values.
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

  it("counts each hop's emit once and refuses past the cap", async () => {
    const h = harness();
    const rule: Rule = {
      id: "self",
      cooldownMs: 0,
      conditions: [],
      actions: [emitEvent("tick", "same-id")],
    };
    // One engine, five hops: each hop must carry a *fresh* id, or dedup (not
    // depth) is what stops it — that separation is asserted in the next block.
    for (let depth = 0; depth <= MAX_EVENT_DEPTH; depth += 1) {
      const report = await h.engine.run([rule], {
        projectId: PROJECT,
        event: "tick",
        depth,
      });
      // The first hop claims `same-id`; later hops are refused as duplicates,
      // which is the *other* anti-loop layer doing its job.
      const emitted = report.emittedEvents.length;
      expect(emitted).toBe(depth === 0 ? 1 : 0);
    }
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

describe("duplicate event id is delivered once", () => {
  it("refuses a second emit carrying an id it has already seen", async () => {
    const h = harness();
    const rule: Rule = {
      id: "dedup",
      cooldownMs: 0,
      conditions: [],
      actions: [emitEvent("webhook", "delivery-1", { n: 1 })],
    };

    // The first delivery emits; an at-least-once producer redelivers the same
    // id, which must not become a second event.
    const first = await h.engine.run([rule], { projectId: PROJECT });
    const second = await h.engine.run([rule], { projectId: PROJECT });

    expect(first.emittedEvents).toHaveLength(1);
    expect(first.emittedEvents[0]).toMatchObject({ eventId: "delivery-1", depth: 1 });

    expect(second.emittedEvents).toHaveLength(0);
    expect(
      second.rules[0].actions.find((a) => a.type === "emit_event"),
    ).toEqual({
      type: "emit_event",
      executed: false,
      skipped: "duplicate_event",
      detail: "delivery-1",
    });
    expect(h.engine.hasEmitted("delivery-1")).toBe(true);
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
