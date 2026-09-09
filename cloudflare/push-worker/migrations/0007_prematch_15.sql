PRAGMA foreign_keys = ON;

-- Extensão idempotente da preferência v3 para o lembrete T-15.
-- Tabela separada evita ALTER TABLE não idempotente, pois o workflow reaplica
-- todas as migrations em cada deploy. Ausência de linha significa habilitado.
CREATE TABLE IF NOT EXISTS push_reminder_preferences (
  installation_id TEXT PRIMARY KEY,
  prematch_15 INTEGER NOT NULL DEFAULT 1 CHECK (prematch_15 IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_push_reminder_prematch15
  ON push_reminder_preferences(prematch_15, updated_at DESC);

-- Preserva a escolha histórica de quem já usava o antigo lembrete T-15.
-- INSERT OR IGNORE mantém a migration idempotente em todos os redeploys.
INSERT OR IGNORE INTO push_reminder_preferences (
  installation_id, prematch_15, created_at, updated_at
)
SELECT installation_id, prematch_15, created_at, updated_at
FROM push_preferences_v2;
