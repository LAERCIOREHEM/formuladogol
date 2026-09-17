CREATE TABLE IF NOT EXISTS live_stats_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_live_stats_cache_expires_at
  ON live_stats_cache(expires_at);

CREATE TABLE IF NOT EXISTS live_stats_leases (
  lease_key TEXT PRIMARY KEY,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_football_budget (
  day_utc TEXT PRIMARY KEY,
  reserved_calls INTEGER NOT NULL DEFAULT 0,
  known_remaining INTEGER,
  known_limit INTEGER,
  updated_at INTEGER NOT NULL
);
