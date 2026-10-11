/**
 * auto-migrate — idempotent D1 schema migration runner with a single-writer
 * guard.
 *
 * Design goals
 * ------------
 *   1. Pure & testable: this module has **no** dependency on Cloudflare D1
 *      itself. It talks to a tiny `SqlStatementRunner` seam (below) so the
 *      concurrency contract can be exercised against an in-memory fake.
 *   2. Single writer: applying a migration is claimed *atomically* by a
 *      conditional `INSERT`. Under concurrency exactly one caller flips the
 *      `schema_version` row to "migrating"; every other caller observes the
 *      write and loses the race without ever touching the data tables.
 *   3. Idempotent: a no-op run reads the already-current `schema_version` and
 *      applies nothing, returning `{ applied: false, version }` without error.
 *
 * SQLite / D1 semantics we rely on
 * --------------------------------
 *   * `INSERT OR IGNORE` inserts nothing when a uniqueness constraint is
 *     violated and reports zero changed rows (`meta.changes === 0`).
 *   * The *unconditional* `INSERT OR IGNORE` of the guard row is that atomic
 *     test-and-set: SQLite serializes writes, so of N concurrent inserts
 *     exactly one is the winner and the rest are ignored.
 *   * A `schema_version` row in the "migrating" state (`version < 0`) is a
 *     tombstone that other callers spin on; the winner clears it once the
 *     target version is committed.
 *
 * The statements emitted are written to run on a real D1 binding; the module
 * is nonetheless pure (no I/O of its own) and therefore trivially unit-tested.
 */

import { defaultClock, type Clock } from "../lib/clock";

/**
 * Minimal seam onto a SQL engine (Cloudflare D1 or a test fake).
 *
 * Deliberately smaller than `D1Database`: the migration guard only needs to
 * execute individual statements and read back the changed-row count. A real D1
 * binding satisfies this by wrapping `db.prepare(sql).bind(...params).run()`,
 * e.g.:
 *
 * ```ts
 * const runner: SqlStatementRunner = {
 *   async execute(sql, params = []) {
 *     const r = await db.prepare(sql).bind(...params).run();
 *     return { results: r.results ?? [], changes: r.meta?.changes ?? 0 };
 *   },
 * };
 * ```
 */
export interface SqlStatementRunner {
  /**
   * Execute a single SQL statement with positional `?` bindings.
   *
   * @returns `changes` — the number of rows inserted/updated/deleted by the
   *          statement (`0` for DDL and for `INSERT OR IGNORE` that was
   *          ignored). `results` — any rows returned (empty for non-`SELECT`).
   */
  execute(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ results?: readonly unknown[]; changes?: number }>;
}

/** One migration: a stable `version` number and its ordered statements. */
export interface Migration {
  /** Monotonic, 1-based version. The runner applies everything above the current one. */
  readonly version: number;
  /** Statements to run in order (already split, comments stripped). */
  readonly statements: readonly string[];
}

/** Aggregated result of a single `applyMigrations` invocation. */
export interface MigrateResult {
  /** `true` for the one caller that actually ran a pending migration. */
  readonly applied: boolean;
  /** `schema_version.version` as observed when the call finished. */
  readonly version: number;
  /** Versions this call actually applied (empty for no-op / loser runs). */
  readonly appliedVersions: readonly number[];
}

/** How the guard marks a row that is currently being written by the winner. */
const MIGRATING = -1;

/** Guard/spin-loop tuning for the racy "migrating" state. */
const MAX_INTERLEAVES = 10_000;

/** Default async yield (a macrotask turn) used while spinning on the winner. */
const defaultYield = (): Promise<void> =>
  // `Promise.withResolvers` would read better but the repo targets lib ES2022.
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Read the current schema version.
 *
 * @returns the single guard row's `version`, or `0` (empty schema) when the
 *          `schema_version` table does not exist yet.
 */
export async function readSchemaVersion(db: SqlStatementRunner): Promise<number> {
  const { results } = await db.execute(
    "SELECT version FROM schema_version WHERE id = 1",
  );
  const row = results?.[0] as { version?: unknown } | undefined;
  const version = row?.version;
  return typeof version === "number" && Number.isFinite(version) ? version : 0;
}

/**
 * DDL that materializes the single-row guard table if it is missing. The seed
 * row is *not* inserted here — creating it is the claim (see below), and that
 * write must be observable (`changes`) and atomic.
 */
const ENSURE_SCHEMA_VERSION = [
  "CREATE TABLE IF NOT EXISTS schema_version (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1), " +
    "version INTEGER NOT NULL, " +
    "applied_at INTEGER NOT NULL)",
] as const;

/**
 * Compare migrations by version (ascending) and reject duplicates early.
 * Exported so callers can validate a manifest before running it.
 */
export function sortMigrations(migrations: readonly Migration[]): Migration[] {
  const seen = new Set<number>();
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of sorted) {
    if (seen.has(m.version)) {
      throw new Error(`duplicate migration version: ${m.version}`);
    }
    seen.add(m.version);
  }
  return sorted;
}

/**
 * Apply every pending migration exactly once, guarded for concurrent writers.
 *
 * Concurrency contract: N concurrent calls over the *same* database apply each
 * pending migration **exactly once** in total. The single winner flips
 * `schema_version` to `MIGRATING`, runs the pending statements in order and
 * commits the target version. Losers observe the winner, wait for it to
 * finish, then report the committed version as an idempotent no-op.
 *
 * @param db         the SQL seam (real D1 or a fake)
 * @param migrations the full manifest (any order; sorted internally)
 * @param now        clock seam for `applied_at` (defaults to `Date.now`)
 * @param yieldFn    async yield used while waiting on the winner (test seam)
 */
export async function applyMigrations(
  db: SqlStatementRunner,
  migrations: readonly Migration[],
  now: Clock = defaultClock,
  yieldFn: () => Promise<void> = defaultYield,
): Promise<MigrateResult> {
  const ordered = sortMigrations(migrations);
  const targetVersion = ordered.length === 0
    ? 0
    : ordered[ordered.length - 1].version;

  // 1. Ensure the guard table exists. `CREATE TABLE IF NOT EXISTS` is
  //    idempotent and establishes the unique constraint the claim relies on.
  await db.execute(ENSURE_SCHEMA_VERSION[0]);

  // 2. Claim the single-writer slot with the *observable* atomic insert. D1
  //    serializes writes, so of N concurrent `INSERT OR IGNORE`s exactly one
  //    reports `changes === 1` — that caller is the winner. The losers see
  //    `changes === 0` (the guard row already exists) and never touch the
  //    data plane.
  const claim = await db.execute(
    "INSERT OR IGNORE INTO schema_version (id, version, applied_at) " +
      "VALUES (1, ?, ?)",
    [0, now()],
  );
  const won = (claim.changes ?? 0) > 0;

  if (!won) return raceOrReconcile(db, yieldFn);

  // 3. We are the single writer. On success `version` is 0 here; on an
  //    idempotent re-run the row already exists (so we never reach this far),
  //    but guard with a compare-and-set anyway. If the row is unexpectedly
  //    non-zero, someone else owns the run.
  const mark = await db.execute(
    "UPDATE schema_version SET version = ?, applied_at = ? " +
      "WHERE id = 1 AND version = 0",
    [MIGRATING, now()],
  );

  if ((mark.changes ?? 0) === 0) {
    return { applied: false, version: await readSchemaVersion(db), appliedVersions: [] };
  }

  // 4. Run pending migrations in order and advance the guard row after each
  //    one, so a crash mid-run resumes correctly and never re-applies.
  const appliedVersions: number[] = [];
  for (const migration of ordered) {
    if (migration.version <= 0) {
      throw new Error(`invalid migration version: ${migration.version}`);
    }
    for (const statement of migration.statements) {
      await db.execute(statement);
    }
    await db.execute(
      "UPDATE schema_version SET version = ?, applied_at = ? WHERE id = 1",
      [migration.version, now()],
    );
    appliedVersions.push(migration.version);
  }

  // Nothing pending: clear the "migrating" tombstone back to a valid version
  // so the guard row is never left in the transient -1 state.
  if (appliedVersions.length === 0) {
    await db.execute(
      "UPDATE schema_version SET version = ?, applied_at = ? WHERE id = 1",
      [0, now()],
    );
  }

  return { applied: appliedVersions.length > 0, version: targetVersion, appliedVersions };
}

/**
 * Loser path. The losing claim either joined *after* the winner committed
 * (plain no-op) or joined while the winner was mid-flight (spin until the
 * `MIGRATING` tombstone is replaced by the committed version).
 */
async function raceOrReconcile(
  db: SqlStatementRunner,
  yieldFn: () => Promise<void>,
): Promise<MigrateResult> {
  let version = await readSchemaVersion(db);

  for (let i = 0; version === MIGRATING && i < MAX_INTERLEAVES; i += 1) {
    await yieldFn();
    version = await readSchemaVersion(db);
  }

  if (version === MIGRATING) {
    throw new Error(
      "migration lock is held by another writer that never finished " +
        "(stale schema_version = -1)",
    );
  }

  // Another writer owns the run; we applied nothing. The committed version is
  // whatever the winner left behind (or the target if it finished first).
  return { applied: false, version, appliedVersions: [] };
}
