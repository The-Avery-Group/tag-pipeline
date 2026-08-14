function clean(value) {
  return String(value || '').trim()
}

function publicAlert(row) {
  if (!row) return null
  let details = {}
  try { details = JSON.parse(row.details_json || '{}') } catch { details = {} }
  const acknowledged = row.status === 'active' && row.acknowledged_fingerprint === row.fingerprint
  return {
    opportunityKey: row.opportunity_key,
    type: row.alert_type,
    fingerprint: row.fingerprint,
    status: row.status,
    summary: row.summary,
    details,
    detectedAt: row.detected_at,
    acknowledgedAt: acknowledged ? row.acknowledged_at : null,
    badgeVisible: row.status === 'active' && !acknowledged,
  }
}

function stableHash(value) {
  let hash = 2166136261
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function alertFingerprint(value) {
  return stableHash(typeof value === 'string' ? value : JSON.stringify(value))
}

export async function alertStorageReady(db) {
  if (!db) return false
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'opportunity_alerts'").first()
  return Boolean(row)
}

export async function getOpportunityAlert(db, opportunityKey, type) {
  if (!db || !clean(opportunityKey) || !clean(type)) return null
  const row = await db.prepare('SELECT * FROM opportunity_alerts WHERE opportunity_key = ? AND alert_type = ?')
    .bind(clean(opportunityKey), clean(type)).first()
  return publicAlert(row)
}

export async function listOpportunityAlerts(db, opportunityKey = '') {
  if (!db) return []
  const key = clean(opportunityKey)
  const result = key
    ? await db.prepare('SELECT * FROM opportunity_alerts WHERE opportunity_key = ? ORDER BY updated_at DESC').bind(key).all()
    : await db.prepare("SELECT * FROM opportunity_alerts WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1000").all()
  return (result.results || []).map(publicAlert)
}

export async function upsertOpportunityAlert(db, input) {
  const opportunityKey = clean(input.opportunityKey)
  const type = clean(input.type)
  const fingerprint = clean(input.fingerprint)
  if (!db || !opportunityKey || !type || !fingerprint) return { changed: false, alert: null }
  const status = input.status === 'resolved' ? 'resolved' : 'active'
  const summary = clean(input.summary)
  const detailsJson = JSON.stringify(input.details || {})
  const previous = await db.prepare('SELECT * FROM opportunity_alerts WHERE opportunity_key = ? AND alert_type = ?')
    .bind(opportunityKey, type).first()
  if (
    previous && previous.fingerprint === fingerprint && previous.status === status &&
    previous.summary === summary && previous.details_json === detailsJson
  ) return { changed: false, alert: publicAlert(previous) }

  const now = new Date().toISOString()
  const isNewFingerprint = !previous || previous.fingerprint !== fingerprint
  await db.prepare(`INSERT INTO opportunity_alerts (
      opportunity_key, alert_type, fingerprint, acknowledged_fingerprint, status,
      summary, details_json, detected_at, acknowledged_at, updated_at
    ) VALUES (?, ?, ?, '', ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(opportunity_key, alert_type) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      acknowledged_fingerprint = CASE
        WHEN opportunity_alerts.fingerprint = excluded.fingerprint THEN opportunity_alerts.acknowledged_fingerprint
        ELSE ''
      END,
      status = excluded.status,
      summary = excluded.summary,
      details_json = excluded.details_json,
      detected_at = CASE
        WHEN opportunity_alerts.fingerprint = excluded.fingerprint THEN opportunity_alerts.detected_at
        ELSE excluded.detected_at
      END,
      acknowledged_at = CASE
        WHEN opportunity_alerts.fingerprint = excluded.fingerprint THEN opportunity_alerts.acknowledged_at
        ELSE NULL
      END,
      updated_at = excluded.updated_at`)
    .bind(opportunityKey, type, fingerprint, status, summary, detailsJson, now, now).run()

  if (status === 'active' && isNewFingerprint) {
    const eventId = `oa_${stableHash(`${opportunityKey}|${type}|${fingerprint}`)}`
    await db.prepare(`INSERT OR IGNORE INTO opportunity_alert_events (
        id, opportunity_key, alert_type, fingerprint, summary, details_json, notification_status, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(eventId, opportunityKey, type, fingerprint, summary, detailsJson, now).run()
  }
  return { changed: true, alert: await getOpportunityAlert(db, opportunityKey, type) }
}

export async function acknowledgeOpportunityAlert(db, opportunityKey, type, fingerprint = '') {
  const current = await getOpportunityAlert(db, opportunityKey, type)
  if (!current || current.status !== 'active') return current
  if (fingerprint && fingerprint !== current.fingerprint) return current
  const now = new Date().toISOString()
  await db.prepare(`UPDATE opportunity_alerts
      SET acknowledged_fingerprint = fingerprint, acknowledged_at = ?, updated_at = ?
      WHERE opportunity_key = ? AND alert_type = ?`)
    .bind(now, now, clean(opportunityKey), clean(type)).run()
  return getOpportunityAlert(db, opportunityKey, type)
}

export async function resolveOpportunityAlert(db, opportunityKey, type, fingerprint = 'resolved') {
  return upsertOpportunityAlert(db, {
    opportunityKey,
    type,
    fingerprint,
    status: 'resolved',
    summary: '',
    details: {},
  })
}

export async function purgeOldOpportunityAlertEvents(db, retentionDays = 180) {
  if (!db || !(await alertStorageReady(db))) return { deleted: 0 }
  const cutoff = new Date(Date.now() - Math.max(30, Number(retentionDays) || 180) * 86400000).toISOString()
  const result = await db.prepare('DELETE FROM opportunity_alert_events WHERE occurred_at < ?').bind(cutoff).run()
  return { deleted: Number(result.meta?.changes || 0) }
}
