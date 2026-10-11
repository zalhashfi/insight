import { describe, expect, it } from "vitest";
import { parseSql, type SqlStatement } from "../../worker/src/platform/db/sql-split";

// Minimal ambient surface needed to read a file in-process without pulling in
// Node type packages (the repo's tsconfig `types` is limited to Cloudflare
// Workers + vitest, and this task may not touch it). Bun provides both at
// runtime; these declarations only teach `tsc` about them.
declare global {
  const Bun: {
    file(path: string | URL): { text(): Promise<string> };
  };

  /** `Headers.entries()` — Hono returns a worker `Headers`, not the DOM one. */
  interface Headers {
    entries(): IterableIterator<[string, string]>;
  }
}

/**
 * Spec tests for the D1 metadata schema (migration `0001_init.sql`).
 *
 * These run in-process: the `.sql` file is read from disk and parsed with the
 * pure helper `sql-split.ts`. No SQL engine / D1 binding is required.
 */

// Path relative to the repo root, resolved from this test file's location.
const SQL_PATH = new URL(
  "../../worker/src/platform/db/migrations/0001_init.sql",
  import.meta.url,
);

const SQL = await Bun.file(SQL_PATH).text();
const STATEMENTS: SqlStatement[] = parseSql(SQL);

/** Table names created by `CREATE TABLE` (order preserved, de-duplicated). */
const CREATED_TABLES: string[] = (() => {
  const names: string[] = [];
  for (const stmt of STATEMENTS) {
    if (stmt.keyword !== "CREATE") continue;
    const m = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?/i.exec(
      stmt.sql,
    );
    if (m) {
      const name = m[1].toLowerCase();
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
})();

/** The full `CREATE TABLE ... )` text for a given table, or `undefined`. */
function tableBody(table: string): string | undefined {
  const stmt = STATEMENTS.find(
    (s) =>
      s.keyword === "CREATE" &&
      new RegExp(
        `^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`\\[]?${table}["'\`\\]]?\\b`,
        "i",
      ).test(s.sql),
  );
  return stmt?.sql;
}

describe("migration file", () => {
  it("exists and can be read as non-empty SQL", () => {
    expect(SQL.length).toBeGreaterThan(0);
    expect(STATEMENTS.length).toBeGreaterThan(0);
  });

  it("uses CREATE TABLE IF NOT EXISTS for every table", () => {
    const createTables = STATEMENTS.filter((s) =>
      /^\s*CREATE\s+TABLE\b/i.test(s.sql),
    );
    expect(createTables.length).toBeGreaterThan(0);
    for (const stmt of createTables) {
      expect(stmt.sql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
    }
  });

  it("declares indexes to support lookups", () => {
    const indexes = STATEMENTS.filter(
      (s) => s.keyword === "CREATE" && /CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(s.sql),
    );
    expect(indexes.length).toBeGreaterThan(0);
  });
});

describe("required tables", () => {
  const REQUIRED = [
    "users",
    "accounts",
    "sessions",
    "verifications",
    "projects",
    "project_members",
    "project_tokens",
    "project_variables",
    "schema_version",
  ];

  it.each(REQUIRED)("creates table %s", (table) => {
    expect(CREATED_TABLES).toContain(table.toLowerCase());
    expect(tableBody(table)).toBeDefined();
  });

  it("declares exactly the required metadata tables (no extras)", () => {
    expect([...CREATED_TABLES].sort()).toEqual([...REQUIRED].sort());
  });
});

describe("INV-T5: D1 is metadata only, no telemetry data-point tables", () => {
  const TELEMETRY_NAME_PATTERNS = [
    /reading/i,
    /telemetry_point/i,
    /telemetry_/i,
    /telemetries/i,
    /samples?\b/i,
    /observations?/i,
    /measurements?/i,
    /datapoints?/i,
    /data_points?/i,
    /timeseries/i,
    /time_series/i,
    /metrics?$/i,
    /series\b/i,
    /events?\b/i,
  ];

  it("has no table whose NAME indicates a telemetry point store", () => {
    for (const table of CREATED_TABLES) {
      for (const pattern of TELEMETRY_NAME_PATTERNS) {
        expect(pattern.test(table), `table "${table}" matches ${pattern}`).toBe(false);
      }
    }
  });

  it("has no table whose COLUMNS indicate a per-reading point store", () => {
    // A point row would typically carry a timestamped numeric reading.
    const POINT_COLUMN_PATTERNS = [
      /^\s*value_num(eric)?\s/i,
      /^\s*value_float\s/i,
      /^\s*timestamp_ms\s/i,
      /^\s*reading\s/i,
      /^\s*ts_ms\s/i,
      /^\s*metric_value\s/i,
    ];
    for (const table of CREATED_TABLES) {
      const body = tableBody(table) ?? "";
      for (const pattern of POINT_COLUMN_PATTERNS) {
        expect(
          pattern.test(body),
          `table "${table}" has a telemetry point-store column (${pattern})`,
        ).toBe(false);
      }
    }
  });

  it("never mentions a banned telemetry-point table name anywhere in the file", () => {
    // Guards against e.g. foreign keys or comments re-introducing such a store.
    for (const banned of ["telemetry_points", "readings", "samples"]) {
      expect(new RegExp(`CREATE\\s+TABLE[^;]*${banned}`, "i").test(SQL)).toBe(false);
    }
  });
});

describe("schema_version guard table", () => {
  it("exists as a CREATE TABLE", () => {
    expect(CREATED_TABLES).toContain("schema_version");
    expect(tableBody("schema_version")).toBeDefined();
  });

  it("stores the applied version and an applied_at stamp", () => {
    const body = tableBody("schema_version") ?? "";
    expect(body).toMatch(/\bversion\b/i);
    expect(body).toMatch(/\bapplied_at\b/i);
  });

  it("is guarded to a single row", () => {
    const body = tableBody("schema_version") ?? "";
    // A single-row guard: PRIMARY KEY CHECK (id = 1), i.e. one applied version.
    expect(body).toMatch(/id\s+INTEGER\s+PRIMARY\s+KEY/i);
    expect(body).toMatch(/CHECK\s*\(\s*id\s*=\s*1\s*\)/i);
  });
});

describe("access & config invariants", () => {
  it("project_variables enforces uniqueness on (project_id, key)", () => {
    const body = tableBody("project_variables") ?? "";
    const hasUniqueOnKey = /UNIQUE\s*\(\s*project_id\s*,\s*key\s*\)/i.test(body);
    const hasUniqueIndex = STATEMENTS.some(
      (s) =>
        /CREATE\s+UNIQUE\s+INDEX/i.test(s.sql) &&
        /project_variables/i.test(s.sql) &&
        /\(\s*project_id\s*,\s*key\s*\)/i.test(s.sql),
    );
    expect(hasUniqueOnKey || hasUniqueIndex).toBe(true);
  });

  it("project_tokens stores a hash column and NOT a plaintext token column", () => {
    const body = tableBody("project_tokens") ?? "";
    expect(body).toMatch(/\btoken_hash\b/i);
    // No naked `token`/`secret`/`value` plaintext column.
    expect(body).not.toMatch(/^\s*token\s+TEXT/im);
    expect(body).not.toMatch(/^\s*plain(?:text)?_token\s/im);
    expect(body).not.toMatch(/^\s*secret\s+TEXT/im);
  });

  it("uniquely constrains the token hash", () => {
    const body = tableBody("project_tokens") ?? "";
    const inlineUnique = /token_hash\s+TEXT[^,]*UNIQUE/i.test(body);
    const uniqueIndex = STATEMENTS.some(
      (s) =>
        /CREATE\s+UNIQUE\s+INDEX/i.test(s.sql) &&
        /project_tokens/i.test(s.sql) &&
        /token_hash/i.test(s.sql),
    );
    expect(inlineUnique || uniqueIndex).toBe(true);
  });

  it("project_members is unique per (project_id, user_id)", () => {
    const body = tableBody("project_members") ?? "";
    const hasUniqueInTable = /UNIQUE\s*\(\s*project_id\s*,\s*user_id\s*\)/i.test(body);
    const hasUniqueIndex = STATEMENTS.some(
      (s) =>
        /CREATE\s+UNIQUE\s+INDEX/i.test(s.sql) &&
        /project_members/i.test(s.sql) &&
        /\(\s*project_id\s*,\s*user_id\s*\)/i.test(s.sql),
    );
    expect(hasUniqueInTable || hasUniqueIndex).toBe(true);
  });

  it("users are uniquely identified by email", () => {
    const uniqueEmailIndex = STATEMENTS.some(
      (s) =>
        /CREATE\s+UNIQUE\s+INDEX/i.test(s.sql) &&
        /users/i.test(s.sql) &&
        /\bemail\b/i.test(s.sql),
    );
    const inline = /\bemail\s+TEXT\b[^,]*UNIQUE/i.test(tableBody("users") ?? "");
    expect(uniqueEmailIndex || inline).toBe(true);
  });
});

describe("sql-split helper", () => {
  it("splits statements, ignoring terminators inside string literals", () => {
    const stmts = parseSql("CREATE TABLE a (x TEXT DEFAULT 'a;b'); CREATE TABLE b (y TEXT);");
    expect(stmts).toHaveLength(2);
    expect(stmts[0].keyword).toBe("CREATE");
    expect(stmts[0].sql).toContain("'a;b'");
  });

  it("strips line and block comments", () => {
    const stmts = parseSql("-- greeting\n/* block ; comment */ CREATE TABLE c (z TEXT);\n");
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toBe("CREATE TABLE c (z TEXT)");
  });

  it("yields the leading keyword per statement", () => {
    const stmts = parseSql("INSERT INTO t VALUES (1); CREATE INDEX i ON t (c);");
    expect(stmts.map((s) => s.keyword)).toEqual(["INSERT", "CREATE"]);
  });
});
