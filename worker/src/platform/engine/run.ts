/**
 * Automation engine — the trigger → condition → action DAG, over injected seams.
 *
 * ## Why this unit exists
 *
 * A project's automations react to the world: a variable crosses a threshold, a
 * schedule fires, a discrete event arrives. The engine is the piece that turns
 * "something happened" into "these actions run, in this order, at most this
 * often". It is deliberately the *whole* decision surface for one trigger and
 * nothing else — no HTTP, no Durable Object, no storage of its own:
 *
 *   * **What the world looks like** arrives through a {@link ProjectionReader}
 *     seam (D3.8: the engine reads the `ProjectDO` projection, never a shard).
 *     This unit defines only the *port*; the ProjectDO adapter is a later unit,
 *     so the engine can be reasoned about — and tested — without one.
 *   * **What to do about it** leaves through an {@link ActionExecutor} seam
 *     (writes: `set_variable`, `delay`) and an {@link IntegrationCaller} seam
 *     (network egress: `call_integration`).
 *   * **When it is** arrives through a {@link Clock} seam, so a test advances
 *     time by moving a value it owns rather than by sleeping.
 *
 * ## The pipeline
 *
 *     trigger → conditions (all must pass) → actions (in order)
 *
 * A *rule* is a trigger, an optional list of conditions, and an ordered list of
 * actions. A *run* evaluates every candidate rule once for one triggering
 * request — the request is the unit of work, and the whole run is bounded:
 *
 *   1. **Graph size (D3.6).** A rule with more than {@link MAX_STEPS} (100)
 *      condition+action nodes is *invalid* and is rejected, never executed. The
 *      limit is the outer bound on how much work one rule can ask for.
 *   2. **Conditions.** Every condition in the rule must hold (logical AND).
 *      A condition that cannot be answered (a missing variable, a comparison
 *      against a non-number) is `false`, never an error — see "Fail closed".
 *   3. **Actions.** Run in order. Total executed actions across a run are
 *      additionally capped at {@link MAX_STEPS}, so a rule exactly at the
 *      limit and a run's accumulated budget agree on the same number.
 *
 * ## Anti-loop, in layers (D3.6 / INV-U1 / INV-U4)
 *
 * `emit_event` is the loop primitive: an emitted event can wake the very rule
 * that emitted it (`set_variable` → variable trigger → `set_variable` → …). No
 * single mechanism is enough, so three compose:
 *
 *   1. **Depth cap.** Each run tracks the *depth* of the event currently being
 *      processed. A rule's direct run is depth 0; an action that reacts to an
 *      event may `emit_event` a child at `depth + 1`. An `emit_event` past
 *      {@link MAX_EVENT_DEPTH} (5) is not emitted — the cascade *stops at the
 *      cap*, it does not run forever (ST-U1).
 *   2. **Cooldown.** Each rule records the instant it last executed; a rule is
 *      skipped when `now - lastExecution < cooldownMs`. An oscillating variable
 *      (up/down/up/down) therefore fires at most once per cooldown window
 *      instead of once per change (ST-U3 / INV-U3).
 *   3. **Event-id dedup.** An `emit_event` carries an id; a repeated id is
 *      delivered **once per run**. An at-least-once producer (a redelivered
 *      webhook, a device retry) cannot turn one logical event into two
 *      executions.
 *
 * ## One run's state is its own
 *
 * The step budget and the event-id dedup set are allocated inside `run` and
 * reach no other invocation, so two runs over one engine — a dispatcher that
 * does not `await` a background run, say — each obey {@link MAX_STEPS}
 * independently instead of resetting a shared counter under each other.
 *
 * The one exception, deliberately, is **cooldown**: `now - lastExecution <
 * cooldownMs` is a cross-run property by definition (an oscillating variable
 * must be throttled *between* runs, not within one), so it stays on the
 * instance — bounded by {@link MAX_TRACKED_RULES}, evicting the stalest entry.
 *
 * ## Fail closed
 *
 * The engine never throws for a rule or graph it can reject or cannot evaluate.
 * Missing projection data is `false`; a malformed comparison is `false`; an
 * `emit_event` with no id is skipped; an oversize graph is a recorded error — a
 * rejected run is a *result*, not an exception, so one broken rule cannot take
 * the triggering request down with it.
 *
 * ## Ordering, cooldown and a run's own actions
 *
 * Cooldown is checked against the rule's *own* execution history, so a rule
 * that has just fired is skipped on the next evaluate even inside one run (the
 * anti-storm property) — while the first run remains free, so a legitimate
 * `temp > 30` firing once is never suppressed. Variables a run writes are not
 * folded back into the projection the same run reads: the projection is the
 * pre-run world, which keeps the pipeline's meaning stable and makes the whole
 * run deterministic given its seams.
 */

import { checkKey, checkValue } from "../../shared/validation";
import type { Clock } from "../lib/clock";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum condition + action nodes in one rule (D3.6). */
export const MAX_STEPS = 100;

/** Maximum `emit_event` cascade depth (D3.6 / ST-U1). */
export const MAX_EVENT_DEPTH = 5;

/** The default value-equality tolerance for `if_variable` (FR-AUT-03). */
export const DEFAULT_VALUE_EPSILON = 1e-9;

/**
 * The ceiling on the engine's cross-run cooldown memory: the most distinct
 * rule ids an instance tracks before it evicts the stalest entry. Kernel-
 * resident and long-lived instances see a bounded, rotating set of automations
 * (rules are `ProjectDO`-scoped, not per-engine), so without a cap the cooldown
 * map would grow one entry per distinct rule id forever. Eviction only ever
 * forgets a cooldown, so the worst it can do is *admit* a run early — it can
 * never drop an event a caller is owed.
 */
export const MAX_TRACKED_RULES = 1024;

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The projection port the engine reads conditions from (D3.8).
 *
 * The engine asks one question — "what is the latest value of this variable in
 * this project?" — and gets either the value or `null` for "never seen". It
 * does not know about devices, seq, ts or storage: the `ProjectDO` projection
 * answers on the other side of the seam.
 */
export interface ProjectionReader {
  /**
   * The latest value of `key` in `projectId`, or `null` when the project has
   * never seen that variable. `readonly` so a caller cannot mutate the world
   * through the port.
   */
  latestValue(projectId: string, key: string): Promise<number | null>;
}

/** A write the engine asks the platform to perform on its behalf. */
export interface SetVariableWrite {
  readonly projectId: string;
  readonly key: string;
  /** `null` clears the variable; a finite number sets it. */
  readonly value: number | null;
}

/**
 * The side-effecting port for local writes.
 *
 * `set_variable` routes here; `delay` is recorded here too (as an intent — A22
 * persists it and drives the alarm, so this unit creates no timer). Every write
 * returns whether it landed and, optionally, why not, so a run can report a
 * genuine failure honestly rather than pretending it succeeded.
 */
export interface ActionExecutor {
  setVariable(write: SetVariableWrite): Promise<ActionWriteResult>;
  /**
   * Record a pending delay of `durationMs`. Non-blocking by contract: the
   * engine does not wait for it (A22 owns exactly-once delivery).
   */
  enqueueDelay(request: DelayRequest): Promise<ActionWriteResult>;
}

/** Outcome of one write against the platform. */
export interface ActionWriteResult {
  readonly ok: boolean;
  /** Present when `ok` is false; free-form for diagnostics. */
  readonly error?: string;
}

/** A delay recorded as an intent; the scheduler is the one who executes it. */
export interface DelayRequest {
  readonly projectId: string;
  readonly ruleId: string;
  /** How long the delay lasts, in milliseconds. */
  readonly durationMs: number;
  /** The instant the delay was recorded (epoch ms). */
  readonly requestedAt: number;
}

/** The network-egress port for `call_integration`. */
export interface IntegrationCaller {
  /** Invoke an integration by id with a payload; never throws to the engine. */
  call(request: IntegrationCallRequest): Promise<ActionWriteResult>;
}

/** One `call_integration` invocation. */
export interface IntegrationCallRequest {
  readonly projectId: string;
  readonly integrationId: string;
  /** The request body the action carried, stored opaquely. */
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Graph model
// ---------------------------------------------------------------------------

/** The kinds of condition a rule may carry (FR-AUT-03). */
export type ConditionType = "if_variable" | "time_window";

/** The kinds of action a rule may carry (FR-AUT-04). */
export type ActionType =
  | "set_variable"
  | "emit_event"
  | "call_integration"
  | "delay";

/** Compare a projected variable against a literal. */
export interface IfVariableCondition {
  readonly type: "if_variable";
  /** The projection key to read. */
  readonly key: string;
  readonly op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  readonly value: number;
  /** Effective only for `eq`/`neq`; defaults to {@link DEFAULT_VALUE_EPSILON}. */
  readonly epsilon?: number;
}

/**
 * Test the current instant against an optional window.
 *
 * Anchored to UTC minutes-since-midnight from the injected clock, so the window
 * is a pure function of the clock and the rule (`[start, end)`; wrapping
 * overnight when `end < start`). Both bounds are inclusive-start, exclusive-end.
 */
export interface TimeWindowCondition {
  readonly type: "time_window";
  /** Inclusive lower bound, minutes since UTC midnight (0–1440). */
  readonly startMinute: number;
  /** Exclusive upper bound, minutes since UTC midnight (0–1440). */
  readonly endMinute: number;
}

export type Condition = IfVariableCondition | TimeWindowCondition;

/** Write a project variable; `value: null` clears it. */
export interface SetVariableAction {
  readonly type: "set_variable";
  readonly key: string;
  readonly value: number | null;
}

/** Emit a discrete event that may itself trigger rules (the loop primitive). */
export interface EmitEventAction {
  readonly type: "emit_event";
  readonly event: string;
  /**
   * The event's identity. Dedup is keyed on it, so a repeated id runs its
   * consequences once. An `emit_event` with no id is skipped (it cannot be
   * deduped, so delivering it would break idempotency).
   */
  readonly eventId?: string;
  /** The event body, stored opaquely. */
  readonly payload?: unknown;
}

/** Call an external integration. */
export interface CallIntegrationAction {
  readonly type: "call_integration";
  readonly integrationId: string;
  readonly payload?: unknown;
}

/** Record a pending delay (A22 persists and schedules it). */
export interface DelayAction {
  readonly type: "delay";
  readonly durationMs: number;
}

export type Action =
  | SetVariableAction
  | EmitEventAction
  | CallIntegrationAction
  | DelayAction;

/** One automation: trigger, conditions, actions. */
export interface Rule {
  readonly id: string;
  /** Anti-storm minimum spacing between two executions of this rule, in ms. */
  readonly cooldownMs: number;
  readonly conditions: readonly Condition[];
  readonly actions: readonly Action[];
}

/** The triggering request the engine runs against. */
export interface Trigger {
  /** The project whose projection the conditions read. */
  readonly projectId: string;
  /** The event name that woke a rule, when the trigger was a discrete event. */
  readonly event?: string;
  /**
   * The depth of the event being processed: a direct run is `0`. Used to cap
   * `emit_event` cascades ({@link MAX_EVENT_DEPTH}).
   */
  readonly depth?: number;
}

/** Construction options for {@link AutomationEngine}. */
export interface AutomationEngineOptions {
  /** Reads condition inputs (D3.8). */
  readonly projection: ProjectionReader;
  /** Applies local writes: `set_variable`, and delays as intents. */
  readonly executor: ActionExecutor;
  /** Performs `call_integration` egress. */
  readonly integrations: IntegrationCaller;
  /** Clock returning Unix epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: Clock;
  /** Steps per rule. Defaults to {@link MAX_STEPS}; a graph past it is rejected. */
  readonly maxSteps?: number;
  /** `emit_event` cascade depth cap. Defaults to {@link MAX_EVENT_DEPTH}. */
  readonly maxEventDepth?: number;
  /** Value-equality tolerance for `if_variable`. Defaults to {@link DEFAULT_VALUE_EPSILON}. */
  readonly valueEpsilon?: number;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** How a rule's run ended. */
export type RuleStatus =
  | "executed" // ran to completion
  | "skipped_cooldown" // inside its cooldown window (ST-U3)
  | "skipped_no_match"; // the trigger did not select it

/** Why a single action did not take effect. */
export type ActionSkipReason =
  | "depth_exceeded" // emit_event past MAX_EVENT_DEPTH (ST-U1)
  | "duplicate_event" // emit_event id already emitted (dedup)
  | "missing_event_id" // emit_event with no id cannot be deduped
  | "invalid_write" // set_variable key/value failed validation
  | "executor_error" // the seam reported a failure
  | "step_limit"; // the run ran out of its step budget

/** The recorded outcome of one action, executed or not. */
export interface ActionOutcome {
  readonly type: ActionType;
  readonly executed: boolean;
  /** Present only when `executed` is false. */
  readonly skipped?: ActionSkipReason;
  /** Free-form detail (the seam's error, the dedup key, …). */
  readonly detail?: string;
}

/** The recorded outcome of running one rule. */
export interface RuleRunReport {
  readonly ruleId: string;
  readonly status: RuleStatus;
  /**
   * Present when the rule was structurally rejected — its graph exceeded the
   * step limit. A rejected rule is never evaluated or executed.
   */
  readonly error?: string;
  /** Per-condition verdicts, in rule order; empty when not evaluated. */
  readonly conditions: readonly boolean[];
  /** Per-action outcomes, in rule order. */
  readonly actions: readonly ActionOutcome[];
}

/** The recorded outcome of a whole run over one trigger. */
export interface RunReport {
  /** The triggering event's identity (event id, or `${projectId}#${n}`). */
  readonly rootEventId: string;
  /** The depth this run processed (`trigger.depth ?? 0`). */
  readonly depth: number;
  readonly rules: readonly RuleRunReport[];
  /** The run's own step budget, for callers reading the cap back. */
  readonly maxSteps: number;
  /** Events emitted by this run, in order — the cascade's next inputs. */
  readonly emittedEvents: readonly EmittedEvent[];
}

/** One event emitted by an action, ready to be dispatched as a child run. */
export interface EmittedEvent {
  readonly eventId: string;
  readonly event: string;
  readonly payload: unknown;
  /** `depth + 1` — what a child run should be given as its {@link Trigger.depth}. */
  readonly depth: number;
}

/**
 * The mutable state a single {@link AutomationEngine.run} call owns.
 *
 * It is allocated fresh in `run` and threaded down to the per-rule helpers, so
 * it is never reachable from any other invocation: two runs in flight at once
 * can neither read nor reset each other's {@link RunState.steps} budget or
 * {@link RunState.emittedEventIds} dedup set.
 */
interface RunState {
  /** Condition + action nodes consumed so far this run, against {@link MAX_STEPS}. */
  steps: number;
  /** Event ids this run has already emitted; the per-run dedup set. */
  readonly emittedEventIds: Set<string>;
}

/** Left-closed, right-open window: `[start, end)`, wrapping when `end < start`. */
function withinWindow(minute: number, startMinute: number, endMinute: number): boolean {
  if (startMinute <= endMinute) {
    return minute >= startMinute && minute < endMinute;
  }
  // Overnight: e.g. a 22:00 → 06:00 window is the union of both ends.
  return minute >= startMinute || minute < endMinute;
}

/**
 * The automation engine. Construct with {@link AutomationEngineOptions} and
 * {@link AutomationEngine.run} it against a {@link Trigger} of candidate rules.
 */
export class AutomationEngine {
  private readonly projection: ProjectionReader;
  private readonly executor: ActionExecutor;
  private readonly integrations: IntegrationCaller;
  private readonly clock: Clock;
  private readonly maxSteps: number;
  private readonly maxEventDepth: number;
  private readonly valueEpsilon: number;

  /**
   * Rule id → the instant (epoch ms) it last executed. The only *cross-run*
   * state the engine keeps, and the only state a run mutates in place.
   *
   * It is bounded by {@link MAX_TRACKED_RULES}: the map holds at most one entry
   * per distinct rule id ever run, and once it reaches the cap the stalest
   * entry (the earliest execution) is evicted before a new one is added — the
   * rule that has waited longest for its cooldown to lapse is the safest to
   * forget, since forgetting it can only ever *admit* a run, never suppress a
   * legitimate one.
   */
  private readonly lastRunAt = new Map<string, number>();

  constructor(options: AutomationEngineOptions) {
    this.projection = options.projection;
    this.executor = options.executor;
    this.integrations = options.integrations;
    this.clock = options.now ?? (() => Date.now());
    this.maxSteps = options.maxSteps ?? MAX_STEPS;
    this.maxEventDepth = options.maxEventDepth ?? MAX_EVENT_DEPTH;
    this.valueEpsilon = options.valueEpsilon ?? DEFAULT_VALUE_EPSILON;
  }

  /**
   * Run every candidate rule once for one trigger.
   *
   * Rules are evaluated in the order given (the caller — the trigger router —
   * owns selection and ordering, so it can put specific rules before catch-all
   * ones). The run carries a step budget of {@link MAX_STEPS} shared by the
   * involved rules; a rule whose actions exhaust it stops early rather than
   * overrunning.
   *
   * The budget and the emitted-id dedup set live in this call's own
   * {@link RunState}, so two runs over one engine — a dispatcher that does not
   * await a background run, say — cannot reset or exhaust each other's budget.
   * The only state shared across runs is the bounded cooldown map.
   *
   * Returns a {@link RunReport}; it never throws for a rule it can reject.
   */
  async run(rules: readonly Rule[], trigger: Trigger): Promise<RunReport> {
    const depth = trigger.depth ?? 0;
    const rootEventId =
      trigger.event !== undefined
        ? `${trigger.projectId}\u0000${trigger.event}`
        : `${trigger.projectId}#direct`;

    // Local to THIS invocation: neither field is ever touched by another run.
    const state: RunState = { steps: 0, emittedEventIds: new Set() };
    const reports: RuleRunReport[] = [];
    const emittedEvents: EmittedEvent[] = [];

    for (const rule of rules) {
      reports.push(await this.runRule(rule, trigger, depth, state, emittedEvents));
    }

    return {
      rootEventId,
      depth,
      rules: reports,
      maxSteps: this.maxSteps,
      emittedEvents,
    };
  }

  /** The instant this rule last executed, or `undefined` if never. */
  lastExecution(ruleId: string): number | undefined {
    return this.lastRunAt.get(ruleId);
  }

  /**
   * The number of rules whose cooldown this engine currently remembers. Bounded
   * by {@link MAX_TRACKED_RULES} — the caller-visible proof that the cross-run
   * state does not grow without limit.
   */
  get trackedRuleCount(): number {
    return this.lastRunAt.size;
  }

  // -------------------------------------------------------------------------
  // One rule
  // -------------------------------------------------------------------------

  private async runRule(
    rule: Rule,
    trigger: Trigger,
    depth: number,
    state: RunState,
    emittedEvents: EmittedEvent[],
  ): Promise<RuleRunReport> {
    // 1. Structural rejection: a graph past the step limit never runs.
    const nodeCount = rule.conditions.length + rule.actions.length;
    if (nodeCount > this.maxSteps) {
      return {
        ruleId: rule.id,
        status: "skipped_no_match",
        error: `graph has ${nodeCount} steps, limit is ${this.maxSteps}`,
        conditions: [],
        actions: [],
      };
    }

    // 2. Cooldown: a rule inside its window is skipped, not delayed.
    const now = this.clock();
    const last = this.lastRunAt.get(rule.id);
    if (last !== undefined && now - last < rule.cooldownMs) {
      return {
        ruleId: rule.id,
        status: "skipped_cooldown",
        conditions: [],
        actions: [],
      };
    }

    // 3. Conditions: all must hold (AND). A false condition means no actions.
    const verdicts: boolean[] = [];
    for (const condition of rule.conditions) {
      state.steps += 1;
      verdicts.push(await this.evaluate(condition, trigger.projectId));
    }
    if (verdicts.some((held) => !held)) {
      return {
        ruleId: rule.id,
        status: "skipped_no_match",
        conditions: verdicts,
        actions: [],
      };
    }

    // 4. Actions: run in order, bounded by the run's remaining step budget.
    const outcomes: ActionOutcome[] = [];
    for (const action of rule.actions) {
      if (state.steps >= this.maxSteps) {
        outcomes.push({ type: action.type, executed: false, skipped: "step_limit" });
        continue;
      }
      state.steps += 1;
      // Actions after the first execute unconditionally: a failing action is
      // recorded and the pipeline continues (no rollback — partial failure is
      // appending the report and carrying on, not unwinding).
      outcomes.push(await this.execute(action, rule, trigger, depth, state, emittedEvents));
    }

    // A rule that ran records its execution, which is what starts its cooldown.
    this.rememberExecution(rule.id, now);

    return {
      ruleId: rule.id,
      status: "executed",
      conditions: verdicts,
      actions: outcomes,
    };
  }

  // -------------------------------------------------------------------------
  // Conditions
  // -------------------------------------------------------------------------

  private async evaluate(
    condition: Condition,
    projectId: string,
  ): Promise<boolean> {
    switch (condition.type) {
      case "if_variable":
        return this.evaluateIfVariable(condition, projectId);
      case "time_window": {
        // Minutes since UTC midnight, so the window is a pure function of the
        // injected clock — no timezone of the host leaks in.
        const at = new Date(this.clock());
        const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
        return withinWindow(minute, condition.startMinute, condition.endMinute);
      }
    }
  }

  private async evaluateIfVariable(
    condition: IfVariableCondition,
    projectId: string,
  ): Promise<boolean> {
    // A key the platform would refuse is not a key the projection can answer.
    if (!checkKey(condition.key).ok) return false;

    const actual = await this.projection.latestValue(projectId, condition.key);
    // Missing variable, or a comparison against a non-number: fail closed.
    if (actual === null) return false;
    if (!checkValue(condition.value).ok) return false;

    const expected = condition.value;
    const epsilon = condition.epsilon ?? this.valueEpsilon;
    switch (condition.op) {
      case "eq":
        return Math.abs(actual - expected) <= epsilon;
      case "neq":
        return Math.abs(actual - expected) > epsilon;
      case "gt":
        return actual > expected;
      case "gte":
        return actual >= expected;
      case "lt":
        return actual < expected;
      case "lte":
        return actual <= expected;
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async execute(
    action: Action,
    rule: Rule,
    trigger: Trigger,
    depth: number,
    state: RunState,
    emittedEvents: EmittedEvent[],
  ): Promise<ActionOutcome> {
    switch (action.type) {
      case "set_variable":
        return this.executeSetVariable(action, trigger.projectId);

      case "emit_event":
        return this.executeEmitEvent(action, trigger, depth, state, emittedEvents);

      case "call_integration": {
        const result = await this.integrations.call({
          projectId: trigger.projectId,
          integrationId: action.integrationId,
          payload: action.payload,
        });
        return result.ok
          ? { type: "call_integration", executed: true }
          : { type: "call_integration", executed: false, skipped: "executor_error", detail: result.error };
      }

      case "delay": {
        const result = await this.executor.enqueueDelay({
          projectId: trigger.projectId,
          ruleId: rule.id,
          durationMs: action.durationMs,
          requestedAt: this.clock(),
        });
        return result.ok
          ? { type: "delay", executed: true }
          : { type: "delay", executed: false, skipped: "executor_error", detail: result.error };
      }
    }
  }

  private async executeSetVariable(
    action: SetVariableAction,
    projectId: string,
  ): Promise<ActionOutcome> {
    if (!checkKey(action.key).ok) {
      return { type: "set_variable", executed: false, skipped: "invalid_write", detail: "invalid key" };
    }
    if (!checkValue(action.value).ok) {
      return { type: "set_variable", executed: false, skipped: "invalid_write", detail: "invalid value" };
    }
    const result = await this.executor.setVariable({
      projectId,
      key: action.key,
      value: action.value,
    });
    return result.ok
      ? { type: "set_variable", executed: true }
      : { type: "set_variable", executed: false, skipped: "executor_error", detail: result.error };
  }

  private executeEmitEvent(
    action: EmitEventAction,
    trigger: Trigger,
    depth: number,
    state: RunState,
    emittedEvents: EmittedEvent[],
  ): ActionOutcome {
    // 1. Depth cap: the cascade stops at the limit (ST-U1 / INV-U1).
    if (depth >= this.maxEventDepth) {
      return { type: "emit_event", executed: false, skipped: "depth_exceeded" };
    }
    // 2. An event with no id cannot be deduped, so it is not delivered.
    if (action.eventId === undefined || action.eventId.length === 0) {
      return { type: "emit_event", executed: false, skipped: "missing_event_id" };
    }
    // 3. Dedup: the same id is delivered once per run, however often it is
    //    emitted — the set is this run's, so a separate run is unconstrained.
    if (state.emittedEventIds.has(action.eventId)) {
      return { type: "emit_event", executed: false, skipped: "duplicate_event", detail: action.eventId };
    }

    state.emittedEventIds.add(action.eventId);
    emittedEvents.push({
      eventId: action.eventId,
      event: action.event,
      payload: action.payload,
      depth: depth + 1,
    });
    return { type: "emit_event", executed: true };
  }

  /**
   * Record a rule's execution and keep the cooldown map bounded.
   *
   * The map is `MAX_TRACKED_RULES` entries at most: once it is full, the entry
   * with the earliest execution instant is dropped before the new one is
   * written — the stalest cooldown, so the eviction can only ever let a run
   * through early, never silence one that is due.
   */
  private rememberExecution(ruleId: string, now: number): void {
    const existing = this.lastRunAt.get(ruleId);
    // Refresh in place: a re-execution moves the rule to the map's tail, so
    // insertion order stays oldest-first and eviction is a single `.keys()`.
    if (existing !== undefined) {
      this.lastRunAt.delete(ruleId);
    } else if (this.lastRunAt.size >= MAX_TRACKED_RULES) {
      const stalest = this.lastRunAt.keys().next().value;
      if (stalest !== undefined) this.lastRunAt.delete(stalest);
    }
    this.lastRunAt.set(ruleId, now);
  }
}

// ---------------------------------------------------------------------------
// In-memory seams — honest defaults so a caller can run without a platform
// ---------------------------------------------------------------------------

/** A {@link ProjectionReader} over a plain map, for tests and local runs. */
export class InMemoryProjection implements ProjectionReader {
  private readonly values = new Map<string, number | null>();

  constructor(initial?: Record<string, number | null>) {
    for (const [key, value] of Object.entries(initial ?? {})) {
      this.values.set(key, value);
    }
  }

  set(key: string, value: number | null): void {
    this.values.set(key, value);
  }

  latestValue(_projectId: string, key: string): Promise<number | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
}

/** One recorded write, retained so a test can assert what the engine asked for. */
export interface RecordedWrite {
  readonly kind: "set_variable" | "delay" | "call_integration";
  readonly projectId: string;
  readonly detail: Record<string, unknown>;
}

/**
 * An {@link ActionExecutor} + {@link IntegrationCaller} that records everything
 * and always succeeds — the append-only journal a test reads back. Pass
 * `failing` to make specific writes report a failure and exercise the error
 * path.
 */
export class RecordingExecutor implements ActionExecutor, IntegrationCaller {
  readonly writes: RecordedWrite[] = [];

  constructor(private readonly failing: ReadonlySet<string> = new Set()) {}

  private record(kind: RecordedWrite["kind"], projectId: string, detail: Record<string, unknown>): ActionWriteResult {
    this.writes.push({ kind, projectId, detail });
    return this.failing.has(kind) ? { ok: false, error: `${kind} refused` } : { ok: true };
  }

  setVariable(write: SetVariableWrite): Promise<ActionWriteResult> {
    return Promise.resolve(
      this.record("set_variable", write.projectId, { key: write.key, value: write.value }),
    );
  }

  enqueueDelay(request: DelayRequest): Promise<ActionWriteResult> {
    return Promise.resolve(
      this.record("delay", request.projectId, {
        ruleId: request.ruleId,
        durationMs: request.durationMs,
        requestedAt: request.requestedAt,
      }),
    );
  }

  call(request: IntegrationCallRequest): Promise<ActionWriteResult> {
    return Promise.resolve(
      this.record("call_integration", request.projectId, {
        integrationId: request.integrationId,
        payload: request.payload,
      }),
    );
  }
}
