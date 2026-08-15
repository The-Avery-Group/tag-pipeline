CREATE TABLE IF NOT EXISTS opportunity_alerts (
  opportunity_key TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  acknowledged_fingerprint TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL,
  acknowledged_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (opportunity_key, alert_type)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_alerts_status_updated
  ON opportunity_alerts (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS opportunity_alert_events (
  id TEXT PRIMARY KEY,
  opportunity_key TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  notification_status TEXT NOT NULL DEFAULT 'pending',
  occurred_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunity_alert_events_fingerprint
  ON opportunity_alert_events (opportunity_key, alert_type, fingerprint);

CREATE INDEX IF NOT EXISTS idx_opportunity_alert_events_notification
  ON opportunity_alert_events (notification_status, occurred_at DESC);
