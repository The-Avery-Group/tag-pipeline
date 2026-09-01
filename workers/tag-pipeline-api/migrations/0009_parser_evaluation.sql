CREATE TABLE IF NOT EXISTS parser_evaluation_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  progress_phase TEXT NOT NULL DEFAULT 'Selecting representative documents',
  requested_by TEXT NOT NULL DEFAULT '',
  sample_opportunities INTEGER NOT NULL DEFAULT 10,
  files_per_opportunity INTEGER NOT NULL DEFAULT 4,
  total_opportunities INTEGER NOT NULL DEFAULT 0,
  total_documents INTEGER NOT NULL DEFAULT 0,
  processed_documents INTEGER NOT NULL DEFAULT 0,
  successful_documents INTEGER NOT NULL DEFAULT 0,
  failed_documents INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  workflow_instance_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_parser_evaluation_runs_created
  ON parser_evaluation_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS parser_evaluation_documents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  opportunity_key TEXT NOT NULL,
  opportunity_title TEXT NOT NULL DEFAULT '',
  source_service TEXT NOT NULL DEFAULT '',
  sharepoint_drive_id TEXT NOT NULL,
  sharepoint_item_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  existing_artifact_key TEXT,
  cloudflare_artifact_key TEXT,
  existing_preview TEXT NOT NULL DEFAULT '',
  cloudflare_preview TEXT NOT NULL DEFAULT '',
  existing_metrics_json TEXT NOT NULL DEFAULT '{}',
  cloudflare_metrics_json TEXT NOT NULL DEFAULT '{}',
  comparison_json TEXT NOT NULL DEFAULT '{}',
  review_decision TEXT NOT NULL DEFAULT '',
  review_notes TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, sharepoint_drive_id, sharepoint_item_id),
  FOREIGN KEY (run_id) REFERENCES parser_evaluation_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_parser_evaluation_documents_run
  ON parser_evaluation_documents(run_id, status, opportunity_key, file_name);
