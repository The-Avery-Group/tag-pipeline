CREATE TABLE IF NOT EXISTS crm_runtime_state (
  state_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT 'null',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_runtime_state_category
  ON crm_runtime_state(category, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_runtime_state_expiry
  ON crm_runtime_state(expires_at)
  WHERE expires_at IS NOT NULL;
