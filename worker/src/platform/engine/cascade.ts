/**
 * engine/cascade — the wired `emit_event` dispatcher (D3.6 / INV-U1 / ST-U1).
 *
 * `run.ts` decides *that* a rule emitted an event: a {@link RunReport} carries
 * `emittedEvents`, each stamped with `depth + 1`. But the engine is deliberately
 * a pure step — it runs the rules it is handed and returns; it never re-enters
 * itself. Nothing in the codebase consumed `emittedEvents`, so an `emit_event`
 * action was recorded and then dropped: the cascade the engine models was never
 * actually dispatched. This module is the missing wire.
 *
 * ## What it does
 *
 * {@link createCascadeDispatcher} builds an {@link EventDispatcher} (the exact
 * seam `POST /v1/events` already calls) that:
 *
 *   1. selects the candidate rules for the incoming event name
 *      ({@link CascadeOptions.rulesForEvent}) and runs them through the real
 *      {@link AutomationEngine};
 *   2. for each {@link EmittedEvent} the run produced, dispatches *that* event
 *      as a child run, carrying the child's own `depth`;
 *   3. repeats, so an action that emits an event which wakes another rule runs
 *      its consequences — the cascade — **bounded by depth**.
 *
 * ## The depth cap is the outer bound (INV-U1)
 *
 * The engine already refuses to *emit* past {@link MAX_EVENT_DEPTH}
 * (`executeEmitEvent` marks such an action `depth_exceeded`), so a child deeper
 * than the cap is never produced. This dispatcher adds the belt to that
 * suspenders: before running a child it re-checks `depth > maxEventDepth` and
 * stops, so even a mis-stamped child cannot recurse without bound. A
 * self-triggering rule therefore terminates at a knowable depth rather than
 * looping forever (ST-U1).
 *
 * ## Dedup is the cascade's, owned here
 *
 * The engine's own dedup set is **per run** — one `run()` invocation cannot
 * remember an id another invocation emitted (that is what makes two concurrent
 * runs independent; see `run.ts`). "A repeated id delivers once" is a property
 * of the *cascade*, not of one run, so this dispatcher owns it: each dispatch
 * tree carries a set of the ids it has already dispatched, and a child whose id
 * is already in it is not dispatched again. The set is scoped to the dispatch
 * (allocated when it starts, discarded when it ends), so it is bounded by the
 * cascade it is deduping and never grows across unrelated events.
 *
 * ## Nothing here owns storage or a clock
 *
 * The rule selector and the engine are injected. The dispatcher is pure
 * orchestration: it holds no rules, reads no clock and reaches for no binding —
 * so it can be driven in a test with an in-memory selector and the engine's own
 * in-memory seams.
 */

import {
  MAX_EVENT_DEPTH,
  type AutomationEngine,
  type EmittedEvent,
  type Rule,
  type Trigger,
} from "./run";

// ---------------------------------------------------------------------------
// Seams & options
// ---------------------------------------------------------------------------

/**
 * Select the candidate rules for one event name.
 *
 * This is the "trigger router" the engine's own `run` docblock names as its
 * caller's business: the engine runs the rules it is given, and something must
 * decide *which* stored rules an incoming event selects. Returns `[]` for an
 * event no rule matches, which is an ordinary no-op, never an error.
 */
export type RulesForEvent = (event: string, projectId: string) => Promise<readonly Rule[]> | readonly Rule[];

/** Options for {@link createCascadeDispatcher}. */
export interface CascadeOptions {
  /** The real engine (A21) whose runs produce the emitted events. */
  readonly engine: AutomationEngine;
  /** The trigger router: event name → the stored rules it selects. */
  readonly rulesForEvent: RulesForEvent;
  /**
   * Cascade depth cap. Defaults to the engine's own {@link MAX_EVENT_DEPTH}, so
   * the dispatcher's bound and the engine's emit bound agree by construction.
   */
  readonly maxEventDepth?: number;
  /**
   * Optional observer, called once per run with the report's event id and the
   * events it emitted — the audit hook a caller uses to log a cascade without
   * the dispatcher owning a logger.
   */
  readonly onRun?: (info: CascadeRunInfo) => void;
}

/** What one run in the cascade did, for an optional observer. */
export interface CascadeRunInfo {
  readonly projectId: string;
  readonly event: string;
  readonly depth: number;
  /** The depth-`+1` events this run produced, in order. */
  readonly emitted: readonly EmittedEvent[];
}

/** The dispatcher shape: the same seam `POST /v1/events` consumes. */
export type CascadeDispatcher = (trigger: Trigger) => Promise<void>;

/**
 * The ceiling on the dispatcher's delivered-id memory. Dedup has to outlive a
 * single dispatch to mean "delivered once" for an at-least-once producer, so
 * the dispatcher keeps the ids it has delivered — but bounded, evicting the
 * oldest first, exactly as the engine bounds its cooldown map. A cascade only
 * ever emits a bounded burst per event, so the bound is generous; it exists so
 * a long-lived dispatcher cannot grow one entry per event id forever.
 */
export const MAX_DEDUP_IDS = 1024;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Build the cascade dispatcher.
 *
 * The returned function takes the root {@link Trigger} (`depth: 0` from the
 * events route) and drives the whole cascade synchronously: it is itself the
 * background unit of work the events route hands off, so awaiting it to
 * completion is exactly "the event and everything it woke has run".
 */
export function createCascadeDispatcher(options: CascadeOptions): CascadeDispatcher {
  const { engine, rulesForEvent } = options;
  const maxDepth = options.maxEventDepth ?? MAX_EVENT_DEPTH;
  const onRun = options.onRun;

  /**
   * The ids this dispatcher has already delivered, across every dispatch it has
   * driven — insertion-ordered, so the oldest is evicted once it reaches
   * {@link MAX_DEDUP_IDS}, exactly as the engine bounds its cooldown map.
   *
   * Dedup lives here rather than in the engine because the engine's own set is
   * per `run()`: a redelivery arrives as a *separate* dispatch, and "delivered
   * once" has to span it. Bounding the set keeps that memory from growing with
   * the event stream.
   */
  const deliveredIds = new Set<string>();

  /** Remember a delivered id, evicting the oldest entry past the cap. */
  function rememberDelivered(eventId: string): void {
    if (deliveredIds.has(eventId)) deliveredIds.delete(eventId);
    else if (deliveredIds.size >= MAX_DEDUP_IDS) {
      const oldest = deliveredIds.keys().next().value;
      if (oldest !== undefined) deliveredIds.delete(oldest);
    }
    deliveredIds.add(eventId);
  }

  /**
   * Run one trigger's rules, then dispatch each emitted event as a child.
   *
   * Children whose id {@link deliveredIds} already holds are not dispatched
   * again — the cascade-wide "delivered once" the engine's per-run set cannot
   * express.
   */
  async function dispatchTrigger(trigger: Trigger): Promise<void> {
    const depth = trigger.depth ?? 0;
    const event = trigger.event ?? "";

    const rules = await rulesForEvent(event, trigger.projectId);
    if (rules.length === 0) return;

    const report = await engine.run(rules, trigger);

    onRun?.({
      projectId: trigger.projectId,
      event,
      depth,
      emitted: report.emittedEvents,
    });

    for (const emitted of report.emittedEvents) {
      // A child already delivered is delivered once, however often it is emitted.
      if (deliveredIds.has(emitted.eventId)) continue;
      // Belt to the engine's suspenders: never recurse past the cap, even if a
      // child arrived with a depth the engine would not itself have produced.
      if (emitted.depth > maxDepth) continue;
      rememberDelivered(emitted.eventId);
      await dispatchTrigger({
        projectId: trigger.projectId,
        event: emitted.event,
        depth: emitted.depth,
      });
    }
  }

  return dispatchTrigger;

}

export default createCascadeDispatcher;
