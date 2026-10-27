-- Hunter: timestamps verificáveis e diagnóstico de fontes por partida.
-- Migração idempotente: deploy executa os SQLs repetidamente.
CREATE TABLE IF NOT EXISTS postgame_public_source_audit (
  event_id TEXT NOT NULL,
  url TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  first_checked_at TEXT,
  last_checked_at TEXT,
  published_at TEXT,
  first_accepted_at TEXT,
  check_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  last_outcome TEXT NOT NULL DEFAULT '',
  last_reason TEXT NOT NULL DEFAULT '',
  accepted_fields TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, url)
);
CREATE INDEX IF NOT EXISTS idx_postgame_source_audit_event ON postgame_public_source_audit(event_id, first_accepted_at);

CREATE TABLE IF NOT EXISTS postgame_public_resolution_audit (
  event_id TEXT PRIMARY KEY,
  first_observed_resolved_at TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_postgame_public_resolution_first ON postgame_public_resolution_audit(first_observed_resolved_at);
