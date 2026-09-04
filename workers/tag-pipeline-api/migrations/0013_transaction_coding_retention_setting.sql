ALTER TABLE transaction_coding_settings ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 10;
ALTER TABLE transaction_coding_settings ADD COLUMN workbook_settings_synced_at TEXT;
