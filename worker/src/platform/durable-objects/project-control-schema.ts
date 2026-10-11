/**
 * ProjectControl SQLite schema (Cloudflare Durable Object storage).
 *
 * A project's control plane — the small, hot state that answers two questions
 * a project DO must answer without a scan:
 *
 *   - **"What should this device do next?"** — `pending_control` holds the
 *     commands enqueued for a device (a variable to set, a value to set it to)
 *     together with the deadline at which the command stops being useful. A
 *     device polls, gets the commands that are neither acknowledged nor
 *     expired, and acknowledges by id; acknowledged rows stop being returned.
 *   - **"May this device push another OTA?"** — `ota_quota` holds one row per
 *     device counting how many over-the-air updates it has consumed inside the
 *     current hour window. The window is fixed-width and resets when the clock
 *     rolls past `window_start + 1h`, so a device can never spend more than the
 *     configured budget per hour.
 *
 * Expiry is a *status*, not a delete: a command past its TTL is marked
 * `expired` and is never returned again (INV-T6 / ST-T6), so the row survives
 * as an audit trail while the poll path stays cheap — it filters by
 * `status = 'pending'` on the indexed `(status, device)` prefix.
 *
 * This module is pure data — a DDL string, a splitter, the table names and the
 * status vocabulary. It performs no I/O, imports nothing and knows nothing
 * about the Cloudflare runtime, so both the DO and the tests can depend on it
 * without pulling the platform in.
 *
 * Conventions (mirroring the D1 migration 0001 and the sibling schemas):
 *   * timestamps -> INTEGER epoch milliseconds (Unix ms, UTC)
 *   * every statement is idempotent (`IF NOT EXISTS`), so applying the DDL on
 *     each DO construction is safe: a fresh DO creates the tables, an existing
 *     one is a no-op that keeps its rows.
 */

/**
 * The complete DDL for a project-control SQLite database.
 *
 * Two tables, one per question above:
 *
 *   - `pending_control` — one row per command, keyed by the caller's `id` (so
 *     enqueueing the same id twice is an upsert, not a duplicate), carrying the
 *     `variable`/`value` to apply, the TTL it was enqueued with, when it was
 *     created, and its lifecycle `status` (`pending` | `acked` | `expired`).
 *   - `ota_quota` — one row per device, `device TEXT PRIMARY KEY`, holding the
 *     start of the hour window currently being counted and how much of the
 *     budget has been used inside it.
 */
export const PROJECT_CONTROL_DDL = `
-- ---------------------------------------------------------------------------
-- pending_control — commands queued for a device, with their TTL and status.
--   The primary key is the caller-supplied id, so re-enqueueing a command is
--   an upsert that refreshes it rather than a second delivery. The status
--   column is the single source of truth for lifecycle: only the pending rows
--   are delivered, an acknowledgement flips a row to acked, and a row past its
--   TTL is flipped to expired by the poll path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_control (
  id         TEXT    PRIMARY KEY,
  device     TEXT    NOT NULL,
  variable   TEXT    NOT NULL,
  value      TEXT,
  ttl_ms     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending'
);

-- The hot poll path: the pending commands of one device, oldest first.
CREATE INDEX IF NOT EXISTS idx_pending_control_device_status
  ON pending_control (device, status, created_at);

-- The expiry sweep / status audit: every row in a given lifecycle state.
CREATE INDEX IF NOT EXISTS idx_pending_control_status
  ON pending_control (status);

-- ota_quota — per-device OTA consumption inside a fixed one-hour window.
--   One row per device. The window_start column is the epoch-ms instant the
--   window currently being counted opened, while used is how much of the
--   budget it has spent. ProjectControl compares window_start plus one hour
--   against its clock and resets the row when the hour has rolled.
CREATE TABLE IF NOT EXISTS ota_quota (
  device       TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0
);
`;

/** Names of the tables this schema owns, for assertions and diagnostics. */
export const PROJECT_CONTROL_TABLES = ["pending_control", "ota_quota"] as const;

export type ProjectControlTable = (typeof PROJECT_CONTROL_TABLES)[number];

/**
 * The lifecycle states of a `pending_control` row.
 *
 *   - `pending` — enqueued and eligible for delivery.
 *   - `acked`   — acknowledged by the device; never delivered again.
 *   - `expired` — past `created_at + ttl_ms`; dropped from delivery and kept
 *     only as a record (INV-T6 / ST-T6).
 */
export const CONTROL_STATUS = ["pending", "acked", "expired"] as const;

export type ControlStatus = (typeof CONTROL_STATUS)[number];

/** The only status a command is delivered in. */
export const CONTROL_STATUS_PENDING: ControlStatus = "pending";

/**
 * The DDL as an ordered list of statements, ready to hand to
 * `ctx.storage.sql.exec(...)` one at a time.
 *
 * Splitting is deliberately naive — the DDL above is ours, it contains no
 * string literals and no terminator inside a comment — so a `;` on its own is
 * always a statement boundary. Consumers that need a real splitter (arbitrary
 * `.sql` files) should use `platform/db/sql-split.ts`.
 */
export function projectControlStatements(): string[] {
  return PROJECT_CONTROL_DDL.split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => `${statement};`);
}
