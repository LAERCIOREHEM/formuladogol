-- Roteamento IA multi-provider + cache de fontes do pós-jogo. Idempotente.
CREATE TABLE IF NOT EXISTS ai_provider_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  provider TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  event_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT '',
  search_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  responded INTEGER NOT NULL DEFAULT 0 CHECK(responded IN (0,1)),
  ok INTEGER NOT NULL DEFAULT 0 CHECK(ok IN (0,1)),
  http_status INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ai_provider_created ON ai_provider_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_provider_provider ON ai_provider_ledger(provider,created_at);
CREATE INDEX IF NOT EXISTS idx_ai_provider_event ON ai_provider_ledger(event_id,created_at);

CREATE TABLE IF NOT EXISTS postgame_source_cache (
  event_id TEXT NOT NULL,
  url TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checked_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(event_id,url)
);
CREATE INDEX IF NOT EXISTS idx_postgame_source_event ON postgame_source_cache(event_id,last_checked_at);
