/**
 * ProjectDO — the read projection for one project's telemetry.
 *
 * Where a shard (A09) owns the raw sample history for a slice of the device
 * keyspace, a project's DO owns the *current picture*: the single winning
 * reading per `(device, variable)` stream, in a shape a dashboard can read in
 * one indexed lookup.
 *
 * ## Seams
 *
 * A plain class with no Cloudflare types in its signature:
 *
 *   - **storage** — a {@link ProjectStorage} seam, modelling the projection as
 *     upserts and point reads. Production passes the DO's embedded SQLite;
 *     tests pass {@link InMemoryProjectStorage}. Promise-based, so both
 *     implementations satisfy it identically.
 *   - **now** — a `Clock` returning Unix epoch milliseconds. Tests pin it, so
 *     the `updatedAt` bookkeeping stamp is exactly knowable and no
 *     `Date.now()` leaks into a test.
 *
 * ## Ordering (INV-T2 / D4.4)
 *
 * A push updates a stream only if it is at least as new as what is stored:
 *
 *   - `ts > stored ts`              → **accept**; the newer reading wins.
 *   - `ts < stored ts`              → **ignore** (stale). The stored row is
 *     untouched, so a late sample cannot roll a stream backwards.
 *   - `ts == stored ts`             → **LWW tie-break by `seq`** (D4.4): accept
 *     iff `seq >= stored seq`. A higher seq is a later write at the same
 *     instant and wins; a lower or equal seq is a replay/rewind and is ignored.
 *
 * A stream with no stored row always accepts: there is nothing to lose to.
 *
 * ## Push path
 *
 * {@link ProjectDO.applyPush} is the core projection step. {@link ProjectDO.receivePush}
 * is the receipt a shard→project push path calls: it accepts the same fields
 * and returns a typed outcome, so the caller learns whether the push landed
 * and why not — while a malformed push (missing device/variable, non-finite
 * numbers) is reported as `invalid` rather than thrown.
 */

import { PROJECT_DDL, projectStatements } from "./project-schema";
import type { Clock } from "../lib/clock";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** One telemetry push, as the projection stores it. */
export interface Push {
  readonly device: string;
  readonly variable: string;
  /** `null` is a valid reading, so it is not conflated with "absent". */
  readonly value: number | null;
  readonly ts: number;
  readonly seq: number;
}

/** One projected stream, the shape {@link ProjectDO.getState} returns. */
export interface StateRow {
  readonly device: string;
  readonly variable: string;
  readonly value: number | null;
  readonly ts: number;
  readonly seq: number;
}

/**
 * Persistence seam for a project.
 *
 * Small on purpose: upsert one projected row, read rows back, and list them for
 * priming. `InMemoryProjectStorage` is an honest implementation of exactly
 * these semantics; the production class adapts `ctx.storage.sql` onto them.
 */
export interface ProjectStorage {
  /** The full DDL, as statements, for the adapter to execute on construction. */
  ddl(): string[];
  /** Upsert the winning row for one `(device, variable)` stream. */
  putState(row: StateRow): Promise<void>;
  /** The stored row for one stream, or `null` when it has never been seen. */
  getState(device: string, variable: string): Promise<StateRow | null>;
  /** Every projected row, for priming the in-memory mirror on `init`. */
  listState(): Promise<StateRow[]>;
}

/** Construction options for {@link ProjectDO}. */
export interface ProjectDOOptions {
  readonly storage: ProjectStorage;
  /** Clock returning Unix epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: Clock;
}

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

/** Outcome of an {@link ProjectDO.applyPush} / {@link ProjectDO.receivePush}. */
export type PushResult =
  | { readonly accepted: true; readonly reason: "newer" | "tie_break" }
  | {
      readonly accepted: false;
      readonly reason: "stale" | "tie_lost" | "invalid";
      /** The stored ts the push failed to beat, when one exists. */
      readonly storedTs?: number;
      readonly storedSeq?: number;
    };

// ---------------------------------------------------------------------------
// ProjectDO
// ---------------------------------------------------------------------------

/** Join a device and variable into a single map key (both may be anything). */
function stateKey(device: string, variable: string): string {
  return `${device}\u0000${variable}`;
}

/**
 * The project projection. Construct with {@link ProjectDOOptions}; call
 * {@link ProjectDO.init} once to apply the DDL, then {@link ProjectDO.applyPush}
 * (or {@link ProjectDO.receivePush}) as pushes arrive.
 */
export class ProjectDO {
  private readonly storage: ProjectStorage;
  private readonly clock: Clock;
  /** Projected rows, keyed by `device \0 variable`, mirrored into storage. */
  private readonly rows = new Map<string, StateRow>();

  constructor(options: ProjectDOOptions) {
    this.storage = options.storage;
    this.clock = options.now ?? (() => Date.now());
  }

  /**
   * Apply the project DDL and prime the in-memory mirror from storage.
   *
   * Idempotent: the DDL uses `IF NOT EXISTS`, and re-reading the projection of
   * an already-populated DO rebuilds exactly the same map.
   */
  async init(): Promise<void> {
    this.storage.ddl();
    for (const row of await this.storage.listState()) {
      this.rows.set(stateKey(row.device, row.variable), row);
    }
  }

  /**
   * Project one push into `latest_state`.
   *
   * Applies the ordering gate in the class docblock and returns a
   * {@link PushResult} value — never a throw — so the caller maps it onto
   * whatever transport it is using.
   */
  applyPush(push: Push): Promise<PushResult> {
    return this.project(push);
  }

  /**
   * Receipt for the shard→project push path.
   *
   * The ordering rules are identical to {@link ProjectDO.applyPush} — the two
   * differ only in framing, so they share one projection core. `receivePush`
   * is the entry a push sender calls, and it is deliberately *loose*: a message
   * off the wire may be malformed, so a push that does not name its stream or
   * carry finite ordering keys is reported as `invalid` rather than thrown.
   */
  receivePush(input: {
    device: string;
    variable: string;
    value: number | null;
    ts: number;
    seq: number;
  }): Promise<PushResult> {
    return this.project(input);
  }

  /**
   * The shared projection core: validate, then apply the ordering gate (INV-T2
   * / D4.4) and upsert the winner.
   */
  private async project(push: Push): Promise<PushResult> {
    const { device, variable, value, ts, seq } = push;

    // A push must name its stream and carry finite ordering keys; anything
    // else is a malformed receipt, not an ordering decision.
    if (
      typeof device !== "string" ||
      device.length === 0 ||
      typeof variable !== "string" ||
      variable.length === 0 ||
      !Number.isFinite(ts) ||
      !Number.isFinite(seq) ||
      (value !== null && !Number.isFinite(value))
    ) {
      return { accepted: false, reason: "invalid" };
    }

    const key = stateKey(device, variable);
    const stored = this.rows.get(key) ?? null;

    // --- Ordering gate (INV-T2 / D4.4) -----------------------------------
    if (stored !== null) {
      if (ts < stored.ts) {
        // Strictly stale: ignore, leaving the stored row untouched.
        return {
          accepted: false,
          reason: "stale",
          storedTs: stored.ts,
          storedSeq: stored.seq,
        };
      }
      if (ts === stored.ts && seq < stored.seq) {
        // Equal instant, older write: an LWW tie the stored row wins.
        return {
          accepted: false,
          reason: "tie_lost",
          storedTs: stored.ts,
          storedSeq: stored.seq,
        };
      }
    }

    const next: StateRow = { device, variable, value, ts, seq };
    await this.storage.putState(next);
    this.rows.set(key, next);

    return {
      accepted: true,
      reason: stored !== null && ts === stored.ts ? "tie_break" : "newer",
    };
  }

  /**
   * The projection.
   *
   *   - `getState()`                  → every stream in the project.
   *   - `getState(device)`            → every stream of one device.
   *   - `getState(device, variable)`  → exactly that stream (empty if unseen).
   *
   * Rows are returned newest `ts` first, then by `device`/`variable`, so the
   * order is stable and readable rather than map-insertion dependent.
   */
  getState(device?: string, variable?: string): StateRow[] {
    const out: StateRow[] = [];
    for (const row of this.rows.values()) {
      if (device !== undefined && row.device !== device) continue;
      if (variable !== undefined && row.variable !== variable) continue;
      out.push(row);
    }
    return out.sort(
      (a, b) =>
        b.ts - a.ts ||
        a.device.localeCompare(b.device) ||
        a.variable.localeCompare(b.variable),
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory storage — an honest implementation of ProjectStorage, for tests
// ---------------------------------------------------------------------------

/**
 * In-memory {@link ProjectStorage}.
 *
 * Models the DO's SQLite closely enough that a test failure here is a failure
 * of the projection's logic, not of the fake: one row per stream, upsert by
 * `(device, variable)`, and reads that return copies so a caller cannot mutate
 * what is stored.
 */
export class InMemoryProjectStorage implements ProjectStorage {
  private readonly rows = new Map<string, StateRow>();

  /** Upsert the winning row for one stream (the PRIMARY KEY is the key). */
  putState(row: StateRow): Promise<void> {
    this.rows.set(stateKey(row.device, row.variable), { ...row });
    return Promise.resolve();
  }

  /** The stored row for one stream, or `null` when it has never been seen. */
  getState(device: string, variable: string): Promise<StateRow | null> {
    const row = this.rows.get(stateKey(device, variable));
    return Promise.resolve(row === undefined ? null : { ...row });
  }

  /** Every projected row (copies, in insertion order). */
  listState(): Promise<StateRow[]> {
    return Promise.resolve([...this.rows.values()].map((row) => ({ ...row })));
  }

  /** The DDL as statements; execution is the SQL adapter's job. */
  ddl(): string[] {
    return projectStatements();
  }
}

/** Re-exported so a consumer can assert on the DDL without a second import. */
export { PROJECT_DDL };
