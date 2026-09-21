-- Política v3 de público/renda do postgame fastlane.
-- Tabela lateral em vez de ALTER TABLE: o workflow de deploy reaplica TODAS as
-- migrations em cada execução (d1 execute --file), e ALTER TABLE ADD COLUMN
-- falharia com "duplicate column" a partir do segundo deploy.
-- Ausência de linha = nenhuma tentativa registrada ainda.
CREATE TABLE IF NOT EXISTS postgame_public_ai (
  event_id TEXT PRIMARY KEY,
  deterministic_checks INTEGER NOT NULL DEFAULT 0,
  mini_attempts INTEGER NOT NULL DEFAULT 0,
  sol_attempts INTEGER NOT NULL DEFAULT 0,
  sol_completed INTEGER NOT NULL DEFAULT 0 CHECK (sol_completed IN (0,1)),
  last_phase TEXT NOT NULL DEFAULT '',
  last_model TEXT NOT NULL DEFAULT '',
  mini_last_error TEXT NOT NULL DEFAULT '',
  alert_at TEXT,
  alert_status TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_postgame_public_ai_alert ON postgame_public_ai(alert_at);
