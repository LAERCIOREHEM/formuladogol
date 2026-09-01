PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ops_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_push_deliveries_status_updated
  ON push_deliveries(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_push_event_dispatch_status_updated
  ON push_event_dispatch(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_sports_events_confirmed_at
  ON sports_events(confirmed_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_active_updated
  ON push_subscriptions(active, updated_at);
