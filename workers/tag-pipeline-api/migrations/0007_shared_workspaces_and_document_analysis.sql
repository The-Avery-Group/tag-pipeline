CREATE TABLE IF NOT EXISTS opportunity_workspace_groups (
  group_id TEXT PRIMARY KEY,
  canonical_opportunity_key TEXT NOT NULL,
  sharepoint_drive_id TEXT,
  root_folder_id TEXT,
  sharepoint_web_url TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunity_workspace_members (
  opportunity_key TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  workspace_type TEXT NOT NULL,
  type_folder_id TEXT,
  type_folder_web_url TEXT,
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (opportunity_key) REFERENCES opportunity_workspaces(opportunity_key) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES opportunity_workspace_groups(group_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_opportunity_workspace_members_group
  ON opportunity_workspace_members(group_id, workspace_type, joined_at);

CREATE TABLE IF NOT EXISTS opportunity_document_analysis (
  id TEXT PRIMARY KEY,
  opportunity_key TEXT NOT NULL,
  sharepoint_drive_id TEXT NOT NULL,
  sharepoint_item_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'opportunity',
  source_service TEXT NOT NULL DEFAULT '',
  source_signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  extracted_text TEXT NOT NULL DEFAULT '',
  requirements_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  error_message TEXT,
  analyzed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(opportunity_key, sharepoint_item_id)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_document_analysis_status
  ON opportunity_document_analysis(opportunity_key, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS past_performance_documents (
  id TEXT PRIMARY KEY,
  sharepoint_drive_id TEXT NOT NULL,
  sharepoint_item_id TEXT NOT NULL UNIQUE,
  service_category TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL DEFAULT '',
  source_signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  extracted_text TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  analyzed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_past_performance_documents_category
  ON past_performance_documents(service_category, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS opportunity_past_performance_matches (
  opportunity_key TEXT NOT NULL,
  past_performance_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (opportunity_key, past_performance_id),
  FOREIGN KEY (past_performance_id) REFERENCES past_performance_documents(id) ON DELETE CASCADE
);
