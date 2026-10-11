import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  readSchemaVersion,
  sortMigrations,
  type Migration,
  type SqlStatementRunner,
} from "../../worker/src/platform/db/auto-migrate";

/**
 * Spec tests for the auto-migrate single-writer guard.
 *
 * The production module talks to the tiny `SqlStatementRunner` seam rather than
 * a real D1 binding, which lets these tests drive a small in-memory fake that
 * models just enough SQLite semantics to make the concurrency contract real:
 *
 *   * a single-row `schema_version` guard table,
 *   * `CREATE TABLE IF NOT EXISTS`,
 *   * `INSERT OR IGNORE` that is *atomic* (the whole statement runs inside one
 *     mutual-exclusion section, so of N concurrent inserts exactly one wins),
 *   * `UPDATE ... WHERE version = ?` reporting the changed-row count,
 *   * `SELECT version FROM schema_version WHERE id = 1`.
 *
 * Every `execute` awaits a turn before entering its critical section, so N
 * `Promise.all`ed `applyMigrations` calls genuinely interleave instead of
 * running one-after-another.
 */

// ---------------------------------------------------------------------------
// In-memory fake of the SQL seam (SQLite-flavoured, single-row guard only).
// ---------------------------------------------------------------------------

/**
 * A promise that resolves after `hops` microtask turns. Awaiting this inside
 * `execute` (both before and inside the critical section) guarantees callers
 * observe real interleaving rather than accidentally running sequentially.
 */
async function turn(hops = 1): Promise<void> {
  for (let i = 0; i < hops; i += 1) {
    // `Promise.withResolvers` would read better, but the repo's lib is ES2022.
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
  }
}

/** Result shape returned by `SqlStatementRunner.execute`. */
export interface ExecResult {
  results?: readonly unknown[];
  changes?: number;
}

/**
 * Simulates the slice of SQLite the migration guard depends on. Statements are
 * matched by shape (the runner only ever emits a handful of fixed forms) and
 * every execution is recorded so tests can assert exactly-once behaviour.
 */
class FakeD1 implements SqlStatementRunner {
  /** Whether the guard table exists (true only after its `CREATE TABLE`). */
  #versionTableCreated = false;

  /** The guard row, or `null` before the first successful insert. */
  #schemaVersion: { id: 1; version: number; applied_at: number } | null = null;

  /** Statements applied to the (fake) data plane, in order. */
  readonly appliedStatements: string[] = [];

  /** Serializes "write" statements so `INSERT OR IGNORE` is atomic. */
  #writeLock: Promise<unknown> = Promise.resolve();

  /** Run `fn` with exclusive access to the fake's mutable state. */
  #withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.#writeLock.then(() => fn());
    // Keep the chain alive even if this operation rejects (it should not).
    this.#writeLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The current guard row, or a synthetic version-0 row before creation. */
  #row(): { id: 1; version: number; applied_at: number } {
    return this.#schemaVersion ?? { id: 1, version: 0, applied_at: 0 };
  }

  execute(sql: string, params: readonly unknown[] = []): Promise<ExecResult> {
    return this.#run(sql, params);
  }

  async #run(sql: string, params: readonly unknown[]): Promise<ExecResult> {
    const text = sql.trim();

    // A pre-critical-section hop, so concurrent callers interleave here.
    await turn();

    // Guard-table DDL: creates the *table* exactly once. Note this does NOT
    // create the guard row — only the `INSERT` does, so the insert's changed
    // count is the real, observable claim signal.
    if (/^CREATE TABLE IF NOT EXISTS schema_version/i.test(text)) {
      return this.#withLock(() => {
        this.#versionTableCreated = true;
        return { results: [], changes: 1 };
      });
    }

    // Read the guard row.
    if (/^SELECT version FROM schema_version/i.test(text)) {
      return this.#withLock(() => {
        if (!this.#versionTableCreated || this.#schemaVersion === null) {
          return { results: [] };
        }
        return {
          results: [{ version: this.#schemaVersion.version }],
        };
      });
    }

    // Claim / seed the guard row. Atomic: exactly one concurrent insert wins.
    if (/^INSERT OR IGNORE INTO schema_version/i.test(text)) {
      return this.#withLock(() => {
        if (!this.#versionTableCreated) {
          throw new Error(
            "no such table: schema_version (CREATE TABLE ran first)",
          );
        }
        if (this.#schemaVersion !== null) {
          // Row already exists — the unique guard ignored this insert.
          return { results: [], changes: 0 };
        }
        const version = typeof params[0] === "number" ? params[0] : 0;
        const appliedAt = typeof params[1] === "number" ? params[1] : 0;
        this.#schemaVersion = { id: 1, version, applied_at: appliedAt };
        return { results: [], changes: 1 };
      });
    }

    // Compare-and-set the guard row (claim as "migrating" / resume / commit).
    if (/^UPDATE schema_version SET version = \?/i.test(text)) {
      return this.#withLock(() => {
        if (this.#schemaVersion === null) return { results: [], changes: 0 };
        const nextVersion = params[0];
        const nextAppliedAt = params[1];
        // `WHERE id = 1 AND version = 0` (claim as "migrating") carries the
        // expected version as a third binding; the bare commit does not.
        const gated = params.length >= 3;
        if (gated && this.#schemaVersion.version !== params[2]) {
          return { results: [], changes: 0 };
        }
        this.#schemaVersion = {
          id: 1,
          version: typeof nextVersion === "number" ? nextVersion : 0,
          applied_at: typeof nextAppliedAt === "number" ? nextAppliedAt : 0,
        };
        return { results: [], changes: 1 };
      });
    }

    // Any other statement is a data-plane migration statement.
    return this.#withLock(() => {
      this.appliedStatements.push(text);
      return { results: [], changes: 1 };
    });
  }

  /** Test helper: current committed/mid-flight version (null before creation). */
  get version(): number | null {
    return this.#schemaVersion?.version ?? null;
  }

  /** Test helper: count of migration statements actually executed. */
  get appliedCount(): number {
    return this.appliedStatements.length;
  }
}

// ---------------------------------------------------------------------------
// Fixture data.
// ---------------------------------------------------------------------------

/** A realistic two-step manifest exercising multi-statement migrations. */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL)",
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (email)",
    ],
  },
  {
    version: 2,
    statements: [
      "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL)",
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_slug ON projects (slug)",
    ],
  },
];

/** Total statements across the manifest (what "applied exactly once" means). */
const TOTAL_STATEMENTS = MIGRATIONS.reduce(
  (n, m) => n + m.statements.length,
  0,
);

const TARGET_VERSION = 2;

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("sortMigrations", () => {
  it("orders by version ascending without mutating the input", () => {
    const input: Migration[] = [
      { version: 2, statements: ["-- two"] },
      { version: 1, statements: ["-- one"] },
    ];
    const sorted = sortMigrations(input);
    expect(sorted.map((m) => m.version)).toEqual([1, 2]);
    // Input untouched.
    expect(input.map((m) => m.version)).toEqual([2, 1]);
  });

  it("rejects duplicate versions", () => {
    expect(() =>
      sortMigrations([
        { version: 1, statements: ["a"] },
        { version: 1, statements: ["b"] },
      ]),
    ).toThrow(/duplicate migration version/i);
  });
});

describe("applyMigrations — single writer (sequential)", () => {
  it("applies pending migrations once and bumps schema_version", async () => {
    const db = new FakeD1();

    const result = await applyMigrations(db, MIGRATIONS);

    expect(result.applied).toBe(true);
    expect(result.appliedVersions).toEqual([1, 2]);
    expect(result.version).toBe(TARGET_VERSION);
    expect(db.version).toBe(TARGET_VERSION);
    expect(await readSchemaVersion(db)).toBe(TARGET_VERSION);
    expect(db.appliedCount).toBe(TOTAL_STATEMENTS);
  });

  it("seeds schema_version from version 0 before applying anything", async () => {
    const db = new FakeD1();
    expect(db.version).toBeNull();

    await applyMigrations(db, []);

    // Even an empty manifest materializes the guard row (idempotently).
    expect(db.version).toBe(0);
    expect(db.appliedCount).toBe(0);
  });
});

describe("applyMigrations — idempotency", () => {
  it("re-running after success applies nothing and does not error", async () => {
    const db = new FakeD1();

    const first = await applyMigrations(db, MIGRATIONS);
    expect(first.appliedVersions).toEqual([1, 2]);
    const statementsAfterFirst = db.appliedCount;

    const second = await applyMigrations(db, MIGRATIONS);

    expect(second.applied).toBe(false);
    expect(second.appliedVersions).toEqual([]);
    expect(second.version).toBe(TARGET_VERSION);
    expect(db.version).toBe(TARGET_VERSION);
    // No statement was executed a second time.
    expect(db.appliedCount).toBe(statementsAfterFirst);
    expect(db.appliedCount).toBe(TOTAL_STATEMENTS);
    expect(await readSchemaVersion(db)).toBe(TARGET_VERSION);
  });
});

describe("applyMigrations — concurrent single-writer guard", () => {
  it("N concurrent calls apply the migration exactly once", async () => {
    const db = new FakeD1();
    const N = 8;

    const results = await Promise.all(
      Array.from({ length: N }, () => applyMigrations(db, MIGRATIONS)),
    );

    // Exactly one caller did the work.
    const winners = results.filter((r) => r.applied);
    expect(winners).toHaveLength(1);
    expect(winners[0].appliedVersions).toEqual([1, 2]);

    // ...and every winner/loser agrees on the final version.
    for (const r of results) expect(r.version).toBe(TARGET_VERSION);

    // Each migration statement ran exactly once, total.
    expect(db.appliedCount).toBe(TOTAL_STATEMENTS);
    expect(db.version).toBe(TARGET_VERSION);
    expect(await readSchemaVersion(db)).toBe(TARGET_VERSION);
  });

  it("losers neither throw nor double-apply (any N)", async () => {
    for (const N of [2, 3, 5, 13]) {
      const db = new FakeD1();
      const results = await Promise.all(
        Array.from({ length: N }, () => applyMigrations(db, MIGRATIONS)),
      );

      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect(results.length).toBe(N);
      expect(db.appliedCount).toBe(TOTAL_STATEMENTS);
      expect(db.version).toBe(TARGET_VERSION);
    }
  });

  it("never leaves a half-applied schema visible to any caller", async () => {
    const db = new FakeD1();
    const N = 12;

    // Sample the committed guard row after every call resolves.
    const observations = await Promise.all(
      Array.from({ length: N }, async () => {
        const result = await applyMigrations(db, MIGRATIONS);
        return result.version;
      }),
    );

    // No caller can observe an intermediate (or "migrating") version: the
    // winner commits the target before releasing the row and the losers only
    // report the committed version.
    for (const v of observations) expect(v).toBe(TARGET_VERSION);
    expect(db.version).toBe(TARGET_VERSION);
  });
});

describe("applyMigrations — resumability & manifest growth", () => {
  it("leaves the guard row at 0 (not the transient tombstone) for an empty manifest", async () => {
    const db = new FakeD1();
    expect(db.version).toBeNull();

    const result = await applyMigrations(db, []);

    expect(result.applied).toBe(false);
    expect(result.version).toBe(0);
    expect(db.version).toBe(0);
    // No migration statement was executed.
    expect(db.appliedCount).toBe(0);
  });

  it("applies a larger manifest exactly once when the owner wins from scratch", async () => {
    const db = new FakeD1();

    const result = await applyMigrations(db, [
      ...MIGRATIONS,
      { version: 3, statements: ["CREATE TABLE IF NOT EXISTS sessions (id TEXT)"] },
    ]);

    expect(result.appliedVersions).toEqual([1, 2, 3]);
    expect(db.version).toBe(3);
    expect(db.appliedCount).toBe(TOTAL_STATEMENTS + 1);
  });

  it("committed schema_version makes subsequent calls idempotent no-ops", async () => {
    const db = new FakeD1();

    const first = await applyMigrations(db, MIGRATIONS);
    expect(first.appliedVersions).toEqual([1, 2]);
    const statementsAfterFirst = db.appliedCount;

    // Re-running the same manifest changes nothing.
    const second = await applyMigrations(db, MIGRATIONS);
    expect(second.applied).toBe(false);
    expect(second.version).toBe(TARGET_VERSION);
    expect(db.appliedCount).toBe(statementsAfterFirst);
    expect(db.version).toBe(TARGET_VERSION);
  });
});
