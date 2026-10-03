-- Attendance/Revenue Hunter v6.
-- Contexto lateral para enriquecer buscas sem ALTER TABLE não idempotente.
CREATE TABLE IF NOT EXISTS postgame_match_context (
  event_id TEXT PRIMARY KEY,
  round INTEGER,
  stadium TEXT NOT NULL DEFAULT '',
  source_updated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_postgame_context_round ON postgame_match_context(round);
