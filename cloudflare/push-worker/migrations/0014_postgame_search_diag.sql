-- Attendance/Revenue Hunter v8 — telemetria persistente de busca real.
-- Tabela lateral para manter migrations idempotentes e separar contadores
-- lógicos (mini_attempts/sol_attempts) de chamadas reais aos provedores.
CREATE TABLE IF NOT EXISTS postgame_public_search_diag (
  event_id TEXT PRIMARY KEY,
  gemini_api_calls INTEGER NOT NULL DEFAULT 0,
  gemini_search_calls INTEGER NOT NULL DEFAULT 0,
  gemini_sources_found INTEGER NOT NULL DEFAULT 0,
  gemini_last_route TEXT NOT NULL DEFAULT '',
  gemini_last_http_status INTEGER,
  gemini_last_result TEXT NOT NULL DEFAULT '',
  gemini_last_error TEXT NOT NULL DEFAULT '',
  openai_api_calls INTEGER NOT NULL DEFAULT 0,
  openai_search_calls INTEGER NOT NULL DEFAULT 0,
  openai_sources_found INTEGER NOT NULL DEFAULT 0,
  openai_last_route TEXT NOT NULL DEFAULT '',
  openai_last_http_status INTEGER,
  openai_last_result TEXT NOT NULL DEFAULT '',
  openai_last_error TEXT NOT NULL DEFAULT '',
  last_provider TEXT NOT NULL DEFAULT '',
  last_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_postgame_search_diag_last_at ON postgame_public_search_diag(last_at);
