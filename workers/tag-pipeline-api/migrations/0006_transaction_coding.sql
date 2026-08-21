CREATE TABLE IF NOT EXISTS transaction_coding_batches (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  imported_by TEXT NOT NULL DEFAULT '',
  row_count INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  uncategorized_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_coding_batches_hash
  ON transaction_coding_batches(file_hash);

CREATE INDEX IF NOT EXISTS idx_transaction_coding_batches_retention
  ON transaction_coding_batches(expires_at);

CREATE TABLE IF NOT EXISTS transaction_coding_transactions (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  transaction_date TEXT NOT NULL DEFAULT '',
  raw_description TEXT NOT NULL DEFAULT '',
  normalized_merchant TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  direction TEXT NOT NULL DEFAULT 'charge',
  vendor TEXT NOT NULL DEFAULT '',
  vendor_id TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uncategorized',
  rule_id TEXT,
  confidence TEXT NOT NULL DEFAULT 'none',
  exported_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES transaction_coding_batches(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_coding_transactions_source
  ON transaction_coding_transactions(batch_id, source_hash);

CREATE INDEX IF NOT EXISTS idx_transaction_coding_transactions_batch_status
  ON transaction_coding_transactions(batch_id, status, transaction_date DESC);

CREATE TABLE IF NOT EXISTS transaction_coding_rules (
  id TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  match_type TEXT NOT NULL DEFAULT 'contains',
  match_pattern TEXT NOT NULL,
  merchant TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  vendor_id TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'workbook',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transaction_coding_rules_match
  ON transaction_coding_rules(active, priority DESC, match_pattern);

CREATE TABLE IF NOT EXISTS transaction_coding_exports (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  csv_text TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  sharepoint_drive_id TEXT,
  sharepoint_item_id TEXT,
  sharepoint_web_url TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES transaction_coding_batches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transaction_coding_exports_retention
  ON transaction_coding_exports(expires_at, created_at DESC);

CREATE TABLE IF NOT EXISTS transaction_coding_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sharepoint_drive_id TEXT,
  sharepoint_folder_id TEXT,
  sharepoint_folder_url TEXT,
  workbook_item_id TEXT,
  workbook_url TEXT,
  exports_folder_id TEXT,
  rules_synced_at TEXT,
  updated_at TEXT NOT NULL
);
