CREATE TABLE IF NOT EXISTS sam_archives (
  opportunity_key TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL DEFAULT '',
  solicitation_number TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  agency TEXT NOT NULL DEFAULT '',
  review_state TEXT NOT NULL DEFAULT 'new',
  archive_status TEXT NOT NULL DEFAULT 'new',
  progress_phase TEXT NOT NULL DEFAULT 'Waiting to archive',
  workflow_instance_id TEXT,
  sharepoint_drive_id TEXT,
  sharepoint_folder_id TEXT,
  sharepoint_web_url TEXT,
  attachment_total INTEGER NOT NULL DEFAULT 0,
  archived_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  purge_after TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sam_archives_retention
  ON sam_archives(review_state, purge_after);

CREATE TABLE IF NOT EXISTS sam_archive_files (
  id TEXT PRIMARY KEY,
  opportunity_key TEXT NOT NULL,
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
  FOREIGN KEY (opportunity_key) REFERENCES sam_archives(opportunity_key) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sam_archive_file_source
  ON sam_archive_files(opportunity_key, source_url);

CREATE INDEX IF NOT EXISTS idx_sam_archive_files_status
  ON sam_archive_files(opportunity_key, archive_status, updated_at DESC);

