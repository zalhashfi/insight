/**
 * ShardDO SQLite schema (Cloudflare Durable Object storage).
 *
 * The DO's own embedded SQLite (`ctx.storage.sql`) is the *hot* shard state,
 * not the metadata store: D1 holds accounts/projects/config (INV-T5) and MUST
 * NOT hold telemetry points. Samples that arrive here live in two places:
 *
 *   - `ring_buffer` — the bounded FIFO of the `N` newest samples for a
 *     `(device, metric)` stream. This is what a live dashboard reads.
 *   - `inflight`    — a write-ahead journal of samples that have been accepted
 *     but not yet flushed downstream to the analytics store. A later unit
 *     (A10) drains it; this unit only defines the table and the method surface.
 *
 * `flush_meta` carries the per-device bookkeeping the drain needs (how far it
 * has got, and how many rows it still owes), plus per-(device, metric)
 * ordering/projection state so the ingest path can reject an out-of-order
 * sample without a second lookup (INV-T1/T2).
 *
 * Pure data: this module exports a string constant and one tiny helper. It
 * performs no I/O and knows nothing about the Cloudflare runtime, so both the
 * DO and the tests can depend on it.
 *
 * Conventions (mirroring the D1 migration 0001):
 *   * timestamps -> INTEGER epoch milliseconds (Unix ms, UTC)
 *   * booleans   -> INTEGER 0/1
 *   * metric values -> REAL; nullable, because a null reading is valid
 */

/**
 * The complete DDL for a shard's SQLite database.
 *
 * Every statement is idempotent (`IF NOT EXISTS`) so it is safe to run on each
 * construction of the DO: a fresh DO creates the tables, an existing one is a
 * no-op and keeps its data.
 */
export const SHARD_DDL = `
-- ---------------------------------------------------------------------------
-- ring_buffer — bounded FIFO of the newest samples, per (device, metric).
--   One row is one sample. The ingest path evicts the oldest row of a stream
--   once it holds RING_CAPACITY rows, so a stream never grows without bound.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ring_buffer (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device     TEXT    NOT NULL,
  metric     TEXT    NOT NULL,
  value      REAL,
  ts         INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);

-- The hot read path: newest-first scan of one stream, and the FIFO head
-- lookup (oldest row) used when evicting.
CREATE INDEX IF NOT EXISTS idx_ring_buffer_stream
  ON ring_buffer (device, metric, seq);

-- ---------------------------------------------------------------------------
-- inflight — accepted-but-unflushed samples (A10 drain journal).
--   Kept separate from ring_buffer so the drain can delete rows without
--   disturbing the live window a dashboard is tailing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inflight (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device     TEXT    NOT NULL,
  metric     TEXT    NOT NULL,
  value      REAL,
  ts         INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inflight_device
  ON inflight (device, seq);

-- ---------------------------------------------------------------------------
-- flush_meta — per-device flush bookkeeping and per-stream ordering state.
--   Rows are per (device, metric): the latest accepted (value, ts, seq) for the
--   stream, the monotonic seq high-water mark used to order samples, and the
--   per-device dropped counter bumped when the ring evicts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flush_meta (
  device      TEXT    NOT NULL,
  metric      TEXT    NOT NULL,
  latest_ts   INTEGER,
  latest_value REAL,
  latest_seq  INTEGER NOT NULL DEFAULT 0,
  next_seq    INTEGER NOT NULL DEFAULT 0,
  dropped     INTEGER NOT NULL DEFAULT 0,
  flushed_seq INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (device, metric)
);

CREATE INDEX IF NOT EXISTS idx_flush_meta_device
  ON flush_meta (device, metric);

-- ---------------------------------------------------------------------------
-- device_counter — one row per device, aggregating the per-stream counters
--   (ring occupancy and dropped total) so dropped/capacity checks are
--   a single indexed read rather than a scan of every stream.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_counter (
  device     TEXT    PRIMARY KEY,
  ring_count INTEGER NOT NULL DEFAULT 0,
  dropped    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

/**
 * The DDL as an ordered list of statements, ready to hand to
 * `ctx.storage.sql.exec(...)` one at a time.
 *
 * Splitting is deliberately naive — the DDL above is ours, it contains no
 * string literals and no terminator inside a comment — so a `;` on its own is
 * always a statement boundary. Consumers that need a real splitter (arbitrary
 * `.sql` files) should use `platform/db/sql-split.ts`.
 */
export function shardStatements(): string[] {
  return SHARD_DDL.split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => `${statement};`);
}

/** Names of the tables this schema owns, for assertions and diagnostics. */
export const SHARD_TABLES = [
  "ring_buffer",
  "inflight",
  "flush_meta",
  "device_counter",
] as const;

export type ShardTable = (typeof SHARD_TABLES)[number];
