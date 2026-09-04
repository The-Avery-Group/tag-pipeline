CREATE TABLE IF NOT EXISTS sam_dismissal_tombstones (
  opportunity_key TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL DEFAULT '',
  solicitation_number TEXT NOT NULL DEFAULT '',
  dismissed_at TEXT NOT NULL,
  purged_at TEXT,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sam_dismissal_tombstones_notice
  ON sam_dismissal_tombstones(notice_id);

CREATE INDEX IF NOT EXISTS idx_sam_dismissal_tombstones_solicitation
  ON sam_dismissal_tombstones(solicitation_number);

INSERT OR IGNORE INTO sam_dismissal_tombstones (
  opportunity_key, notice_id, solicitation_number, dismissed_at, expires_at
)
SELECT opportunity_key, lower(notice_id), lower(solicitation_number), updated_at, NULL
FROM sam_archives
WHERE review_state = 'dismissed';
