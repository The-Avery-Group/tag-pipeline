CREATE TABLE IF NOT EXISTS ebuy_opportunities (
  request_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  request_type TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  reference_number TEXT NOT NULL DEFAULT '',
  buyer_agency TEXT NOT NULL DEFAULT '',
  buyer_department TEXT NOT NULL DEFAULT '',
  buyer_name TEXT NOT NULL DEFAULT '',
  buyer_email TEXT NOT NULL DEFAULT '',
  buyer_phone TEXT NOT NULL DEFAULT '',
  set_aside_type TEXT NOT NULL DEFAULT '',
  contract_type TEXT NOT NULL DEFAULT '',
  award_method TEXT NOT NULL DEFAULT '',
  place_of_performance TEXT NOT NULL DEFAULT '',
  performance_states_json TEXT NOT NULL DEFAULT '[]',
  vehicle_sources_json TEXT NOT NULL DEFAULT '[]',
  vehicle_sins_json TEXT NOT NULL DEFAULT '[]',
  vehicle_pairs_json TEXT NOT NULL DEFAULT '[]',
  posted_at TEXT,
  closes_at TEXT,
  source_last_seen_at TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  review_state TEXT NOT NULL DEFAULT 'new',
  content_hash TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  removed_at TEXT,
  purge_after TEXT,
  pipeline_contract_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ebuy_opportunities_posted ON ebuy_opportunities(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_ebuy_opportunities_closes ON ebuy_opportunities(closes_at DESC);
CREATE INDEX IF NOT EXISTS idx_ebuy_opportunities_state ON ebuy_opportunities(review_state, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_ebuy_opportunities_agency ON ebuy_opportunities(buyer_agency);

CREATE TABLE IF NOT EXISTS ebuy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL DEFAULT '[]',
  captured_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES ebuy_opportunities(request_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ebuy_versions_request ON ebuy_versions(request_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS ebuy_amendments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  posted_at TEXT,
  source_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES ebuy_opportunities(request_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ebuy_amendments_request ON ebuy_amendments(request_id, posted_at DESC);

CREATE TABLE IF NOT EXISTS ebuy_attachments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  amendment_id TEXT,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size INTEGER,
  source_url TEXT,
  source_hash TEXT,
  archive_status TEXT NOT NULL DEFAULT 'pending',
  sharepoint_drive_id TEXT,
  sharepoint_item_id TEXT,
  sharepoint_web_url TEXT,
  archived_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES ebuy_opportunities(request_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ebuy_attachments_request ON ebuy_attachments(request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ebuy_sync_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  archived_file_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ebuy_sync_runs_started ON ebuy_sync_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS ebuy_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dismissed_retention_days INTEGER NOT NULL DEFAULT 30,
  expired_retention_days INTEGER NOT NULL DEFAULT 90,
  unavailable_retention_days INTEGER NOT NULL DEFAULT 30,
  archive_folder_name TEXT NOT NULL DEFAULT 'TAG CRM/eBuy Archive',
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO ebuy_settings (id, updated_at) VALUES (1, CURRENT_TIMESTAMP);
