PRAGMA foreign_keys = ON;

-- Preferências v2: migração idempotente. INSERT OR IGNORE copia cada instalação
-- existente apenas na primeira execução e preserva escolhas posteriores.
CREATE TABLE IF NOT EXISTS push_preferences_v2 (
  installation_id TEXT PRIMARY KEY,
  goals INTEGER NOT NULL DEFAULT 1 CHECK (goals IN (0,1)),
  overturned_goals INTEGER NOT NULL DEFAULT 1 CHECK (overturned_goals IN (0,1)),
  prematch_15 INTEGER NOT NULL DEFAULT 1 CHECK (prematch_15 IN (0,1)),
  final_whistle INTEGER NOT NULL DEFAULT 1 CHECK (final_whistle IN (0,1)),
  schedule_changes INTEGER NOT NULL DEFAULT 1 CHECK (schedule_changes IN (0,1)),
  shootout_alerts INTEGER NOT NULL DEFAULT 1 CHECK (shootout_alerts IN (0,1)),
  qualification_alerts INTEGER NOT NULL DEFAULT 1 CHECK (qualification_alerts IN (0,1)),
  all_games INTEGER NOT NULL DEFAULT 0 CHECK (all_games IN (0,1)),
  teams_json TEXT NOT NULL DEFAULT '[]',
  games_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO push_preferences_v2 (
  installation_id, goals, overturned_goals, prematch_15, final_whistle,
  schedule_changes, shootout_alerts, qualification_alerts,
  all_games, teams_json, games_json, created_at, updated_at
)
SELECT
  installation_id, goals, overturned_goals, 1, 1, 1, 1, 1,
  all_games, teams_json, games_json, created_at, updated_at
FROM push_preferences;

-- Eventos não relacionados a gol ficam em tabela própria para manter o corpus
-- histórico de gols e o CHECK original de sports_events intactos.
CREATE TABLE IF NOT EXISTS match_events (
  event_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'prematch_15', 'final_whistle', 'schedule_changed', 'match_postponed',
    'shootout_start', 'qualification'
  )),
  confirmed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_match_events_event_id_created
  ON match_events(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_events_type_created
  ON match_events(event_type, created_at DESC);
