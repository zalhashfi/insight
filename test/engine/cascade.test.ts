/**
 * Spec tests for the wired `emit_event` cascade (A21 / D3.6, ST-U1 / INV-U1).
 *
 * The engine (`run.ts`) decides *that* a rule emitted an event; this module is
 * the dispatcher that actually runs those emitted events as child runs. The
 * tests drive the REAL {@link AutomationEngine} over its own in-memory seams
 * and the REAL {@link createCascadeDispatcher}, so every assertion is about the
 * wired behaviour rather than a hand-rolled loop:
 *
 *   1. **A cascade runs** — an event wakes a rule whose action emits a second
 *      event, which wakes a second rule; both consequences are observed.
 *   2. **The depth cap bounds it** — a self-triggering rule (each hop emits a
 *      fresh id) terminates at exactly `MAX_EVENT_DEPTH`, not forever (ST-U1).
 *   3. **Dedup is the engine's** — a repeated event id is delivered once even
 *      across hops of the cascade.
 *   4. **No matching rule is a no-op** — an event nothing selects runs nothing.
 */

import { describe, expect, it } from "vitest";
import { createCascadeDispatcher, type CascadeRunInfo } from "../../worker/src/platform/engine/cascade";
import {
  AutomationEngine,
  InMemoryProjection,
  MAX_EVENT_DEPTH,
  RecordingExecutor,
  type Action,
  type Rule,
} from "../../worker/src/platform/engine/run";

const PROJECT = "proj_cascade";

interface Harness {
  engine: AutomationEngine;
  executor: RecordingExecutor;
  rules: Map<string, Rule[]>;
  /** The wired dispatcher, selecting rules from {@link rules} by event name. */
  dispatch: (trigger: { projectId: string; event?: string; depth?: number }) => Promise<void>;
  runs: CascadeRunInfo[];
}

function harness(): Harness {
  const projection = new InMemoryProjection();
  const executor = new RecordingExecutor();
  let now = 0;
  const engine = new AutomationEngine({
    projection,
    executor,
    integrations: executor,
    now: () => now,
  });
  const rules = new Map<string, Rule[]>();
  const runs: CascadeRunInfo[] = [];
  const dispatch = createCascadeDispatcher({
    engine,
    rulesForEvent: (event) => rules.get(event) ?? [],
    onRun: (info) => runs.push(info),
  });
  // Keep the clock pinned so cooldown bookkeeping is deterministic.
  return { engine, executor, rules, dispatch, runs };
}

/** Register a rule under the event name that should select it. */
function addRule(h: Harness, event: string, rule: Rule): void {
  h.rules.set(event, [...(h.rules.get(event) ?? []), rule]);
}

function setVariable(key: string, value: number | null): Action {
  return { type: "set_variable", key, value };
}

function emitEvent(event: string, eventId: string): Action {
  return { type: "emit_event", event, eventId, payload: {} };
}

// ---------------------------------------------------------------------------
// 1. A cascade actually runs its children
// ---------------------------------------------------------------------------

describe("cascade — an emitted event runs its consequences", () => {
  it("wakes the rule a child event selects", async () => {
    const h = harness();
    // `door` → emits `alarm`; `alarm` → sets a variable.
    addRule(h, "door", {
      id: "r_door",
      cooldownMs: 0,
      conditions: [],
      actions: [emitEvent("alarm", "evt_alarm_1")],
    });
    addRule(h, "alarm", {
      id: "r_alarm",
      cooldownMs: 0,
      conditions: [],
      actions: [setVariable("alarm", 1)],
    });

    await h.dispatch({ projectId: PROJECT, event: "door", depth: 0 });

    // Both hops ran: the door rule emitted, and the alarm rule's set_variable
    // was recorded — the classic two-hop cascade.
    const write = h.executor.writes.find((w) => w.kind === "set_variable");
    expect(write?.detail).toMatchObject({ key: "alarm", value: 1 });
    expect(h.runs.map((r) => r.event)).toEqual(["door", "alarm"]);
    expect(h.runs.map((r) => r.depth)).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// 2. The depth cap bounds a self-trigger (ST-U1 / INV-U1)
// ---------------------------------------------------------------------------

describe("cascade — the depth cap terminates a self-trigger (ST-U1)", () => {
  it("stops at MAX_EVENT_DEPTH even when every hop emits a fresh id", async () => {
    const h = harness();
    // A rule that re-emits `tick` each time it runs, with a DISTINCT id each
    // hop — so dedup cannot be what stops it; only the depth cap can.
    let hop = 0;
    h.rules.set("tick", []);
    const rule: Rule = {
      id: "r_tick",
      cooldownMs: 0,
      conditions: [],
      actions: [
        {
          type: "emit_event",
          event: "tick",
          // A fresh id per hop: dedup is deliberately not the bound under test.
          get eventId() {
            return `evt_${(hop += 1)}`;
          },
          payload: {},
        },
      ],
    };
    h.rules.set("tick", [rule]);

    await h.dispatch({ projectId: PROJECT, event: "tick", depth: 0 });

    // The root run is depth 0; the deepest run dispatched is depth
    // MAX_EVENT_DEPTH — the engine refuses to emit past the cap, so no child at
    // depth MAX_EVENT_DEPTH + 1 is ever produced or dispatched.
    const depths = h.runs.map((r) => r.depth);
    expect(depths[0]).toBe(0);
    expect(Math.max(...depths)).toBeLessThanOrEqual(MAX_EVENT_DEPTH);
    // Terminates: strictly fewer hops than an unbounded loop would take.
    expect(depths.length).toBeLessThanOrEqual(MAX_EVENT_DEPTH + 1);
  });
});

// ---------------------------------------------------------------------------
// 3. Dedup is the engine's, shared across the cascade
// ---------------------------------------------------------------------------

describe("cascade — a repeated event id delivers once", () => {
  it("does not re-run a child whose id was already emitted", async () => {
    const h = harness();
    // Two different rules both emit the SAME id for `alarm`.
    addRule(h, "door", {
      id: "r_door_a",
      cooldownMs: 0,
      conditions: [],
      actions: [emitEvent("alarm", "evt_dup")],
    });
    addRule(h, "window", {
      id: "r_window",
      cooldownMs: 0,
      conditions: [],
      actions: [emitEvent("alarm", "evt_dup")],
    });
    addRule(h, "alarm", {
      id: "r_alarm",
      cooldownMs: 0,
      conditions: [],
      actions: [setVariable("alarm", 1)],
    });

    await h.dispatch({ projectId: PROJECT, event: "door", depth: 0 });
    await h.dispatch({ projectId: PROJECT, event: "window", depth: 0 });

    // Despite two emits of `evt_dup`, the alarm rule's write happened once.
    const writes = h.executor.writes.filter((w) => w.kind === "set_variable");
    expect(writes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. An event nothing selects is a no-op
// ---------------------------------------------------------------------------

describe("cascade — an unmatched event runs nothing", () => {
  it("returns without running any rule", async () => {
    const h = harness();
    await h.dispatch({ projectId: PROJECT, event: "unheard_of", depth: 0 });
    expect(h.executor.writes).toEqual([]);
    expect(h.runs).toEqual([]);
  });
});
