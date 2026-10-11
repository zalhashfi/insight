import { describe, expect, it } from "vitest";
// @ts-expect-error `bun:sqlite` has no ambient type surface in this repo's
// tsconfig `types` (Cloudflare Workers + vitest only) and this task may not add
// dependencies or edit the tsconfig. Bun supplies the real module at runtime;
// the shape is pinned by the `SqliteDb` interface below.
import { Database } from "bun:sqlite";
import { parseSql, type SqlStatement } from "../../worker/src/platform/db/sql-split";

/** Minimal typed slice of a `bun:sqlite` `Database` (real at runtime). */
interface SqliteDb {
  run(sql: string, ...params: unknown[]): void;
  query<T = unknown>(sql: string): {
    all(...params: unknown[]): T[];
    get(...params: unknown[]): T | null;
  };
  close(): void;
}

// `Database` is untyped (see the `@ts-expect-error` above); pin its constructor
// to the interface this test relies on.
const SqliteDatabase = Database as unknown as new (filename?: string) => SqliteDb;
type Database = SqliteDb;

/**
 * Integration tests for migration `0001_init.sql`, executed against a *real*
 * in-memory SQLite database via Bun's built-in `bun:sqlite` (no new dependency).
 *
 * Where `schema.test.ts` inspects the parsed SQL *textually*, this file proves
 * the schema actually *applies*: every parsed statement is fed to
 * `db.run(...)`, then the resulting database is inspected through
 * `sqlite_master` / `PRAGMA table_info`.
 */

// `Bun` is not in this repo's tsconfig `types`. The global is well known at
// runtime, so a single named cast with its shape pinned is the narrowest fix
// (no runtime check is meaningful for a host-provided global).
const bunGlobal = globalThis as unknown as {
  readonly Bun: { file(path: string | URL): { text(): Promise<string> } };
};

const SQL_PATH = new URL(
  "../../worker/src/platform/db/migrations/0001_init.sql",
  import.meta.url,
);

const SQL = await bunGlobal.Bun.file(SQL_PATH).text();
const STATEMENTS: SqlStatement[] = parseSql(SQL);

/** Run every parsed migration statement against an open database, in order. */
function applyAll(db: Database, statements: readonly SqlStatement[]): void {
  for (const stmt of statements) {
    db.run(stmt.sql);
  }
}

/** Names of user tables (`sqlite_master`, excluding SQLite internals). */
function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_"));
}

/** Column names of `table`, via `PRAGMA table_info`. */
function columnNames(db: Database, table: string): string[] {
  return db
    .query<{ name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => r.name);
}

/** A `sqlite_master` row: the object's name and its original `CREATE` SQL. */
interface MasterRow {
  name: string;
  sql: string | null;
}

const METADATA_TABLES = [
  "schema_version",
  "users",
  "accounts",
  "sessions",
  "verifications",
  "projects",
  "project_members",
  "project_tokens",
  "project_variables",
] as const;

/** Required column set per table — the shape `0001_init.sql` promises. */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  schema_version: ["id", "version", "applied_at"],
  users: [
    "id",
    "email",
    "email_verified",
    "name",
    "image",
    "password_hash",
    "created_at",
    "updated_at",
  ],
  accounts: [
    "id",
    "user_id",
    "provider",
    "provider_account_id",
    "type",
    "created_at",
    "updated_at",
  ],
  sessions: ["id", "user_id", "token_hash", "expires_at", "created_at", "updated_at"],
  verifications: ["id", "identifier", "value_hash", "expires_at", "created_at", "updated_at"],
  projects: ["id", "name", "slug", "owner_id", "created_at", "updated_at"],
  project_members: ["id", "project_id", "user_id", "role", "created_at", "updated_at"],
  project_tokens: ["id", "project_id", "name", "token_hash", "created_at", "updated_at"],
  project_variables: [
    "id",
    "project_id",
    "key",
    "value",
    "is_secret",
    "created_at",
    "updated_at",
  ],
};

// A telemetry point-store table would be named like one of these.
const TELEMETRY_POINT_TABLE = /reading|telemetry_point|telemetry_|telemetries|samples?|observations?|measurements?|datapoints?|data_points?|timeseries|time_series|series\b|metrics?$/i;

describe("migration 0001 applies cleanly against real SQLite", () => {
  it("parses into executable statements and applies without throwing", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      expect(STATEMENTS.length).toBeGreaterThan(0);
      // First apply: must not throw.
      expect(() => applyAll(db, STATEMENTS)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("creates the full metadata table set", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      applyAll(db, STATEMENTS);
      const names = tableNames(db);
      for (const table of METADATA_TABLES) {
        expect(names, `table "${table}" missing after apply`).toContain(table);
      }
      // Exactly the metadata set — nothing extra was created.
      expect(names.sort()).toEqual([...METADATA_TABLES].sort());
    } finally {
      db.close();
    }
  });

  it("gives every table its expected columns (via PRAGMA table_info)", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      applyAll(db, STATEMENTS);
      for (const [table, expected] of Object.entries(REQUIRED_COLUMNS)) {
        const cols = columnNames(db, table);
        for (const col of expected) {
          expect(cols, `${table}.${col} missing`).toContain(col);
        }
      }
    } finally {
      db.close();
    }
  });

  it("enforces the schema_version single-row guard and seeds version 0", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      applyAll(db, STATEMENTS);

      // Guard row was seeded by `INSERT OR IGNORE` in the migration.
      const row = db
        .query<{ id: number; version: number }>(
          "SELECT id, version FROM schema_version",
        )
        .get();
      expect(row).not.toBeNull();
      expect(row?.id).toBe(1);
      expect(row?.version).toBe(0);

      // `CHECK (id = 1)` constrains the table to a single row.
      expect(() =>
        db.run(
          "INSERT INTO schema_version (id, version, applied_at) VALUES (2, 0, 0)",
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("creates the declared unique indexes", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      applyAll(db, STATEMENTS);
      const indexes = db
        .query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
        )
        .all()
        .map((r) => r.name);
      for (const idx of [
        "uq_users_email",
        "uq_accounts_provider_account",
        "uq_sessions_token_hash",
        "uq_projects_slug",
        "uq_project_tokens_token_hash",
        "uq_project_variables_project_key",
      ]) {
        expect(indexes, `index "${idx}" missing`).toContain(idx);
      }
    } finally {
      db.close();
    }
  });

  it("enforces the users.email uniqueness constraint", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      applyAll(db, STATEMENTS);
      db.run(
        "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'a@b.c', 0, 0)",
      );
      expect(() =>
        db.run(
          "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u2', 'a@b.c', 0, 0)",
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("declares foreign keys referencing the expected parent tables", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      applyAll(db, STATEMENTS);
      const sessionFks = db
        .query<{ table: string; from: string; to: string }>(
          "PRAGMA foreign_key_list(sessions)",
        )
        .all();
      expect(sessionFks.some((fk) => fk.table === "users" && fk.from === "user_id")).toBe(
        true,
      );

      const projectFks = db
        .query<{ table: string; from: string }>("PRAGMA foreign_key_list(projects)")
        .all();
      expect(projectFks.some((fk) => fk.table === "users" && fk.from === "owner_id")).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });
});

describe("migration 0001 is idempotent on re-apply", () => {
  it("does not throw when the same statements run twice", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      expect(() => applyAll(db, STATEMENTS)).not.toThrow();
      // Second apply — guarded by IF NOT EXISTS / INSERT OR IGNORE.
      expect(() => applyAll(db, STATEMENTS)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("leaves the same table set and a single seeded guard row after re-apply", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      applyAll(db, STATEMENTS);
      const before = tableNames(db);

      applyAll(db, STATEMENTS);

      expect(tableNames(db)).toEqual(before);

      const guardCount = db
        .query<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version")
        .get();
      expect(guardCount?.n).toBe(1);

      const versions = db
        .query<{ version: number }>("SELECT version FROM schema_version")
        .all();
      expect(versions).toEqual([{ version: 0 }]);
    } finally {
      db.close();
    }
  });
});

describe("INV-T5: no telemetry-point table exists after apply", () => {
  it("creates no table whose name indicates a telemetry point store", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      applyAll(db, STATEMENTS);
      const names = tableNames(db);
      for (const name of names) {
        expect(
          TELEMETRY_POINT_TABLE.test(name),
          `telemetry-point table "${name}" present after apply`,
        ).toBe(false);
      }
      // And the applied schema is exactly the metadata set.
      expect(names.sort()).toEqual([...METADATA_TABLES].sort());
    } finally {
      db.close();
    }
  });

  it("has no CREATE TABLE mentioning a banned telemetry-point name anywhere", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      applyAll(db, STATEMENTS);
      const tables = db
        .query<MasterRow>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
        )
        .all();
      const allSql = tables.map((t) => t.sql ?? "").join("\n");
      expect(/telemetry_points/i.test(allSql)).toBe(false);
      expect(/CREATE\s+TABLE[^;]*\breadings\b/i.test(allSql)).toBe(false);
      expect(/CREATE\s+TABLE[^;]*\bsamples\b/i.test(allSql)).toBe(false);
    } finally {
      db.close();
    }
  });
});
