ALTER TABLE opportunity_document_analysis ADD COLUMN critical_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE opportunity_document_analysis ADD COLUMN analysis_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS opportunity_analysis_jobs (
  opportunity_key TEXT PRIMARY KEY,
  source_service TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  progress_phase TEXT NOT NULL DEFAULT 'Waiting for archived documents',
  processed_files INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  package_analysis_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opportunity_analysis_jobs_queue
  ON opportunity_analysis_jobs(status, priority DESC, updated_at);

CREATE TABLE IF NOT EXISTS opportunity_analysis_reviews (
  opportunity_key TEXT NOT NULL,
  finding_key TEXT NOT NULL,
  review_status TEXT NOT NULL,
  corrected_text TEXT,
  reviewed_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (opportunity_key, finding_key)
);

INSERT OR IGNORE INTO opportunity_analysis_jobs
  (opportunity_key, source_service, status, priority, progress_phase, created_at, updated_at)
SELECT DISTINCT o.request_id, 'ebuy', 'queued',
  CASE WHEN o.review_state IN ('tracked', 'added_to_pipeline') THEN 100 ELSE 10 END,
  'Waiting for archived documents', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM ebuy_opportunities o
JOIN ebuy_attachments a ON a.request_id = o.request_id
WHERE o.review_state != 'dismissed' AND a.archive_status = 'archived';

INSERT OR IGNORE INTO opportunity_analysis_jobs
  (opportunity_key, source_service, status, priority, progress_phase, created_at, updated_at)
SELECT DISTINCT s.opportunity_key, 'sam', 'queued', 10,
  'Waiting for archived documents', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM sam_archives s
JOIN sam_archive_files f ON f.opportunity_key = s.opportunity_key
WHERE s.review_state != 'dismissed' AND f.archive_status IN ('archived', 'moved');
