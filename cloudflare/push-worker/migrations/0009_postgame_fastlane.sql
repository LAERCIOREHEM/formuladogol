CREATE TABLE IF NOT EXISTS postgame_fastlane (
  event_id TEXT PRIMARY KEY,
  league TEXT NOT NULL DEFAULT '',
  home TEXT NOT NULL DEFAULT '',
  away TEXT NOT NULL DEFAULT '',
  kickoff TEXT NOT NULL DEFAULT '',
  final_at TEXT NOT NULL DEFAULT '',
  home_score INTEGER,
  away_score INTEGER,
  publico INTEGER,
  publico_pagante INTEGER,
  renda REAL,
  public_sources_json TEXT,
  public_status TEXT NOT NULL DEFAULT 'pending',
  public_attempts INTEGER NOT NULL DEFAULT 0,
  public_next_at TEXT,
  public_last_at TEXT,
  public_last_error TEXT NOT NULL DEFAULT '',
  highlight_json TEXT,
  highlight_status TEXT NOT NULL DEFAULT 'pending',
  highlight_attempts INTEGER NOT NULL DEFAULT 0,
  highlight_next_at TEXT,
  highlight_last_at TEXT,
  highlight_last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_postgame_public_due ON postgame_fastlane(public_status, public_next_at);
CREATE INDEX IF NOT EXISTS idx_postgame_highlight_due ON postgame_fastlane(highlight_status, highlight_next_at);
CREATE INDEX IF NOT EXISTS idx_postgame_final_at ON postgame_fastlane(final_at DESC);

CREATE TABLE IF NOT EXISTS postgame_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
