CREATE TABLE IF NOT EXISTS ebuy_connections (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username_masked TEXT NOT NULL DEFAULT '',
  credentials_encrypted TEXT NOT NULL,
  session_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  contracts_json TEXT NOT NULL DEFAULT '[]',
  last_authenticated_at TEXT,
  last_sync_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  connected_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ebuy_sync_candidates (
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  contract_number TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, request_id),
  FOREIGN KEY (run_id) REFERENCES ebuy_sync_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ebuy_sync_candidates_pending
  ON ebuy_sync_candidates(run_id, status, created_at);

