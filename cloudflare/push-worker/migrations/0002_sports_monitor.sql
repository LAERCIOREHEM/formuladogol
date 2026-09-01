CREATE TABLE IF NOT EXISTS sports_events (
  event_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('goal', 'goal_overturned')),
  source_play_key TEXT NOT NULL,
  league TEXT NOT NULL,
  competition_key TEXT,
  competition_name TEXT,
  home_team_id TEXT,
  home_team_name TEXT NOT NULL,
  away_team_id TEXT,
  away_team_name TEXT NOT NULL,
  scoring_team_id TEXT,
  scoring_team_name TEXT,
  athlete_id TEXT,
  athlete_name TEXT,
  minute TEXT,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  own_goal INTEGER NOT NULL DEFAULT 0 CHECK (own_goal IN (0,1)),
  penalty_goal INTEGER NOT NULL DEFAULT 0 CHECK (penalty_goal IN (0,1)),
  shootout INTEGER NOT NULL DEFAULT 0 CHECK (shootout IN (0,1)),
  detected_at TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sports_events_event_id_created
  ON sports_events(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sports_events_type_created
  ON sports_events(event_type, created_at DESC);
