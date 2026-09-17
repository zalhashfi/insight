// AUTO-GENERATED at build time by scripts/gen-migrations.ts.
// Source: worker/src/db/migrations/*.sql. Do not edit by hand.

export type Migration = { name: string; statements: string[] };

export const MIGRATIONS: Migration[] = [
  {
    "name": "0001_init",
    "statements": [
      "CREATE TABLE IF NOT EXISTS users (\r\n  id             TEXT PRIMARY KEY,\r\n  email          TEXT NOT NULL UNIQUE,\r\n  email_verified INTEGER NOT NULL DEFAULT 1,    \n  name           TEXT,                                      \n  image          TEXT,\r\n  role           TEXT NOT NULL CHECK (role IN ('owner','admin','member')),\r\n  first_name     TEXT,\r\n  last_name      TEXT,\r\n  last_login_at  INTEGER,\r\n  created_at     INTEGER NOT NULL,\r\n  updated_at     INTEGER NOT NULL\r\n)",
      "CREATE TABLE IF NOT EXISTS accounts (\r\n  id                       TEXT PRIMARY KEY,\r\n  account_id               TEXT NOT NULL,\r\n  provider_id              TEXT NOT NULL,\r\n  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\r\n  access_token             TEXT,\r\n  refresh_token            TEXT,\r\n  id_token                 TEXT,\r\n  access_token_expires_at  INTEGER,\r\n  refresh_token_expires_at INTEGER,\r\n  scope                    TEXT,\r\n  password                 TEXT,                            \n  created_at               INTEGER NOT NULL,\r\n  updated_at               INTEGER NOT NULL\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_accounts_user     ON accounts(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider_id, account_id)",
      "CREATE TABLE IF NOT EXISTS sessions (\r\n  id          TEXT PRIMARY KEY,\r\n  token       TEXT NOT NULL UNIQUE,                         \n  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\r\n  expires_at  INTEGER NOT NULL,\r\n  ip_address  TEXT,\r\n  user_agent  TEXT,\r\n  created_at  INTEGER NOT NULL,\r\n  updated_at  INTEGER NOT NULL\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)",
      "CREATE TABLE IF NOT EXISTS verifications (\r\n  id          TEXT PRIMARY KEY,\r\n  identifier  TEXT NOT NULL,\r\n  value       TEXT NOT NULL,\r\n  expires_at  INTEGER NOT NULL,\r\n  created_at  INTEGER NOT NULL,\r\n  updated_at  INTEGER NOT NULL\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_verifications_identifier ON verifications(identifier)",
      "CREATE TABLE IF NOT EXISTS auth_providers (\r\n  kind          TEXT PRIMARY KEY CHECK (kind IN ('google','github')),\r\n  client_id     TEXT NOT NULL,\r\n  client_secret TEXT NOT NULL,\r\n  enabled       INTEGER NOT NULL DEFAULT 1,\r\n  created_at    INTEGER NOT NULL,\r\n  updated_at    INTEGER NOT NULL\r\n)",
      "CREATE TABLE IF NOT EXISTS projects (\r\n  id          TEXT PRIMARY KEY,\r\n  name        TEXT NOT NULL,\r\n  description TEXT,\r\n  created_by  TEXT REFERENCES users(id),\r\n  created_at  INTEGER NOT NULL,\r\n  updated_at  INTEGER NOT NULL,\r\n  archived_at INTEGER\r\n)",
      "CREATE TABLE IF NOT EXISTS project_members (\r\n  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\r\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\r\n  added_at   INTEGER NOT NULL,\r\n  added_by   TEXT REFERENCES users(id),\r\n  PRIMARY KEY (user_id, project_id)\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id)",
      "CREATE TABLE IF NOT EXISTS project_variables (\r\n  id          TEXT PRIMARY KEY,\r\n  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\r\n  key         TEXT NOT NULL,                     \n  unit        TEXT,                              \n  created_at  INTEGER NOT NULL,\r\n  updated_at  INTEGER NOT NULL,\r\n  last_seen   INTEGER                            \n)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_variables_key\r\n  ON project_variables(project_id, key)",
      "CREATE TABLE IF NOT EXISTS project_tokens (\r\n  id           TEXT PRIMARY KEY,\r\n  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\r\n  name         TEXT,\r\n  hash         TEXT NOT NULL UNIQUE,            \n  created_by   TEXT REFERENCES users(id),\r\n  created_at   INTEGER NOT NULL,\r\n  last_used_at INTEGER,\r\n  revoked_at   INTEGER\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_project_tokens_project ON project_tokens(project_id)",
      "CREATE TABLE IF NOT EXISTS user_tokens (\r\n  id           TEXT PRIMARY KEY,\r\n  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE, \n  scope        TEXT NOT NULL CHECK (scope IN ('read','admin')),\r\n  name         TEXT,                                           \n  hash         TEXT NOT NULL UNIQUE,\r\n  created_by   TEXT NOT NULL REFERENCES users(id),\r\n  created_at   INTEGER NOT NULL,\r\n  expires_at   INTEGER,                                        \n  last_used_at INTEGER,\r\n  revoked_at   INTEGER\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_user_tokens_project ON user_tokens(project_id)",
      "CREATE TABLE IF NOT EXISTS dashboards (\r\n  id          TEXT PRIMARY KEY,\r\n  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\r\n  name        TEXT NOT NULL,\r\n  description TEXT,\r\n  layout      TEXT NOT NULL,                                   \n  visibility  TEXT NOT NULL DEFAULT 'private'\r\n              CHECK (visibility IN ('private','public')),\r\n  share_token TEXT,                                            \n  created_by  TEXT REFERENCES users(id),\r\n  created_at  INTEGER NOT NULL,\r\n  updated_at  INTEGER NOT NULL,\r\n  archived_at INTEGER\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_dashboards_project ON dashboards(project_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboards_share_token\r\n  ON dashboards(share_token) WHERE share_token IS NOT NULL",
      "CREATE TABLE IF NOT EXISTS automations (\r\n  id              TEXT PRIMARY KEY,\r\n  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\r\n  name            TEXT NOT NULL,\r\n  description     TEXT,\r\n  enabled         INTEGER NOT NULL DEFAULT 1,                  \n  trigger_type    TEXT NOT NULL CHECK (trigger_type IN\r\n                    ('variable','manual','schedule','sunset_sunrise','event')),\r\n  trigger_kinds   TEXT NOT NULL DEFAULT '',                    \n  graph           TEXT NOT NULL,                               \n  created_by      TEXT REFERENCES users(id),\r\n  created_at      INTEGER NOT NULL,\r\n  updated_at      INTEGER NOT NULL,\r\n  last_run_at     INTEGER,\r\n  last_run_status TEXT CHECK (last_run_status IN ('ok','error','skipped')),\r\n  last_error      TEXT\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_automations_project ON automations(project_id)",
      "CREATE INDEX IF NOT EXISTS idx_automations_enabled ON automations(enabled) WHERE enabled = 1",
      "CREATE INDEX IF NOT EXISTS idx_automations_project_enabled_type\r\n  ON automations(project_id, enabled, trigger_type)",
      "CREATE TABLE IF NOT EXISTS automation_delays (\r\n  id             TEXT PRIMARY KEY,\r\n  automation_id  TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,\r\n  project_id     TEXT NOT NULL REFERENCES projects(id)    ON DELETE CASCADE,\r\n  resume_node_id TEXT NOT NULL,\r\n  ctx            TEXT NOT NULL,                               \n  fire_at        INTEGER NOT NULL,                            \n  created_at     INTEGER NOT NULL\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_automation_delays_fire    ON automation_delays(fire_at)",
      "CREATE INDEX IF NOT EXISTS idx_automation_delays_project ON automation_delays(project_id)",
      "CREATE TABLE IF NOT EXISTS integrations (\r\n  id          TEXT PRIMARY KEY,\r\n  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\r\n  name        TEXT NOT NULL,\r\n  kind        TEXT NOT NULL,\r\n  config      TEXT NOT NULL,                                   \n  enabled     INTEGER NOT NULL DEFAULT 1,\r\n  created_by  TEXT REFERENCES users(id),\r\n  created_at  INTEGER NOT NULL,\r\n  updated_at  INTEGER NOT NULL,\r\n  archived_at INTEGER,\r\n  last_run_at     INTEGER,                                     \n  last_run_status TEXT CHECK (last_run_status IN ('ok','error','skipped')),\r\n  last_error      TEXT\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_integrations_project ON integrations(project_id)",
      "CREATE TABLE IF NOT EXISTS audit_log (\r\n  id          INTEGER PRIMARY KEY AUTOINCREMENT,\r\n  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,\r\n  user_id     TEXT REFERENCES users(id)   ON DELETE SET NULL,\r\n  action      TEXT NOT NULL,                                   \n  target_type TEXT,\r\n  target_id   TEXT,\r\n  metadata    TEXT,                                            \n  created_at  INTEGER NOT NULL\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_project ON audit_log(project_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_target  ON audit_log(target_type, target_id)",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_user    ON audit_log(user_id)",
      "CREATE TABLE IF NOT EXISTS deployment_settings (\r\n  key        TEXT PRIMARY KEY,\r\n  value      TEXT NOT NULL,\r\n  updated_at INTEGER NOT NULL\r\n)",
      "CREATE TABLE IF NOT EXISTS invites (\r\n  id            TEXT PRIMARY KEY,                              \n  email         TEXT,                                          \n  instance_role TEXT NOT NULL CHECK (instance_role IN ('admin','member')),\r\n  token_hash    TEXT NOT NULL UNIQUE,                          \n  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,\r\n  created_at    INTEGER NOT NULL,\r\n  expires_at    INTEGER                                        \n)",
      "CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email) WHERE email IS NOT NULL",
      "CREATE TABLE IF NOT EXISTS invite_projects (\r\n  invite_id  TEXT NOT NULL REFERENCES invites(id) ON DELETE CASCADE,\r\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\r\n  PRIMARY KEY (invite_id, project_id)\r\n)"
    ]
  },
  {
    "name": "0002_devices",
    "statements": [
      "CREATE TABLE IF NOT EXISTS devices (\r\n  id               TEXT PRIMARY KEY,\r\n  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\r\n  name             TEXT NOT NULL,\r\n  device_key       TEXT,\r\n  chip             TEXT,\r\n  firmware_version TEXT,\r\n  is_default       INTEGER NOT NULL DEFAULT 0,\r\n  first_seen       INTEGER,\r\n  last_seen        INTEGER,\r\n  created_at       INTEGER NOT NULL\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_devices_project ON devices(project_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_key\r\n  ON devices(project_id, device_key) WHERE device_key IS NOT NULL",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_default\r\n  ON devices(project_id) WHERE is_default = 1",
      "INSERT INTO devices (id, project_id, name, is_default, created_at)\r\nSELECT 'dev_' || substr(p.id, 5), p.id, 'Default', 1, p.created_at\r\nFROM projects p\r\nWHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.project_id = p.id AND d.is_default = 1)",
      "CREATE TABLE project_variables_new (\r\n  id          TEXT PRIMARY KEY,\r\n  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\r\n  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,\r\n  key         TEXT NOT NULL,\r\n  unit        TEXT,\r\n  created_at  INTEGER NOT NULL,\r\n  updated_at  INTEGER NOT NULL,\r\n  last_seen   INTEGER\r\n)",
      "INSERT INTO project_variables_new (id, project_id, device_id, key, unit, created_at, updated_at, last_seen)\r\nSELECT v.id, v.project_id, d.id, v.key, v.unit, v.created_at, v.updated_at, v.last_seen\r\nFROM project_variables v\r\nJOIN devices d ON d.project_id = v.project_id AND d.is_default = 1",
      "DROP TABLE project_variables",
      "ALTER TABLE project_variables_new RENAME TO project_variables",
      "CREATE UNIQUE INDEX idx_project_variables_key\r\n  ON project_variables(project_id, device_id, key)",
      "CREATE TABLE IF NOT EXISTS firmware (\r\n  id          TEXT PRIMARY KEY,\r\n  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\r\n  version     TEXT NOT NULL,\r\n  target      TEXT,\r\n  size        INTEGER NOT NULL,\r\n  sha256      TEXT NOT NULL,\r\n  r2_key      TEXT NOT NULL,\r\n  notes       TEXT,\r\n  created_by  TEXT REFERENCES users(id),\r\n  created_at  INTEGER NOT NULL\r\n)",
      "CREATE INDEX IF NOT EXISTS idx_firmware_project ON firmware(project_id, created_at DESC)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_firmware_version ON firmware(project_id, version)",
      "ALTER TABLE devices ADD COLUMN desired_firmware_id TEXT REFERENCES firmware(id) ON DELETE SET NULL",
      "ALTER TABLE devices ADD COLUMN ota_status TEXT",
      "ALTER TABLE devices ADD COLUMN ota_updated_at INTEGER"
    ]
  },
  {
    "name": "0003_external_sources",
    "statements": [
      "CREATE TABLE IF NOT EXISTS external_sources (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  name TEXT NOT NULL,\n  url TEXT NOT NULL,\n  device_key TEXT NOT NULL,\n  interval_minutes INTEGER NOT NULL DEFAULT 5,\n  envelope_path TEXT NOT NULL DEFAULT '',\n  fields TEXT NOT NULL DEFAULT '[]',\n  cursor_field TEXT NOT NULL DEFAULT 'id',\n  sentinel_map TEXT NOT NULL DEFAULT '{}',\n  headers TEXT NOT NULL DEFAULT '',\n  enabled INTEGER NOT NULL DEFAULT 1,\n  last_cursor TEXT,\n  last_run_at INTEGER,\n  last_run_status TEXT CHECK (last_run_status IN ('ok','error','skipped')),\n  last_error TEXT,\n  created_by TEXT REFERENCES users(id),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  archived_at INTEGER\n)",
      "CREATE INDEX IF NOT EXISTS idx_external_sources_project ON external_sources(project_id)",
      "CREATE INDEX IF NOT EXISTS idx_external_sources_poll ON external_sources(enabled, archived_at)"
    ]
  }
];
