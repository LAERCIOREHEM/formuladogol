PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS push_event_dispatch (
  event_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','enqueued','expanded','failed')),
  enqueued_at TEXT,
  expanded_at TEXT,
  target_count INTEGER NOT NULL DEFAULT 0,
  batch_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_push_event_dispatch_status
  ON push_event_dispatch(status, updated_at);

CREATE TABLE IF NOT EXISTS push_deliveries (
  event_key TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','retry','sent','gone','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  PRIMARY KEY (event_key, subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_push_deliveries_status
  ON push_deliveries(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_push_deliveries_installation
  ON push_deliveries(installation_id, created_at DESC);
