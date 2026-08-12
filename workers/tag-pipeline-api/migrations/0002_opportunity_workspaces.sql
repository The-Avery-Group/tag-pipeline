CREATE TABLE IF NOT EXISTS opportunity_workspaces (
  opportunity_key TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  notice_id TEXT NOT NULL DEFAULT '',
  solicitation_number TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  agency TEXT NOT NULL DEFAULT '',
  notice_type TEXT NOT NULL DEFAULT '',
  calendar_year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  progress_phase TEXT NOT NULL DEFAULT 'Waiting to start',
  workflow_instance_id TEXT,
  sharepoint_drive_id TEXT,
  root_folder_id TEXT,
  sam_folder_id TEXT,
  sharepoint_web_url TEXT,
  attachment_total INTEGER NOT NULL DEFAULT 0,
  archived_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_opportunity_workspaces_status
  ON opportunity_workspaces(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS opportunity_workspace_files (
  id TEXT PRIMARY KEY,
  opportunity_key TEXT NOT NULL,
  source_notice_id TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size INTEGER,
  source_signature TEXT NOT NULL DEFAULT '',
  archive_status TEXT NOT NULL DEFAULT 'pending',
  sharepoint_drive_id TEXT,
  sharepoint_item_id TEXT,
  sharepoint_web_url TEXT,
  archived_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (opportunity_key) REFERENCES opportunity_workspaces(opportunity_key) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunity_workspace_file_source
  ON opportunity_workspace_files(opportunity_key, source_url);

CREATE INDEX IF NOT EXISTS idx_opportunity_workspace_files_opportunity
  ON opportunity_workspace_files(opportunity_key, archive_status, updated_at DESC);
