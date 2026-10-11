/**
 * ProjectControl — the control plane for a project's Durable Object.
 *
 * The project projection owns what devices *report* ({@link ../project-do});
 * this module owns what a project *asks of* them. Two independent concerns live
 * here because they share one lifetime (the project DO) and one clock:
 *
 * ## 1. Command delivery
 *
 * A command is a `(variable, value)` pair queued for a device with a deadline.
 * The lifecycle is exactly three states, and every transition is owned here:
 *
 *   - **pending** — {@link ProjectControl.enqueueControl} writes the row with
 *     `status = 'pending'`. Re-enqueueing an id upserts it, so a redelivered
 *     enqueue request is not a second command.
 *   - **acked** — {@link ProjectControl.ackControls} flips the row. It is
 *     idempotent: acknowledging an id twice (or an id that no longer exists, or
 *     an already-expired row) is a no-op, never an error. A re-acknowledged id
 *     is *not* resurrected — retrying on the device side cannot re-open a
 *     command it has already answered.
 *   - **expired** — {@link ProjectControl.pendingControls} drops a row whose
 *     `now > created_at + ttl_ms` to `status = 'expired'` before returning, so
 *     a command past its TTL is never delivered (INV-T6 / ST-T6) and stays
 *     expired on every later call.
 *
 * So `pendingControls()` is the whole read contract: only pending rows, never
 * expired, never acked. Because expiry is a persisted status rather than a
 * filter applied at read time, a caller can tell "never seen" from "expired" —
 * which is the audit trail the spec asks for.
 *
 * ## 2. OTA budget
 *
 * {@link ProjectControl.checkAndConsumeOtaQuota} answers "may this device spend
 * one more OTA right now?" against a *fixed one-hour window*: the first call
 * inside an hour opens the window at the current clock instant and records one
 * unit; each subsequent allowed call increments usage; the call that would
 * exceed `limitPerHour` is denied **without** consuming. When the clock rolls
 * past `window_start + 1h` the row is reset to a fresh window, so the budget
 * replenishes exactly once per hour.
 *
 * ## Seams
 *
 * Everything non-deterministic is injected: a {@link ProjectControlStorage}
 * seam (in-memory for tests, `ctx.storage.sql` in production) and a
 * {@link Clock}. No ambient `Date.now()` is read unless the caller omits the
 * clock, so a test advances time by moving a value it owns.
 */

import {
  CONTROL_STATUS_PENDING,
  projectControlStatements,
  type ControlStatus,
} from "./project-control-schema";
import {
  OTA_QUOTA_WINDOW_MS,
  decideOtaQuota,
  type OtaQuotaRow,
} from "../quota/ota-quota";
import type { Clock } from "../lib/clock";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The default command lifetime: 24 hours, in milliseconds. */
export const DEFAULT_CONTROL_TTL_MS = 24 * 60 * 60 * 1000;

/** The width of one OTA quota window: one hour, in milliseconds. */
export const OTA_WINDOW_MS = OTA_QUOTA_WINDOW_MS;

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** One queued command, in the shape both stores persist. */
export interface PendingControl {
  /** Caller-supplied identity; re-enqueueing it upserts the row. */
  readonly id: string;
  readonly device: string;
  readonly variable: string;
  /** The value to apply, stored opaquely (whatever string the caller sent). */
  readonly value: string | null;
  /** Lifetime in milliseconds, measured from {@link createdAt}. */
  readonly ttlMs: number;
  /** When the command was enqueued (epoch ms). */
  readonly createdAt: number;
  readonly status: ControlStatus;
}

/** One device's OTA consumption inside the window it is currently counting. */
export interface OtaQuota {
  readonly device: string;
  /** Epoch ms the current hour window opened. */
  readonly windowStart: number;
  /** Units consumed inside that window. */
  readonly used: number;
}

/**
 * Persistence seam for project control.
 *
 * Small on purpose: upsert a command, read it back, flip a row's status, and do
 * the two things the quota needs. All promise-based, with no SQL type in sight.
 * {@link InMemoryProjectControlStorage} is an honest implementation of exactly
 * these semantics; the production class adapts `ctx.storage.sql` onto them.
 */
export interface ProjectControlStorage {
  /** The full DDL, as statements, for the adapter to execute on construction. */
  ddl(): string[];
  /** Insert or replace one command, keyed by its id. */
  putControl(row: PendingControl): Promise<void>;
  /** The row for one id, or `null` when it has never been seen. */
  getControl(id: string): Promise<PendingControl | null>;
  /**
   * Every command for a device (or every command, when `device` is omitted),
   * oldest first. Statuses are *not* filtered here — the caller decides, so
   * expiry can be observed and persisted.
   */
  listControls(device?: string): Promise<PendingControl[]>;
  /** Set one row's status. A no-op when the id is unknown. */
  setControlStatus(id: string, status: ControlStatus): Promise<void>;
  /** One device's OTA quota row, or `null` when it has no window open. */
  getOtaQuota(device: string): Promise<OtaQuota | null>;
  /** Upsert one device's OTA quota row. */
  putOtaQuota(quota: OtaQuota): Promise<void>;
}

/** Construction options for {@link ProjectControl}. */
export interface ProjectControlOptions {
  readonly storage: ProjectControlStorage;
  /** Clock returning Unix epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: Clock;
}

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

/** What {@link ProjectControl.enqueueControl} takes in. */
export interface EnqueueControlInput {
  readonly id: string;
  readonly device: string;
  readonly variable: string;
  /** The value to apply; omitted or `null` means "no payload". */
  readonly value?: string | null;
  /** Lifetime in milliseconds; defaults to {@link DEFAULT_CONTROL_TTL_MS}. */
  readonly ttlMs?: number;
}

/** Outcome of a {@link ProjectControl.checkAndConsumeOtaQuota} call. */
export type OtaQuotaResult =
  | {
      readonly allowed: true;
      /** Units consumed in the current window, including this one. */
      readonly used: number;
      readonly limitPerHour: number;
      readonly windowStart: number;
    }
  | {
      readonly allowed: false;
      readonly reason: "quota_exceeded";
      readonly used: number;
      readonly limitPerHour: number;
      readonly windowStart: number;
    };

// ---------------------------------------------------------------------------
// ProjectControl
// ---------------------------------------------------------------------------

/**
 * The project control plane. Construct with {@link ProjectControlOptions}; call
 * {@link ProjectControl.init} once to apply the DDL, then enqueue, poll,
 * acknowledge and spend.
 */
export class ProjectControl {
  private readonly storage: ProjectControlStorage;
  private readonly clock: Clock;

  constructor(options: ProjectControlOptions) {
    this.storage = options.storage;
    this.clock = options.now ?? (() => Date.now());
  }

  /** Apply the control DDL. Idempotent: every statement is `IF NOT EXISTS`. */
  init(): Promise<void> {
    this.storage.ddl();
    return Promise.resolve();
  }

  /**
   * Queue one command for a device.
   *
   * The row is written pending, with `ttlMs` (default
   * {@link DEFAULT_CONTROL_TTL_MS}) and `createdAt` taken from the clock, so
   * the deadline is knowable and the lifetime is reproducible. The id is the
   * primary key, so enqueueing an id that already exists replaces it — a
   * retried enqueue must not deliver the same command twice.
   *
   * Returns the stored row, exactly as a later `pendingControls` would.
   */
  async enqueueControl(input: EnqueueControlInput): Promise<PendingControl> {
    const row: PendingControl = {
      id: input.id,
      device: input.device,
      variable: input.variable,
      value: input.value ?? null,
      ttlMs: input.ttlMs ?? DEFAULT_CONTROL_TTL_MS,
      createdAt: this.clock(),
      status: CONTROL_STATUS_PENDING,
    };
    await this.storage.putControl(row);
    return { ...row };
  }

  /**
   * The commands a device should act on right now.
   *
   *   - `pendingControls()`        → every device's pending commands.
   *   - `pendingControls(device)`  → one device's pending commands.
   *
   * Only rows that are **not acked** and **not expired** are returned. Expiry
   * is enforced here: any pending row with `now > createdAt + ttlMs` is first
   * persisted as `expired` and then dropped from the result, so a stale command
   * is never delivered — not on this call, and not on a later one.
   *
   * Rows are returned in enqueue order (oldest `createdAt` first, ties broken
   * by id), which is the order a device should apply them in.
   */
  async pendingControls(device?: string): Promise<PendingControl[]> {
    const now = this.clock();
    const rows = await this.storage.listControls(device);

    const out: PendingControl[] = [];
    for (const row of rows) {
      if (row.status === "acked") continue;
      // Strictly past the deadline: `now === createdAt + ttlMs` is still live.
      if (now > row.createdAt + row.ttlMs) {
        if (row.status !== "expired") {
          await this.storage.setControlStatus(row.id, "expired");
        }
        // Dropped: an expired command is never returned.
        continue;
      }
      if (row.status === "expired") continue;
      out.push({ ...row });
    }

    return out.sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  }

  /**
   * Acknowledge commands by id.
   *
   * Idempotent by construction: acknowledging a command that is already acked,
   * one that has expired, or one whose id was never enqueued is a no-op rather
   * than an error — a device that retries its acknowledgement must not be
   * punished for it. An expired row is *not* resurrected: the terminal states
   * are terminal.
   *
   * Returns the ids it actually transitioned, for diagnostics.
   */
  async ackControls(ids: readonly string[]): Promise<string[]> {
    const acked: string[] = [];
    for (const id of ids) {
      const row = await this.storage.getControl(id);
      if (row === null) continue;
      if (row.status !== CONTROL_STATUS_PENDING) continue;
      await this.storage.setControlStatus(id, "acked");
      acked.push(id);
    }
    return acked;
  }

  /**
   * Check whether a device may spend one OTA, and consume it if so.
   *
   * A fixed one-hour window: the first call in an hour opens the window at the
   * current clock instant and consumes one unit; each further allowed call
   * increments usage. The call that would take the window past `limitPerHour`
   * is denied and consumes nothing, so a denied check does not burn budget.
   * Once the clock passes `windowStart + 1h` the row is reset and the budget is
   * fresh — the reset is driven purely by the injected clock.
   *
   * Returns a value, never a throw, so the caller maps it onto its transport.
   */
  async checkAndConsumeOtaQuota(
    device: string,
    limitPerHour: number,
  ): Promise<OtaQuotaResult> {
    const now = this.clock();
    const stored = await this.storage.getOtaQuota(device);

    // The ONE budget algorithm (D2.8), shared with the OTA image route so the
    // two can never disagree on a window boundary or a limit. This method is
    // now only the persistence adapter: it loads the row, asks the pure core,
    // and writes the row the decision returned.
    const decision = decideOtaQuota(
      stored === null ? null : { key: device, windowStart: stored.windowStart, used: stored.used },
      now,
      limitPerHour,
      device,
    );
    const row: OtaQuotaRow = decision.row;

    if (!decision.allowed) {
      // Persist unchanged usage so a denied check does not burn budget, and the
      // window stays pinned to where the budget was spent.
      await this.storage.putOtaQuota({ device: row.key, windowStart: row.windowStart, used: row.used });
      return {
        allowed: false,
        reason: "quota_exceeded",
        used: decision.used,
        limitPerHour: decision.limitPerHour,
        windowStart: decision.windowStart,
      };
    }

    await this.storage.putOtaQuota({ device: row.key, windowStart: row.windowStart, used: row.used });
    return {
      allowed: true,
      used: decision.used,
      limitPerHour: decision.limitPerHour,
      windowStart: decision.windowStart,
    };
  }
}

// ---------------------------------------------------------------------------
// In-memory storage — an honest implementation of ProjectControlStorage
// ---------------------------------------------------------------------------

/**
 * In-memory {@link ProjectControlStorage}.
 *
 * Models the DO's SQLite closely enough that a test failure here is a failure
 * of the control logic, not of the fake: rows keyed by id, upsert on write,
 * device-scoped reads in enqueue order, and reads that return copies so a
 * caller cannot mutate what is stored.
 */
export class InMemoryProjectControlStorage implements ProjectControlStorage {
  private readonly controls = new Map<string, PendingControl>();
  private readonly quotas = new Map<string, OtaQuota>();

  /** Insert or replace one command, keyed by its id (the PRIMARY KEY). */
  putControl(row: PendingControl): Promise<void> {
    this.controls.set(row.id, { ...row });
    return Promise.resolve();
  }

  /** The row for one id, or `null` when it has never been seen. */
  getControl(id: string): Promise<PendingControl | null> {
    const row = this.controls.get(id);
    return Promise.resolve(row === undefined ? null : { ...row });
  }

  /** Commands for a device (or all), oldest first by `createdAt` then id. */
  listControls(device?: string): Promise<PendingControl[]> {
    const rows = [...this.controls.values()]
      .filter((row) => device === undefined || row.device === device)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((row) => ({ ...row }));
    return Promise.resolve(rows);
  }

  /** Set one row's status; a no-op when the id is unknown. */
  setControlStatus(id: string, status: ControlStatus): Promise<void> {
    const row = this.controls.get(id);
    if (row !== undefined) this.controls.set(id, { ...row, status });
    return Promise.resolve();
  }

  /** One device's OTA quota row, or `null` when it has no window open. */
  getOtaQuota(device: string): Promise<OtaQuota | null> {
    const quota = this.quotas.get(device);
    return Promise.resolve(quota === undefined ? null : { ...quota });
  }

  /** Upsert one device's OTA quota row. */
  putOtaQuota(quota: OtaQuota): Promise<void> {
    this.quotas.set(quota.device, { ...quota });
    return Promise.resolve();
  }

  /** The DDL as statements; execution is the SQL adapter's job. */
  ddl(): string[] {
    return projectControlStatements();
  }
}
