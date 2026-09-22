-- Health Monitor + telemetria de uso de IA. Idempotente: o deploy reaplica migrations.
CREATE TABLE IF NOT EXISTS ai_usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  purpose TEXT NOT NULL,
  event_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT '',
  web_search_calls INTEGER NOT NULL DEFAULT 0,
  responded INTEGER NOT NULL DEFAULT 0 CHECK (responded IN (0,1)),
  ok INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0,1)),
  http_status INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_event ON ai_usage_ledger(event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_purpose ON ai_usage_ledger(purpose, created_at);

CREATE TABLE IF NOT EXISTS health_monitor_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS health_incidents (
  incident_key TEXT PRIMARY KEY,
  indicator TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  detail TEXT NOT NULL DEFAULT '',
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  first_email_at TEXT,
  recovery_email_at TEXT,
  email_status TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_health_incidents_status ON health_incidents(status, last_seen_at);
