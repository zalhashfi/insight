/**
 * SchedulerDO — the project's **single alarm**, and the exactly-once delay
 * queue behind it (A22 / D3.7 / FR-AUT-05 / INV-U2 / ST-U2).
 *
 * An automation's `delay` action is recorded as an *intent*, never as a timer:
 * the engine hands the intent to the platform (see `DelayRequest` in
 * `platform/engine/run.ts`) and returns immediately, so a delay longer than the
 * request that created it cannot block that request (FR-AUT-05). This module is
 * the other half of that promise — the place the intent is actually honoured.
 *
 * ## One alarm, many reasons (the singleton)
 *
 * A project schedules all sorts of future work: a cron-like `schedule`, a
 * `sunset`/sunrise transition, a due delayed action, and a periodic poll of an
 * external source (`ext-poll`). Cloudflare gives a Durable Object exactly **one**
 * alarm slot, so this DO does not use one alarm per reason — it computes the
 * *nearest* instant across every scheduled item on every write:
 *
 * ```
 *   setAlarm(min(schedule, sunset, delay, ext-poll))
 * ```
 *
 * {@link SchedulerDO.refreshAlarm} is that computation and the only writer of
 * the alarm slot. Each kind of future work stores its own next instant under a
 * key, and the alarm is re-derived from all of them, so adding a kind is adding
 * a key — not a second alarm competing for one slot.
 *
 * ## Exactly-once delivery (INV-U2 / ST-U2)
 *
 * The hard part is not firing on time; it is firing *once*. Two platform facts
 * define the problem (see `spec.md` §6 / the DO alarm notes):
 *
 *   1. **An alarm is at-least-once.** The runtime may deliver the same alarm
 *      more than once (a retry, a second isolate, a duplicate wake). So "the
 *      alarm fired" is *not* evidence an action has not already run.
 *   2. **`deleteAlarm()` does not cancel a handler already running**, and
 *      resolution is coarse — a wake can be delayed by up to ~a minute. So the
 *      alarm cannot be used as the *record* of what has been delivered.
 *
 * Both point the same way: the durable record of "delivered" must be a **claim**
 * in storage, taken atomically, not the alarm. That is exactly D3.7:
 *
 * ```
 *   alarm  →  claim atomic (UPDATE … WHERE status='pending')  →  execute  →  mark 'done'
 * ```
 *
 * {@link SchedulerDO.claimDue} performs the claim through the storage seam as a
 * compare-and-set on `status`: it names the ids it read as `pending`, the store
 * flips `pending → claimed` for those and no others, and it returns **only the
 * rows it actually claimed**. A second alarm tick racing the first therefore
 * claims nothing — the rows are already `claimed`/`done` — and executes nothing.
 * Execution happens strictly *after* the claim returns the row, so no path can
 * run an action without holding the claim.
 *
 * ## Restart safety (ST-U2's "restart at or just before the alarm")
 *
 * Every piece of state lives in storage, never in memory: the delay rows and
 * their statuses, the schedule registers, and the alarm instant itself. So a DO
 * that is evicted and rehydrated — including one killed *at* the alarm instant —
 * loses nothing: the constructor re-reads storage, {@link SchedulerDO.init}
 * re-derives and re-arms the same alarm from the same due instants, and the
 * pending rows are still there to be claimed by the re-armed wake.
 *
 * The proof obligation is "**exactly one** execution (not zero, not two)" and it
 * is carried by two independent guards:
 *
 *   - **Not zero**: firing decisions come from the durable rows and the durable
 *     alarm instant, never from an in-memory timer that a restart would drop. A
 *     restart just before the instant re-arms that instant; a restart at it sees
 *     a due delay (`dueAt <= now`) and fires.
 *   - **Not two**: the claim is atomic in storage. A restart *after* the claim
 *     and before the execution leaves the row `claimed`, which is not `pending`,
 *     so the second wake claims nothing — the at-least-once alarm cannot
 *     double-execute (the "at-least-once must not double-execute" guard).
 *
 * One consequence is stated plainly because it is a deliberate choice, not an
 * omission: a job claimed and then crashed *before* it executed is **not**
 * re-claimed by a later tick. Exactly-once is the invariant this unit owes
 * (INV-U2); a lease/retry policy on a `claimed` row is a *different* decision
 * (at-least-once with duplicate suppression) and would reintroduce the double
 * execution this unit exists to prevent.
 *
 * ## Timing is not the guarantee; the claim is
 *
 * Delays fire on **or after** their due instant, never before: the alarm is set
 * to `dueAt`, the runtime may deliver it late, and a due row is only claimed
 * once `now >= dueAt`. An alarm delivered slightly early therefore executes
 * nothing, re-arms the same instant, and the action still fires exactly once.
 *
 * ## Seams
 *
 * A plain class with no Cloudflare types in its signature:
 *
 *   - **storage** — a {@link SchedulerStorage} seam. Production adapts the DO's
 *     embedded SQLite (`ctx.storage.sql`); tests drive
 *     {@link InMemorySchedulerStorage}, which models the *contract* the
 *     atomicity depends on: `claimDelays` flips only the rows still `pending`
 *     and reports which. Promise-based, so both satisfy it identically.
 *   - **now** — a {@link Clock} returning Unix epoch milliseconds. Tests pin it,
 *     so due instants and fire decisions are exactly knowable and no
 *     `Date.now()` leaks in.
 *   - **alarm** — an {@link AlarmSink} seam (`setAlarm` / `deleteAlarm` /
 *     `getAlarm`). Production passes the DO's `ctx.storage`; tests pass
 *     {@link InMemoryAlarmSink}, which records what was armed so "the earliest
 *     candidate won" is an assertable fact.
 *   - **executor** — an {@link ActionExecutor} seam. This module does not decide
 *     *what* a due action does (a re-run of an automation rule, an integration
 *     call); it decides only *when* and *whether-once*, then hands the payload
 *     to the executor and marks the row `done` only if the executor succeeded.
 *     The return shape is the engine's own `ActionWriteResult`, so there is one
 *     success/failure vocabulary across the two units.
 */

import type { ActionWriteResult } from "../engine/run";
import type { Clock } from "../lib/clock";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The lifecycle states of a delayed action (D3.7).
 *
 *   - `pending`  — recorded and not yet delivered; the only claimable state.
 *   - `claimed`  — taken by a wake; held by exactly one execution attempt.
 *   - `done`     — executed to success; terminal, never delivered again.
 *   - `failed`   — executed and the action reported failure; terminal for this
 *     delivery (a retry, if ever wanted, is a *new* policy and a new row).
 *
 * `claimed` is what makes "at-least-once alarm, exactly-once action" true: a
 * second tick cannot claim a row that is no longer `pending`.
 */
export const DELAY_STATUS = ["pending", "claimed", "done", "failed"] as const;

export type DelayStatus = (typeof DELAY_STATUS)[number];

/** The only status a delayed action is delivered in. */
export const DELAY_STATUS_PENDING: DelayStatus = "pending";

/** One recorded delayed action, as both stores persist it. */
export interface DelayRow {
  /** Caller-supplied identity (the engine's `job-id`); the primary key. */
  readonly id: string;
  readonly projectId: string;
  /** The rule whose action is being delayed, carried through to the handler. */
  readonly ruleId: string;
  /** The instant the action becomes due (epoch ms) — `requestedAt + durationMs`. */
  readonly dueAt: number;
  /** Opaque payload for the executor (the action context, as JSON). */
  readonly payload?: unknown;
  readonly status: DelayStatus;
}

/**
 * Persistence seam for the scheduler.
 *
 * Deliberately small, and its central method — {@link SchedulerStorage.claimDelays}
 * — is deliberately *not* "mark these done". A seam that only offered
 * "set status" would push the compare-and-set into the caller, where it cannot
 * be atomic. Instead the store is handed the exact ids the caller believes are
 * `pending` and must flip **only those that still are**, returning the ones it
 * flipped: the atomic claim is the store's contract, and production implements
 * it as a single `UPDATE … WHERE status='pending'` per id.
 *
 * The remaining methods carry the schedule registers (`schedules`, `sunset`,
 * `ext_poll`) and the alarm instant, so an eviction/restart re-derives the same
 * alarm from durable state (ST-U2).
 */
export interface SchedulerStorage {
  /** The full DDL, as statements, for the adapter to execute on construction. */
  ddl(): string[];

  /** Insert or replace one delayed action, keyed by its id. */
  putDelay(row: DelayRow): Promise<void>;
  /** The row for one id, or `null` when it has never been seen. */
  getDelay(id: string): Promise<DelayRow | null>;
  /** Every delayed action, oldest due first (so a wake drains in due order). */
  listDelays(): Promise<DelayRow[]>;

  /**
   * Atomically claim the subset of `ids` that are still `pending`.
   *
   * The compare-and-set D3.7 is built on: each id is flipped `pending →
   * claimed` *only* if it currently holds `pending`, and only the ids actually
   * flipped are returned. A second caller racing the first therefore gets an
   * empty (or smaller) result and cannot re-execute what was already taken.
   */
  claimDelays(ids: readonly string[]): Promise<DelayRow[]>;

  /** Set one row's status unconditionally (used for the terminal `done`/`failed`). */
  setDelayStatus(id: string, status: DelayStatus): Promise<void>;

  /** The next instant a `schedule` trigger is due, or `null` when none is set. */
  getScheduleAt(): Promise<number | null>;
  /** Register (or clear) the next `schedule` instant. */
  setScheduleAt(at: number | null): Promise<void>;
  /** The next `sunset`/sunrise transition instant, or `null`. */
  getSunsetAt(): Promise<number | null>;
  /** Register (or clear) the next `sunset` instant. */
  setSunsetAt(at: number | null): Promise<void>;
  /** The next external-poll instant, or `null`. */
  getExtPollAt(): Promise<number | null>;
  /** Register (or clear) the next external-poll instant. */
  setExtPollAt(at: number | null): Promise<void>;

  /** The alarm instant currently armed, or `null` when none is. */
  getAlarmAt(): Promise<number | null>;
  /** Persist the alarm instant this unit derived. */
  putAlarmAt(at: number | null): Promise<void>;
}

/**
 * The alarm slot seam — the platform's single `setAlarm`/`deleteAlarm`/`getAlarm`.
 *
 * Separate from {@link SchedulerStorage} because it is a *different* platform
 * surface from the DO's SQLite (the alarm lives on the storage context, not in a
 * table). Production maps these three calls onto
 * `ctx.storage.setAlarm` / `deleteAlarm` / `getAlarm`; tests map them onto
 * {@link InMemoryAlarmSink}, whose `armed` history makes the *earliest candidate
 * wins* contract directly assertable rather than inferred.
 */
export interface AlarmSink {
  /** Arm the single alarm for `at` (epoch ms), replacing any previous arm. */
  setAlarm(at: number): Promise<void>;
  /** Drop the alarm; a no-op when none is armed. */
  deleteAlarm(): Promise<void>;
  /** The armed instant, or `null` when no alarm is set. */
  getAlarm(): Promise<number | null>;
}

/**
 * What a due action is executed against — the scheduler's executor port.
 *
 * Identical in shape to the engine's `ActionExecutor` (both promise a
 * {@link ActionWriteResult}), so a run re-entered from a delay reports success
 * or failure in the one vocabulary the engine already uses. This module never
 * inspects the *action*: it passes the claimed {@link DelayRow} through and
 * reacts only to `ok`.
 */
export interface ActionExecutor {
  /** Execute the action a claimed delay stands for. */
  execute(row: DelayRow): Promise<ActionWriteResult>;
}

/** Construction options for {@link SchedulerDO}. */
export interface SchedulerDOOptions {
  readonly storage: SchedulerStorage;
  /** The alarm slot. Defaults to {@link InMemoryAlarmSink} (tests/embedded use). */
  readonly alarm?: AlarmSink;
  /** The executor for due actions. Defaults to a successful no-op executor. */
  readonly executor?: ActionExecutor;
  /** Clock returning Unix epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: Clock;
}

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

/** The four kinds of future work the single alarm arbitrates between. */
export type CandidateKind = "schedule" | "sunset" | "delay" | "ext_poll";

/** One candidate instant, as {@link SchedulerDO.nextWake} reports it. */
export interface WakeCandidate {
  readonly kind: CandidateKind;
  readonly at: number;
}

/** What the alarm instant is, and which candidate produced it. */
export interface WakePlan {
  /** The earliest candidate instant, or `null` when nothing is scheduled. */
  readonly at: number | null;
  /** The candidate(s) that produced {@link at} — the argmin of the candidates. */
  readonly candidates: readonly WakeCandidate[];
}

/** Outcome of an {@link SchedulerDO.enqueueDelay} call. */
export type EnqueueDelayResult =
  | { readonly ok: true; readonly row: DelayRow }
  | {
      readonly ok: false;
      readonly reason: "invalid_input";
      /** Which field was rejected, for a caller that wants to explain itself. */
      readonly field?: "id" | "dueAt" | "durationMs";
    };

/** Why a claimed action did not execute. */
export type ExecutionSkipReason = "executor_failed";

/** The recorded outcome of one due action a wake handled. */
export type ExecutionOutcome =
  | { readonly id: string; readonly ruleId: string; readonly executed: true }
  | {
      readonly id: string;
      readonly ruleId: string;
      readonly executed: false;
      readonly reason: ExecutionSkipReason;
      /** The executor's own diagnostic, when it gave one. */
      readonly error?: string;
    };

/**
 * Everything one alarm tick did, returned as a value (never a throw) so the
 * caller — the DO's `alarm()` handler — can log it or assert on it.
 */
export interface AlarmTickReport {
  /** The instant the tick observed (the injected clock). */
  readonly at: number;
  /** The rows this tick claimed and executed, in due order. */
  readonly executed: readonly ExecutionOutcome[];
  /** The instant the alarm was re-armed for, or `null` when nothing remains. */
  readonly armedFor: number | null;
  /** Which candidate(s) the re-armed instant came from. */
  readonly armedForKind: readonly CandidateKind[];
}

// ---------------------------------------------------------------------------
// SchedulerDO
// ---------------------------------------------------------------------------

/**
 * Run one wake. The DO's alarm handler delegates here; it is also the seam a
 * test calls directly to model "an alarm tick happened", including a
 * second (at-least-once) tick, without needing the platform's timer.
 */
export interface AlarmHandler {
  (): Promise<AlarmTickReport>;
}

/**
 * The scheduler. Construct with {@link SchedulerDOOptions}; call
 * {@link SchedulerDO.init} once (from `blockConcurrencyWhile`) to apply the DDL
 * and derive the alarm, then {@link SchedulerDO.enqueueDelay} as the engine
 * records intents, and let {@link SchedulerDO.alarm} drain them.
 */
export class SchedulerDO {
  private readonly storage: SchedulerStorage;
  private readonly alarmSink: AlarmSink;
  private readonly executor: ActionExecutor;
  private readonly clock: Clock;

  constructor(options: SchedulerDOOptions) {
    this.storage = options.storage;
    this.alarmSink = options.alarm ?? new InMemoryAlarmSink();
    this.executor = options.executor ?? new NoopExecutor();
    this.clock = options.now ?? (() => Date.now());
  }

  /**
   * Apply the DDL and re-derive the alarm from durable state.
   *
   * This is the restart path (ST-U2). Nothing needed to decide the next wake is
   * in memory: the delay rows are re-read from storage, the schedule registers'
   * persisted alarm instant is re-read, and {@link SchedulerDO.refreshAlarm}
   * re-arms exactly the instant the previous incarnation would have. Idempotent:
   * the DDL is `IF NOT EXISTS`, and re-deriving from the same registers is the
   * same answer.
   */
  async init(): Promise<void> {
    this.storage.ddl();
    await this.refreshAlarm();
  }

  /**
   * Record a delayed action — the durable half of a `delay` action (FR-AUT-05).
   *
   * Non-blocking by contract: it writes a `pending` row and re-arms the alarm,
   * and returns. Nothing here waits for the delay to elapse, so the request that
   * created it is free — a delay longer than that request still fires later,
   * exactly once.
   *
   * The due instant is `requestedAt + durationMs` (or an explicit `dueAt`), so
   * the caller's own clock decides the deadline and this method needs no clock
   * of its own. A malformed request (blank id, non-finite duration or due
   * instant, negative duration) is reported as a value, not thrown — it is a
   * bad receipt, not a scheduling decision.
   */
  async enqueueDelay(input: {
    id: string;
    projectId: string;
    ruleId: string;
    /** How long the delay lasts, in milliseconds. */
    durationMs?: number;
    /** The instant the delay was requested; defaults to the injected clock. */
    requestedAt?: number;
    /** An explicit due instant; when given, `durationMs` is ignored. */
    dueAt?: number;
    /** Opaque payload handed to the executor when the action fires. */
    payload?: unknown;
  }): Promise<EnqueueDelayResult> {
    if (typeof input.id !== "string" || input.id.trim().length === 0) {
      return { ok: false, reason: "invalid_input", field: "id" };
    }

    let dueAt: number;
    if (input.dueAt !== undefined) {
      if (!Number.isFinite(input.dueAt)) {
        return { ok: false, reason: "invalid_input", field: "dueAt" };
      }
      dueAt = input.dueAt;
    } else {
      const durationMs = input.durationMs;
      if (
        durationMs === undefined ||
        !Number.isFinite(durationMs) ||
        durationMs < 0
      ) {
        return { ok: false, reason: "invalid_input", field: "durationMs" };
      }
      dueAt = (input.requestedAt ?? this.clock()) + durationMs;
    }

    const row: DelayRow = {
      id: input.id,
      projectId: input.projectId,
      ruleId: input.ruleId,
      dueAt,
      payload: input.payload,
      status: DELAY_STATUS_PENDING,
    };
    await this.storage.putDelay(row);
    await this.refreshAlarm();
    return { ok: true, row: { ...row } };
  }

  /**
   * Register the next `schedule` (cron-like) instant, then re-derive the alarm.
   *
   * `null` clears the register. This is one of the three non-delay candidates
   * the single alarm has to arbitrate between; registering one cannot overwrite
   * another kind, and none of them can overwrite the delay queue — they all flow
   * through {@link SchedulerDO.refreshAlarm}, which takes the minimum.
   */
  async scheduleAt(at: number | null): Promise<void> {
    await this.storage.setScheduleAt(at);
    await this.refreshAlarm();
  }

  /** Register the next `sunset`/sunrise transition instant (`null` clears it). */
  async sunsetAt(at: number | null): Promise<void> {
    await this.storage.setSunsetAt(at);
    await this.refreshAlarm();
  }

  /** Register the next external-poll instant (`null` clears it). */
  async extPollAt(at: number | null): Promise<void> {
    await this.storage.setExtPollAt(at);
    await this.refreshAlarm();
  }

  /**
   * Every candidate instant, in a fixed order (schedule, sunset, delay, ext-poll).
   *
   * Only finite instants are offered: a register that was never set (or was
   * cleared) contributes nothing, and a due action contributes its `dueAt` only
   * while it is still `pending` — a claimed or done row is not a reason to wake.
   * Delay candidates are ordered by `dueAt` so the earliest delay is the one the
   * argmin reports.
   */
  async nextWake(): Promise<readonly WakeCandidate[]> {
    const candidates: WakeCandidate[] = [];

    const scheduleAt = await this.storage.getScheduleAt();
    if (isInstant(scheduleAt)) candidates.push({ kind: "schedule", at: scheduleAt });

    const sunsetAt = await this.storage.getSunsetAt();
    if (isInstant(sunsetAt)) candidates.push({ kind: "sunset", at: sunsetAt });

    const due = (await this.storage.listDelays())
      .filter((row) => row.status === DELAY_STATUS_PENDING && Number.isFinite(row.dueAt))
      .sort((a, b) => a.dueAt - b.dueAt);
    if (due.length > 0) {
      candidates.push({ kind: "delay", at: due[0].dueAt });
    }

    const extPollAt = await this.storage.getExtPollAt();
    if (isInstant(extPollAt)) candidates.push({ kind: "ext_poll", at: extPollAt });

    return candidates;
  }

  /**
   * The alarm instant and its provenance: `min(schedule, sunset, delay, ext_poll)`.
   *
   * {@link WakePlan.candidates} is the *argmin* — every candidate tied for the
   * earliest instant — so a caller can assert both that the earliest instant won
   * and which kind produced it. A tie is resolved by arming one alarm at that one
   * instant (the DO has a single slot; the kinds are handled by
   * {@link SchedulerDO.alarm}, which fires whatever is due).
   */
  async nextWakePlan(): Promise<WakePlan> {
    const candidates = await this.nextWake();
    if (candidates.length === 0) return { at: null, candidates: [] };

    let at = candidates[0].at;
    for (const candidate of candidates) {
      if (candidate.at < at) at = candidate.at;
    }
    return { at, candidates: candidates.filter((candidate) => candidate.at === at) };
  }

  /**
   * Re-derive `min(candidates)` and (re)arm the single alarm — the only writer
   * of the alarm slot.
   *
   * Idempotent and unconditional: it sets the alarm to the earliest candidate,
   * or deletes it when nothing remains. Because it is re-run from durable state
   * on {@link SchedulerDO.init}, a restart cannot leave the alarm pointing at a
   * stale instant or unarmed while work is due.
   */
  async refreshAlarm(): Promise<number | null> {
    const plan = await this.nextWakePlan();
    await this.storage.putAlarmAt(plan.at);
    if (plan.at === null) {
      await this.alarmSink.deleteAlarm();
    } else {
      await this.alarmSink.setAlarm(plan.at);
    }
    return plan.at;
  }

  /** The instant the single alarm is currently armed for, or `null`. */
  getAlarm(): Promise<number | null> {
    return this.alarmSink.getAlarm();
  }

  /**
   * One alarm tick — the DO's `alarm()` handler body.
   *
   * The sequence is D3.7's, in order, and the order is the invariant:
   *
   *   1. **Read what is due** (`status='pending' && dueAt <= now`). Firing is
   *      decided from a *durable* row at a `pending` status, never from the
   *      alarm having fired — so the at-least-once alarm cannot, by itself,
   *      cause an execution.
   *   2. **Claim atomically** ({@link SchedulerStorage.claimDelays}). The store
   *      flips `pending → claimed` and returns only what it flipped. From here
   *      the row is no longer claimable by any other tick, restarted instance or
   *      concurrent wake.
   *   3. **Execute each claimed row once**, through the executor seam.
   *   4. **Mark it `done`** on success, `failed` otherwise.
   *   5. **Re-arm for the next candidate** — which, after the claim, is a
   *      `claimed`/`done` row excluded from the candidates, so the DO does not
   *      busy-loop on a row it has already delivered.
   *
   * A tick that claims nothing (a duplicate alarm, an alarm that fired early, a
   * wake with no work) executes nothing and simply re-arms — the guard that
   * makes "at-least-once alarm" and "exactly-once action" compatible.
   *
   * Returns a value, never a throw: a wake is a scheduled event, and its report
   * is more useful to a caller than an exception the runtime would just swallow.
   */
  async alarm(): Promise<AlarmTickReport> {
    const at = this.clock();

    const due = (await this.storage.listDelays())
      .filter(
        (row) =>
          row.status === DELAY_STATUS_PENDING &&
          Number.isFinite(row.dueAt) &&
          row.dueAt <= at,
      )
      .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));

    // Nothing due: still re-derive the alarm from what remains, so the DO is
    // never left disarmed while a register or a future delay is set.
    if (due.length === 0) {
      return { at, executed: [], ...(await this.rearmWithPlan()) };
    }

    // (2) The claim. `claimDelays` is handed ids we believe are pending and
    // returns only the ones it actually moved — the atomic compare-and-set.
    const claimed = await this.storage.claimDelays(due.map((row) => row.id));

    const executed: ExecutionOutcome[] = [];
    for (const row of claimed) {
      const result = await this.executor.execute(row);
      const status: DelayStatus = result.ok ? "done" : "failed";
      await this.storage.setDelayStatus(row.id, status);
      executed.push(
        result.ok
          ? { id: row.id, ruleId: row.ruleId, executed: true }
          : {
              id: row.id,
              ruleId: row.ruleId,
              executed: false,
              reason: "executor_failed",
              ...(result.error === undefined ? {} : { error: result.error }),
            },
      );
    }

    return { at, executed, ...(await this.rearmWithPlan()) };
  }

  /**
   * A convenience handle for a DO that mounts the scheduler: return the handler
   * the `alarm()` method should await. Named so a composition module binds to
   * one thing, and a test can drive ticks without a platform timer.
   */
  handler(): AlarmHandler {
    return () => this.alarm();
  }

  /** Re-derive and arm the alarm, returning the plan's public fields. */
  private async rearmWithPlan(): Promise<{
    armedFor: number | null;
    armedForKind: readonly CandidateKind[];
  }> {
    const plan = await this.nextWakePlan();
    await this.storage.putAlarmAt(plan.at);
    if (plan.at === null) {
      await this.alarmSink.deleteAlarm();
    } else {
      await this.alarmSink.setAlarm(plan.at);
    }
    return { armedFor: plan.at, armedForKind: plan.candidates.map((c) => c.kind) };
  }
}

/** Is `value` a usable instant (a finite number)? `null` and `NaN` are not. */
function isInstant(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// In-memory implementations — honest fakes of each seam, for tests
// ---------------------------------------------------------------------------

/**
 * In-memory {@link AlarmSink} — models `ctx.storage`'s alarm slot.
 *
 * One slot, last-write-wins, `getAlarm` returning `null` until armed: exactly the
 * platform's semantics, so "the earliest candidate was armed" is a fact about
 * this object rather than an assumption. `armed` keeps the *history* of every
 * instant set (and a `null` for every delete), which is what lets a test assert
 * the argmin across the whole schedule instead of only the final state.
 */
export class InMemoryAlarmSink implements AlarmSink {
  private current: number | null = null;
  /** Every instant ever armed, in order (the `setAlarm` trace). */
  readonly armed: number[] = [];

  setAlarm(at: number): Promise<void> {
    this.current = at;
    this.armed.push(at);
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.current = null;
    return Promise.resolve();
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.current);
  }
}

/**
 * In-memory {@link SchedulerStorage}.
 *
 * Models the DO's SQLite closely enough that a test failure here is a failure of
 * the scheduler's logic, not of the fake — and, for the one method that carries
 * the invariant, it models the *contract* rather than a convenient superset:
 * {@link InMemorySchedulerStorage.claimDelays} flips only rows still `pending`
 * and returns only those, so a test that races two claims exercises the real
 * guard instead of a tautology. Reads return copies, so a caller cannot mutate
 * what is stored.
 */
export class InMemorySchedulerStorage implements SchedulerStorage {
  private readonly delays = new Map<string, DelayRow>();
  private scheduleAt: number | null = null;
  private sunsetAt: number | null = null;
  private extPollAt: number | null = null;
  private alarmAt: number | null = null;

  ddl(): string[] {
    return SCHEDULER_DDL.statements();
  }

  putDelay(row: DelayRow): Promise<void> {
    this.delays.set(row.id, { ...row });
    return Promise.resolve();
  }

  getDelay(id: string): Promise<DelayRow | null> {
    const row = this.delays.get(id);
    return Promise.resolve(row === undefined ? null : { ...row });
  }

  listDelays(): Promise<DelayRow[]> {
    const rows = [...this.delays.values()]
      .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
      .map((row) => ({ ...row }));
    return Promise.resolve(rows);
  }

  /**
   * Atomic claim: flip `pending → claimed` for the ids that are still `pending`,
   * returning exactly those. Mirrors `UPDATE automation_delays SET status =
   * 'claimed' WHERE id = ? AND status = 'pending'` per id, in one synchronous
   * pass — so two claims racing here cannot both win a row.
   */
  claimDelays(ids: readonly string[]): Promise<DelayRow[]> {
    const claimed: DelayRow[] = [];
    for (const id of ids) {
      const row = this.delays.get(id);
      if (row === undefined || row.status !== DELAY_STATUS_PENDING) continue;
      const next: DelayRow = { ...row, status: "claimed" };
      this.delays.set(id, next);
      claimed.push({ ...next });
    }
    return Promise.resolve(claimed);
  }

  setDelayStatus(id: string, status: DelayStatus): Promise<void> {
    const row = this.delays.get(id);
    if (row !== undefined) this.delays.set(id, { ...row, status });
    return Promise.resolve();
  }

  getScheduleAt(): Promise<number | null> {
    return Promise.resolve(this.scheduleAt);
  }

  setScheduleAt(at: number | null): Promise<void> {
    this.scheduleAt = at;
    return Promise.resolve();
  }

  getSunsetAt(): Promise<number | null> {
    return Promise.resolve(this.sunsetAt);
  }

  setSunsetAt(at: number | null): Promise<void> {
    this.sunsetAt = at;
    return Promise.resolve();
  }

  getExtPollAt(): Promise<number | null> {
    return Promise.resolve(this.extPollAt);
  }

  setExtPollAt(at: number | null): Promise<void> {
    this.extPollAt = at;
    return Promise.resolve();
  }

  getAlarmAt(): Promise<number | null> {
    return Promise.resolve(this.alarmAt);
  }

  putAlarmAt(at: number | null): Promise<void> {
    this.alarmAt = at;
    return Promise.resolve();
  }
}

/**
 * The default {@link ActionExecutor}: succeed without doing anything.
 *
 * A scheduler with no handler attached is still a correct *scheduler* — it
 * delivers each due action exactly once to *an* executor. The no-op makes that
 * explicit rather than requiring every caller to supply an executor just to arm
 * an alarm, and it keeps "did the scheduler deliver once?" separable from "what
 * does the action do?".
 */
export class NoopExecutor implements ActionExecutor {
  execute(_row: DelayRow): Promise<ActionWriteResult> {
    return Promise.resolve({ ok: true });
  }
}

/**
 * The scheduler's schema, as pure data — a DDL string plus a splitter, in the
 * shape the sibling schemas (`project-schema.ts`, `project-control-schema.ts`)
 * use. Kept in this file because A22 owns exactly one implementation file; the
 * strings are still pure and carry no runtime dependency, so the DO and a test
 * can both depend on them without pulling the platform in.
 *
 * Conventions (mirroring the sibling schemas and D1 migration 0001):
 *   * timestamps -> INTEGER epoch milliseconds (Unix ms, UTC)
 *   * every statement idempotent (`IF NOT EXISTS`), so applying the DDL on each
 *     DO construction is safe: a fresh DO creates the tables, an existing one is
 *     a no-op that keeps its rows.
 */
export const SCHEDULER_DDL = {
  /** The complete DDL for the scheduler's SQLite database. */
  sql: `
-- ---------------------------------------------------------------------------
-- automation_delays — recorded delayed actions and their delivery status.
--   One row per delayed action, keyed by the caller's (engine's) job id, so
--   re-recording an id is an upsert rather than a second delivery. The status
--   column is the single source of truth for exactly-once (D3.7): the claim is
--   UPDATE automation_delays SET status='claimed' WHERE id=? AND status='pending'
--   so a row can be delivered by exactly one caller. due_at is when the action
--   becomes due; the scheduler claims only rows with due_at <= now.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_delays (
  id         TEXT    PRIMARY KEY,
  project_id TEXT    NOT NULL,
  rule_id    TEXT    NOT NULL,
  due_at     INTEGER NOT NULL,
  payload    TEXT,
  status     TEXT    NOT NULL DEFAULT 'pending'
);

-- The wake path: pending rows that are due, earliest first.
CREATE INDEX IF NOT EXISTS idx_automation_delays_pending_due
  ON automation_delays (status, due_at);

-- scheduler_alarm — one row: the instant the single alarm is armed for.
--   Persisted so a restart re-derives the same alarm from the same due instants
--   (ST-U2) instead of relying on in-memory state an eviction would drop.
CREATE TABLE IF NOT EXISTS scheduler_alarm (
  id       TEXT    PRIMARY KEY,
  alarm_at INTEGER
);

-- The three non-delay registers the single alarm arbitrates between.
--   Each is one row keyed by its kind, holding the next due instant (NULL when
--   unset), so registering one cannot disturb another and all flow through the
--   single min() that arms the one alarm slot.
CREATE TABLE IF NOT EXISTS scheduler_register (
  kind    TEXT    PRIMARY KEY,
  due_at  INTEGER
);
`,
  /** Names of the tables this schema owns, for assertions and diagnostics. */
  tables: ["automation_delays", "scheduler_alarm", "scheduler_register"] as const,
  /**
   * The DDL as an ordered list of statements, ready to hand to
   * `ctx.storage.sql.exec(...)` one at a time.
   *
   * Splitting is deliberately naive — the DDL is ours and contains no terminator
   * inside a comment — so a `;` on its own line is always a statement boundary.
   * The same approach as the sibling schemas.
   */
  statements(): string[] {
    return SCHEDULER_DDL.sql
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)
      .map((statement) => `${statement};`);
  },
} as const;
