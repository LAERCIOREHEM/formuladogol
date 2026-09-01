PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time INTEGER,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_failure_status INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_installation
  ON push_subscriptions (installation_id, active);

CREATE TABLE IF NOT EXISTS push_preferences (
  installation_id TEXT PRIMARY KEY,
  goals INTEGER NOT NULL DEFAULT 1 CHECK (goals IN (0,1)),
  overturned_goals INTEGER NOT NULL DEFAULT 1 CHECK (overturned_goals IN (0,1)),
  final_whistle INTEGER NOT NULL DEFAULT 0 CHECK (final_whistle IN (0,1)),
  all_games INTEGER NOT NULL DEFAULT 0 CHECK (all_games IN (0,1)),
  teams_json TEXT NOT NULL DEFAULT '[]',
  games_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id TEXT,
  subscription_id TEXT,
  event_type TEXT NOT NULL,
  status INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_push_audit_created_at
  ON push_audit (created_at);
