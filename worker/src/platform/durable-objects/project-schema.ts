/**
 * ProjectDO SQLite schema (Cloudflare Durable Object storage).
 *
 * A project's Durable Object is the *read* projection of a project's telemetry
 * — the small, hot, queryable "what is every device reporting right now" view.
 * It is the counterpart to the shard write path (A09): shards own the raw,
 * bounded sample history and journal samples for the analytics store; the
 * project DO owns one row per `(device, variable)` and keeps only the latest
 * accepted reading.
 *
 * ## Why one row per stream
 *
 * A dashboard asks "what is the current value of every variable on every
 * device?" far more often than it asks for history, and the answer must be a
 * single indexed read, not a scan. So the projection is maintained by upsert:
 * each accepted push overwrites the one row for its `(device, variable)`
 * stream. Ordering is enforced on write (see {@link ../project-do}), so the row
 * that survives is always the newest by `(ts, seq)`.
 *
 * ## Not here
 *
 * This module is pure data — a DDL string, a splitter and the table names. It
 * performs no I/O, imports nothing and knows nothing about the Cloudflare
 * runtime, so both the DO and the tests can depend on it without pulling the
 * platform in.
 *
 * Conventions (mirroring the D1 migration 0001 and the shard schema):
 *   * timestamps -> INTEGER epoch milliseconds (Unix ms, UTC)
 *   * values     -> REAL; nullable, because a null reading is a valid reading
 *   * every statement is idempotent (`IF NOT EXISTS`), so applying the DDL on
 *     each DO construction is safe: a fresh DO creates the tables, an existing
 *     one is a no-op that keeps its rows.
 */

/**
 * The complete DDL for a project's SQLite database.
 *
 * The projection is exactly one table plus its ordering companion:
 *
 *   - `latest_state` — the projection itself, one row per `(device, variable)`
 *     stream, `PRIMARY KEY (device, variable)`. The value/ts/seq columns are
 *     the sample that currently wins the ordering rules.
 *   - `project_meta` — per-DO bookkeeping: the schema version and the last time
 *     the projection was written. One row, keyed by a fixed `id`.
 */
export const PROJECT_DDL = `
-- ---------------------------------------------------------------------------
-- latest_state — the read projection: the winning sample per stream.
--   One row per (device, variable). The composite primary key makes the upsert
--   a single statement and guarantees independence between devices and between
--   variables: writing one stream can never touch another.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS latest_state (
  device   TEXT    NOT NULL,
  variable TEXT    NOT NULL,
  value    REAL,
  ts       INTEGER NOT NULL,
  seq      INTEGER NOT NULL,
  PRIMARY KEY (device, variable)
);

-- ---------------------------------------------------------------------------
-- project_meta — one row of per-DO bookkeeping (schema version + write clock).
--   Mirrors the flush_meta/device_counter role in the shard schema: the
--   state a later unit reads without scanning the projection.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_meta (
  id         TEXT    PRIMARY KEY,
  updated_at INTEGER NOT NULL
);
`;

/** The single row id used by `project_meta`. */
export const PROJECT_META_ID = "project";

/**
 * The DDL as an ordered list of statements, ready to hand to
 * `ctx.storage.sql.exec(...)` one at a time.
 *
 * Splitting is deliberately naive — the DDL above is ours, it contains no
 * string literals and no terminator inside a comment — so a `;` on its own is
 * always a statement boundary. Consumers that need a real splitter (arbitrary
 * `.sql` files) should use `platform/db/sql-split.ts`.
 */
export function projectStatements(): string[] {
  return PROJECT_DDL.split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => `${statement};`);
}

/** Names of the tables this schema owns, for assertions and diagnostics. */
export const PROJECT_TABLES = ["latest_state", "project_meta"] as const;

export type ProjectTable = (typeof PROJECT_TABLES)[number];
