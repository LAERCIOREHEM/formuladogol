PRAGMA foreign_keys = ON;

-- Preferências v3: somente os cinco alertas públicos definidos para o produto.
-- Mantemos v1/v2 intactas como histórico de migração; o código passa a ler/gravar v3.
CREATE TABLE IF NOT EXISTS push_preferences_v3 (
  installation_id TEXT PRIMARY KEY,
  goals INTEGER NOT NULL DEFAULT 1 CHECK (goals IN (0,1)),
  red_cards INTEGER NOT NULL DEFAULT 1 CHECK (red_cards IN (0,1)),
  lineups INTEGER NOT NULL DEFAULT 1 CHECK (lineups IN (0,1)),
  match_start INTEGER NOT NULL DEFAULT 1 CHECK (match_start IN (0,1)),
  final_whistle INTEGER NOT NULL DEFAULT 1 CHECK (final_whistle IN (0,1)),
  all_games INTEGER NOT NULL DEFAULT 0 CHECK (all_games IN (0,1)),
  teams_json TEXT NOT NULL DEFAULT '[]',
  games_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO push_preferences_v3 (
  installation_id, goals, red_cards, lineups, match_start, final_whistle,
  all_games, teams_json, games_json, created_at, updated_at
)
SELECT
  installation_id, goals, 1, 1, 1, final_whistle,
  all_games, teams_json, games_json, created_at, updated_at
FROM push_preferences_v2;

-- Eventos essenciais não-gol. Gols continuam em sports_events para preservar
-- toda a lógica anti-VAR e o histórico já existente.
CREATE TABLE IF NOT EXISTS essential_match_events (
  event_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'red_card', 'lineup_confirmed', 'match_start', 'final_whistle'
  )),
  confirmed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_essential_events_event_id_created
  ON essential_match_events(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_essential_events_type_created
  ON essential_match_events(event_type, created_at DESC);

-- Auditoria T-30/T-10/T+3 do monitor. Uma linha por checkpoint permite entender
-- por que um jogo não estava pronto antes da bola rolar, sem depender de logs efêmeros.
CREATE TABLE IF NOT EXISTS monitor_preflight (
  event_id TEXT NOT NULL,
  checkpoint TEXT NOT NULL CHECK (checkpoint IN ('t30','t10','tplus3')),
  league TEXT NOT NULL,
  kickoff TEXT NOT NULL,
  readiness TEXT NOT NULL CHECK (readiness IN ('green','red')),
  source_event_id TEXT,
  resolution_strategy TEXT,
  source_state TEXT,
  teams_ok INTEGER NOT NULL DEFAULT 0 CHECK (teams_ok IN (0,1)),
  monitor_initialized INTEGER NOT NULL DEFAULT 0 CHECK (monitor_initialized IN (0,1)),
  audience_json TEXT NOT NULL DEFAULT '{}',
  reasons_json TEXT NOT NULL DEFAULT '[]',
  ai_attempted INTEGER NOT NULL DEFAULT 0 CHECK (ai_attempted IN (0,1)),
  ai_recovered INTEGER NOT NULL DEFAULT 0 CHECK (ai_recovered IN (0,1)),
  checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, checkpoint)
);

CREATE INDEX IF NOT EXISTS idx_monitor_preflight_readiness
  ON monitor_preflight(readiness, updated_at DESC);

CREATE TABLE IF NOT EXISTS monitor_incidents (
  incident_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',
  detail TEXT NOT NULL,
  email_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
