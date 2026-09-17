CREATE TABLE IF NOT EXISTS external_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  device_key TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL DEFAULT 5,
  envelope_path TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '[]',
  cursor_field TEXT NOT NULL DEFAULT 'id',
  sentinel_map TEXT NOT NULL DEFAULT '{}',
  headers TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_cursor TEXT,
  last_run_at INTEGER,
  last_run_status TEXT CHECK (last_run_status IN ('ok','error','skipped')),
  last_error TEXT,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_external_sources_project ON external_sources(project_id);
CREATE INDEX IF NOT EXISTS idx_external_sources_poll ON external_sources(enabled, archived_at);
