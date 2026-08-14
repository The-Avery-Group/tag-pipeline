import {
  changedEbuyFields,
  hashEbuyOpportunity,
  lifecycleForEbuyOpportunity,
  normalizeEbuyOpportunity,
  retentionDeadline,
} from './ebuyDomain.js'

function encode(value) { return JSON.stringify(value ?? null) }
function decode(value, fallback) {
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function publicOpportunity(row) {
  if (!row) return null
  const raw = decode(row.raw_json, {})
  return {
    ...raw,
    id: row.source_id,
    requestId: row.request_id,
    requestType: row.request_type,
    title: row.title,
    description: row.description,
    referenceNumber: row.reference_number,
    buyerAgency: row.buyer_agency,
    buyerDepartment: row.buyer_department,
    buyerName: row.buyer_name,
    buyerEmail: row.buyer_email,
    buyerPhone: row.buyer_phone,
    setAsideType: row.set_aside_type,
    contractType: row.contract_type,
    awardMethod: row.award_method,
    placeOfPerformanceRaw: row.place_of_performance,
    performanceStates: decode(row.performance_states_json, []),
    vehicleSources: decode(row.vehicle_sources_json, []),
    vehicleSins: decode(row.vehicle_sins_json, []),
    vehiclePairs: decode(row.vehicle_pairs_json, []),
    postedAt: row.posted_at,
    closesAt: row.closes_at,
    lastScrapedAt: row.source_last_seen_at,
    lifecycleStatus: row.lifecycle_status,
    reviewState: row.review_state,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    removedAt: row.removed_at,
    purgeAfter: row.purge_after,
    pipelineContractId: row.pipeline_contract_id,
    updatedAt: row.updated_at,
  }
}

export async function ebuyStorageStatus(db, { excludeFixtures = false } = {}) {
  if (!db) return { status: 'not_configured', message: 'The eBuy D1 database binding is not configured.' }
  try {
    const table = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ebuy_opportunities'").first()
    if (!table) return { status: 'migration_required', message: 'The eBuy database exists but its migration has not been applied.' }
    const connectionTable = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ebuy_connections'").first()
    if (!connectionTable) return { status: 'migration_required', message: 'Apply the latest eBuy database migration to enable the secure connection.' }
    const latest = await db.prepare('SELECT * FROM ebuy_sync_runs ORDER BY started_at DESC LIMIT 1').first()
    const count = await db.prepare(`SELECT COUNT(*) AS count FROM ebuy_opportunities${excludeFixtures ? " WHERE raw_json NOT LIKE '%sanitized-g2x-schema%'" : ''}`).first()
    return {
      status: latest?.status === 'error' ? 'error' : 'ready',
      message: latest?.status === 'error' ? latest.error_message || 'The latest eBuy sync failed.' : 'The eBuy archive is ready.',
      opportunityCount: Number(count?.count || 0),
      lastSync: latest || null,
    }
  } catch (error) {
    return { status: 'error', message: error.message }
  }
}

export async function getEbuyConnectionRecord(db) {
  return db.prepare('SELECT * FROM ebuy_connections WHERE id = 1').first()
}

export async function getEbuyConnectionStatus(db, encryptionConfigured = false) {
  if (!db) return { configured: false, status: 'not_configured', encryptionConfigured }
  try {
    const row = await getEbuyConnectionRecord(db)
    if (!row) return { configured: false, status: 'not_connected', encryptionConfigured }
    return {
      configured: true,
      status: row.status || 'connected',
      encryptionConfigured,
      usernameMasked: row.username_masked || '',
      contracts: decode(row.contracts_json, []),
      lastAuthenticatedAt: row.last_authenticated_at || null,
      lastSyncAt: row.last_sync_at || null,
      lastSuccessAt: row.last_success_at || null,
      lastErrorCode: row.last_error_code || null,
      lastErrorMessage: row.last_error_message || null,
      connectedBy: row.connected_by || '',
      updatedAt: row.updated_at || null,
    }
  } catch (error) {
    if (/no such table/i.test(error.message)) return { configured: false, status: 'migration_required', encryptionConfigured }
    throw error
  }
}

export async function saveEbuyConnection(db, {
  usernameMasked, credentialsEncrypted, sessionEncrypted, contracts, connectedBy,
}) {
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO ebuy_connections (
      id, username_masked, credentials_encrypted, session_encrypted, status,
      contracts_json, last_authenticated_at, last_error_code, last_error_message,
      connected_by, created_at, updated_at
    ) VALUES (1, ?, ?, ?, 'connected', ?, ?, NULL, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username_masked = excluded.username_masked,
      credentials_encrypted = excluded.credentials_encrypted,
      session_encrypted = excluded.session_encrypted,
      status = 'connected',
      contracts_json = excluded.contracts_json,
      last_authenticated_at = excluded.last_authenticated_at,
      last_error_code = NULL,
      last_error_message = NULL,
      connected_by = excluded.connected_by,
      updated_at = excluded.updated_at`)
    .bind(usernameMasked, credentialsEncrypted, sessionEncrypted, encode(contracts), now, connectedBy || '', now, now).run()
}

export async function updateEbuyConnectionSession(db, sessionEncrypted, contracts) {
  const now = new Date().toISOString()
  await db.prepare(`UPDATE ebuy_connections SET session_encrypted = ?, contracts_json = ?, status = 'connected',
    last_authenticated_at = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = 1`)
    .bind(sessionEncrypted, encode(contracts), now, now).run()
}

export async function recordEbuyConnectionResult(db, { ok, code = null, message = null, synced = false } = {}) {
  const now = new Date().toISOString()
  await db.prepare(`UPDATE ebuy_connections SET status = ?, last_error_code = ?, last_error_message = ?,
    last_sync_at = CASE WHEN ? THEN ? ELSE last_sync_at END,
    last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
    updated_at = ? WHERE id = 1`)
    .bind(ok ? 'connected' : 'error', ok ? null : code, ok ? null : message, synced ? 1 : 0, now, ok && synced ? 1 : 0, now, now).run()
}

export async function deleteEbuyConnection(db) {
  await db.prepare('DELETE FROM ebuy_connections WHERE id = 1').run()
}

export async function stageEbuySyncCandidates(db, runId, contractNumber, records) {
  const now = new Date().toISOString()
  let staged = 0
  for (let offset = 0; offset < records.length; offset += 50) {
    const statements = records.slice(offset, offset + 50).map((record) => {
      const requestId = String(record?.rfqId || record?.requestId || '').trim()
      if (!requestId) return null
      staged++
      return db.prepare(`INSERT INTO ebuy_sync_candidates (
        run_id, request_id, contract_number, summary_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(run_id, request_id) DO UPDATE SET
        contract_number = excluded.contract_number,
        summary_json = excluded.summary_json,
        updated_at = excluded.updated_at`)
        .bind(runId, requestId, contractNumber, encode(record), now, now)
    }).filter(Boolean)
    if (statements.length) await db.batch(statements)
  }
  return staged
}

export async function nextEbuySyncCandidate(db, runId) {
  return db.prepare(`SELECT * FROM ebuy_sync_candidates
    WHERE run_id = ? AND status = 'pending' ORDER BY created_at, request_id LIMIT 1`).bind(runId).first()
}

export async function nextEbuySyncCandidateBatch(db, runId, limit = 4) {
  const first = await nextEbuySyncCandidate(db, runId)
  if (!first) return []
  const result = await db.prepare(`SELECT * FROM ebuy_sync_candidates
    WHERE run_id = ? AND status = 'pending' AND contract_number = ?
    ORDER BY created_at, request_id LIMIT ?`)
    .bind(runId, first.contract_number, Math.min(10, Math.max(1, Number(limit || 4)))).all()
  return result.results || []
}

export async function finishEbuySyncCandidate(db, runId, requestId, error = null) {
  await db.prepare(`UPDATE ebuy_sync_candidates SET status = ?, error_message = ?, updated_at = ?
    WHERE run_id = ? AND request_id = ?`)
    .bind(error ? 'error' : 'complete', error?.message || null, new Date().toISOString(), runId, requestId).run()
}

export async function countPendingEbuySyncCandidates(db, runId) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM ebuy_sync_candidates WHERE run_id = ? AND status = 'pending'").bind(runId).first()
  return Number(row?.count || 0)
}

export async function completeLiveEbuySnapshot(db, runStartedAt) {
  const now = new Date()
  const nowIso = now.toISOString()
  const settingsRow = await db.prepare('SELECT * FROM ebuy_settings WHERE id = 1').first()
  const candidates = await db.prepare("SELECT request_id, review_state FROM ebuy_opportunities WHERE lifecycle_status != 'unavailable' AND last_seen_at < ? AND raw_json NOT LIKE '%sanitized-g2x-schema%'")
    .bind(runStartedAt).all()
  let removed = 0
  for (const candidate of candidates.results || []) {
    const purgeAfter = retentionDeadline(candidate.review_state, 'unavailable', now, {
      dismissedRetentionDays: settingsRow?.dismissed_retention_days,
      expiredRetentionDays: settingsRow?.expired_retention_days,
      unavailableRetentionDays: settingsRow?.unavailable_retention_days,
    })
    await db.prepare("UPDATE ebuy_opportunities SET lifecycle_status = 'unavailable', removed_at = ?, purge_after = ?, updated_at = ? WHERE request_id = ?")
      .bind(nowIso, purgeAfter, nowIso, candidate.request_id).run()
    removed++
  }
  return removed
}

export async function clearEbuySyncCandidates(db, runId) {
  await db.prepare('DELETE FROM ebuy_sync_candidates WHERE run_id = ?').bind(runId).run()
}

export async function listEbuyOpportunities(db, options = {}) {
  const page = Math.max(1, Number(options.page || 1))
  const limit = Math.min(100, Math.max(1, Number(options.limit || 25)))
  const offset = (page - 1) * limit
  const where = []
  const bindings = []
  if (options.excludeFixtures) where.push("raw_json NOT LIKE '%sanitized-g2x-schema%'")
  if (options.search) {
    const query = `%${String(options.search).trim().toLowerCase()}%`
    where.push(`(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(request_id) LIKE ? OR LOWER(reference_number) LIKE ? OR LOWER(buyer_agency) LIKE ? OR LOWER(buyer_department) LIKE ? OR LOWER(buyer_name) LIKE ? OR LOWER(set_aside_type) LIKE ? OR LOWER(contract_type) LIKE ? OR LOWER(place_of_performance) LIKE ? OR LOWER(raw_json) LIKE ?)`)
    bindings.push(...Array(11).fill(query))
  }
  if (options.requestType && options.requestType !== 'all') {
    where.push('request_type = ?')
    bindings.push(String(options.requestType).toUpperCase())
  }
  if (options.reviewState && options.reviewState !== 'all') {
    where.push('review_state = ?')
    bindings.push(options.reviewState)
  } else if (!options.includeDismissed) {
    where.push("review_state != 'dismissed'")
  }
  if (options.lifecycle && options.lifecycle !== 'all') {
    where.push('lifecycle_status = ?')
    bindings.push(options.lifecycle)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM ebuy_opportunities ${clause}`).bind(...bindings).first()
  const result = await db.prepare(`SELECT * FROM ebuy_opportunities ${clause} ORDER BY posted_at DESC, request_id DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, offset).all()
  return {
    opportunities: (result.results || []).map(publicOpportunity),
    page,
    limit,
    total: Number(count?.count || 0),
    totalPages: Math.max(1, Math.ceil(Number(count?.count || 0) / limit)),
  }
}

export async function getEbuyOpportunity(db, requestId) {
  const row = await db.prepare('SELECT * FROM ebuy_opportunities WHERE request_id = ?').bind(requestId).first()
  if (!row) return null
  const [versions, amendments, attachments] = await Promise.all([
    db.prepare('SELECT changed_fields_json, captured_at FROM ebuy_versions WHERE request_id = ? ORDER BY captured_at DESC LIMIT 20').bind(requestId).all(),
    db.prepare('SELECT * FROM ebuy_amendments WHERE request_id = ? ORDER BY posted_at DESC, created_at DESC').bind(requestId).all(),
    db.prepare('SELECT * FROM ebuy_attachments WHERE request_id = ? ORDER BY created_at DESC').bind(requestId).all(),
  ])
  return {
    ...publicOpportunity(row),
    versions: (versions.results || []).map((item) => ({ changedFields: decode(item.changed_fields_json, []), capturedAt: item.captured_at })),
    amendments: amendments.results || [],
    attachments: (attachments.results || []).map((item) => ({
      id: item.id, amendmentId: item.amendment_id, fileName: item.file_name,
      contentType: item.content_type, byteSize: item.byte_size, archiveStatus: item.archive_status,
      sharepointWebUrl: item.sharepoint_web_url, archivedAt: item.archived_at,
      errorMessage: item.error_message,
    })),
  }
}

export async function startEbuySyncRun(db, mode, details = {}) {
  const id = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  await db.prepare('INSERT INTO ebuy_sync_runs (id, mode, status, started_at, details_json) VALUES (?, ?, ?, ?, ?)')
    .bind(id, mode, 'running', startedAt, encode(details)).run()
  return { id, startedAt }
}

export async function hasRunningEbuySync(db) {
  const threshold = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
  const row = await db.prepare("SELECT id FROM ebuy_sync_runs WHERE status = 'running' AND started_at >= ? ORDER BY started_at DESC LIMIT 1").bind(threshold).first()
  return Boolean(row?.id)
}

export async function finishEbuySyncRun(db, id, result, error = null) {
  const status = error ? 'error' : 'success'
  await db.prepare(`UPDATE ebuy_sync_runs SET status = ?, completed_at = ?, discovered_count = ?, inserted_count = ?, updated_count = ?, unchanged_count = ?, removed_count = ?, archived_file_count = ?, error_message = ?, details_json = ? WHERE id = ?`)
    .bind(status, new Date().toISOString(), Number(result?.discovered || 0), Number(result?.inserted || 0), Number(result?.updated || 0), Number(result?.unchanged || 0), Number(result?.removed || 0), Number(result?.archivedFiles || 0), error?.message || null, encode(result?.details || {}), id).run()
}

export async function syncEbuyOpportunities(db, records, { source = 'fixture', completeSnapshot = true } = {}) {
  const now = new Date()
  const nowIso = now.toISOString()
  const settingsRow = await db.prepare('SELECT * FROM ebuy_settings WHERE id = 1').first()
  const settings = {
    dismissedRetentionDays: settingsRow?.dismissed_retention_days,
    expiredRetentionDays: settingsRow?.expired_retention_days,
    unavailableRetentionDays: settingsRow?.unavailable_retention_days,
  }
  const result = { discovered: records.length, inserted: 0, updated: 0, unchanged: 0, removed: 0, archivedFiles: 0 }
  const seen = []

  for (const sourceRecord of records) {
    const record = normalizeEbuyOpportunity(sourceRecord, nowIso)
    const hash = await hashEbuyOpportunity(record)
    const existing = await db.prepare('SELECT * FROM ebuy_opportunities WHERE request_id = ?').bind(record.requestId).first()
    const lifecycle = lifecycleForEbuyOpportunity(record, now)
    const changed = existing ? changedEbuyFields(decode(existing.raw_json, {}), record) : Object.keys(record)
    const state = existing?.review_state || 'new'
    const purgeAfter = retentionDeadline(state, lifecycle, now, settings)
    const rawJson = encode({ ...record, fixtureSource: source === 'fixture' ? 'sanitized-g2x-schema' : undefined })
    const statement = db.prepare(`INSERT INTO ebuy_opportunities (
      request_id, source_id, request_type, title, description, reference_number,
      buyer_agency, buyer_department, buyer_name, buyer_email, buyer_phone,
      set_aside_type, contract_type, award_method, place_of_performance,
      performance_states_json, vehicle_sources_json, vehicle_sins_json, vehicle_pairs_json,
      posted_at, closes_at, source_last_seen_at, lifecycle_status, review_state,
      content_hash, raw_json, first_seen_at, last_seen_at, removed_at, purge_after,
      pipeline_contract_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      source_id = excluded.source_id, request_type = excluded.request_type, title = excluded.title,
      description = excluded.description, reference_number = excluded.reference_number,
      buyer_agency = excluded.buyer_agency, buyer_department = excluded.buyer_department,
      buyer_name = excluded.buyer_name, buyer_email = excluded.buyer_email, buyer_phone = excluded.buyer_phone,
      set_aside_type = excluded.set_aside_type, contract_type = excluded.contract_type,
      award_method = excluded.award_method, place_of_performance = excluded.place_of_performance,
      performance_states_json = excluded.performance_states_json, vehicle_sources_json = excluded.vehicle_sources_json,
      vehicle_sins_json = excluded.vehicle_sins_json, vehicle_pairs_json = excluded.vehicle_pairs_json,
      posted_at = excluded.posted_at, closes_at = excluded.closes_at, source_last_seen_at = excluded.source_last_seen_at,
      lifecycle_status = excluded.lifecycle_status, content_hash = excluded.content_hash, raw_json = excluded.raw_json,
      last_seen_at = excluded.last_seen_at, removed_at = NULL, purge_after = excluded.purge_after, updated_at = excluded.updated_at`)
      .bind(record.requestId, record.sourceId, record.requestType, record.title, record.description, record.referenceNumber,
        record.buyerAgency, record.buyerDepartment, record.buyerName, record.buyerEmail, record.buyerPhone,
        record.setAsideType, record.contractType, record.awardMethod, record.placeOfPerformance,
        encode(record.performanceStates), encode(record.vehicleSources), encode(record.vehicleSins), encode(record.vehiclePairs),
        record.postedAt, record.closesAt, record.sourceLastSeenAt, lifecycle, state,
        hash, rawJson, existing?.first_seen_at || nowIso, nowIso, purgeAfter, existing?.created_at || nowIso, nowIso)

    const batch = [statement]
    if (!existing || existing.content_hash !== hash) {
      batch.push(db.prepare('INSERT INTO ebuy_versions (request_id, content_hash, snapshot_json, changed_fields_json, captured_at) VALUES (?, ?, ?, ?, ?)')
        .bind(record.requestId, hash, rawJson, encode(changed), nowIso))
    }
    for (const amendment of record.amendments) {
      const id = String(amendment.id || `${record.requestId}:${amendment.label || amendment.postedAt || crypto.randomUUID()}`)
      batch.push(db.prepare(`INSERT INTO ebuy_amendments (id, request_id, label, description, posted_at, source_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label, description = excluded.description, posted_at = excluded.posted_at, source_json = excluded.source_json, updated_at = excluded.updated_at`)
        .bind(id, record.requestId, String(amendment.label || ''), String(amendment.description || ''), amendment.postedAt || null, encode(amendment), nowIso, nowIso))
    }
    for (const attachment of record.attachments) {
      const id = String(attachment.id || `${record.requestId}:${attachment.fileName || crypto.randomUUID()}`)
      batch.push(db.prepare(`INSERT INTO ebuy_attachments (id, request_id, amendment_id, file_name, content_type, byte_size, source_url, archive_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET amendment_id = excluded.amendment_id, file_name = excluded.file_name, content_type = excluded.content_type, byte_size = excluded.byte_size, source_url = COALESCE(excluded.source_url, source_url), updated_at = excluded.updated_at`)
        .bind(id, record.requestId, attachment.amendmentId || null, String(attachment.fileName || 'Attachment'), String(attachment.contentType || 'application/octet-stream'), Number(attachment.byteSize || 0) || null, attachment.sourceUrl || null, source === 'fixture' ? 'fixture' : 'pending', nowIso, nowIso))
    }
    await db.batch(batch)
    seen.push(record.requestId)
    if (!existing) result.inserted++
    else if (existing.content_hash !== hash) result.updated++
    else result.unchanged++
  }

  if (completeSnapshot) {
    const candidates = await db.prepare("SELECT request_id, review_state FROM ebuy_opportunities WHERE lifecycle_status != 'unavailable'").all()
    const seenSet = new Set(seen)
    for (const candidate of candidates.results || []) {
      if (seenSet.has(candidate.request_id)) continue
      const purgeAfter = retentionDeadline(candidate.review_state, 'unavailable', now, settings)
      await db.prepare("UPDATE ebuy_opportunities SET lifecycle_status = 'unavailable', removed_at = ?, purge_after = ?, updated_at = ? WHERE request_id = ?")
        .bind(nowIso, purgeAfter, nowIso, candidate.request_id).run()
      result.removed++
    }
  }
  return result
}

export async function updateEbuyReviewState(db, requestId, nextState, pipelineContractId = null) {
  const allowed = new Set(['new', 'flagged', 'tracked', 'dismissed', 'added_to_pipeline'])
  if (!allowed.has(nextState)) throw new Error('Unsupported eBuy review state')
  const current = await db.prepare('SELECT * FROM ebuy_opportunities WHERE request_id = ?').bind(requestId).first()
  if (!current) return null
  const settingsRow = await db.prepare('SELECT * FROM ebuy_settings WHERE id = 1').first()
  const purgeAfter = retentionDeadline(nextState, current.lifecycle_status, new Date(), {
    dismissedRetentionDays: settingsRow?.dismissed_retention_days,
    expiredRetentionDays: settingsRow?.expired_retention_days,
    unavailableRetentionDays: settingsRow?.unavailable_retention_days,
  })
  await db.prepare('UPDATE ebuy_opportunities SET review_state = ?, pipeline_contract_id = COALESCE(?, pipeline_contract_id), purge_after = ?, updated_at = ? WHERE request_id = ?')
    .bind(nextState, pipelineContractId, purgeAfter, new Date().toISOString(), requestId).run()
  return getEbuyOpportunity(db, requestId)
}

export async function recordArchivedEbuyAttachment(db, {
  id,
  requestId,
  fileName,
  contentType,
  byteSize,
  sourceHash,
  driveId,
  itemId,
  webUrl,
}) {
  const opportunity = await db.prepare('SELECT request_id FROM ebuy_opportunities WHERE request_id = ?').bind(requestId).first()
  if (!opportunity) {
    const error = new Error('Synchronize the test eBuy archive before archiving its attachment')
    error.status = 409
    error.code = 'ebuy_fixture_required'
    throw error
  }

  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO ebuy_attachments (
      id, request_id, amendment_id, file_name, content_type, byte_size, source_hash,
      archive_status, sharepoint_drive_id, sharepoint_item_id, sharepoint_web_url,
      archived_at, error_message, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'archived', ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      file_name = excluded.file_name,
      content_type = excluded.content_type,
      byte_size = excluded.byte_size,
      source_hash = excluded.source_hash,
      archive_status = 'archived',
      sharepoint_drive_id = excluded.sharepoint_drive_id,
      sharepoint_item_id = excluded.sharepoint_item_id,
      sharepoint_web_url = excluded.sharepoint_web_url,
      archived_at = excluded.archived_at,
      error_message = NULL,
      updated_at = excluded.updated_at`)
    .bind(id, requestId, fileName, contentType, byteSize, sourceHash, driveId, itemId, webUrl, now, now, now)
    .run()

  return {
    id,
    requestId,
    fileName,
    contentType,
    byteSize,
    archiveStatus: 'archived',
    sharepointDriveId: driveId,
    sharepointItemId: itemId,
    sharepointWebUrl: webUrl,
    archivedAt: now,
  }
}

export async function getArchivedEbuyAttachmentIds(db, requestId) {
  const rows = await db.prepare("SELECT id FROM ebuy_attachments WHERE request_id = ? AND archive_status = 'archived' AND sharepoint_item_id IS NOT NULL")
    .bind(requestId).all()
  return new Set((rows.results || []).map((row) => row.id))
}

export async function recordEbuyAttachmentFailure(db, id, message) {
  await db.prepare(`UPDATE ebuy_attachments SET archive_status = 'error', error_message = ?, updated_at = ? WHERE id = ?`)
    .bind(String(message || 'Attachment archive failed'), new Date().toISOString(), id).run()
}

export async function purgeExpiredEbuyRecords(db, { limit = 25, deleteFile = null } = {}) {
  const now = new Date().toISOString()
  const rows = await db.prepare(`SELECT request_id FROM ebuy_opportunities
    WHERE purge_after IS NOT NULL AND purge_after <= ?
      AND review_state NOT IN ('flagged', 'tracked', 'added_to_pipeline')
    ORDER BY purge_after ASC LIMIT ?`).bind(now, Math.min(100, limit)).all()
  let deleted = 0
  let archivedFilesDeleted = 0
  const failures = []
  for (const row of rows.results || []) {
    if (deleteFile) {
      const attachments = await db.prepare('SELECT sharepoint_drive_id, sharepoint_item_id FROM ebuy_attachments WHERE request_id = ? AND sharepoint_item_id IS NOT NULL')
        .bind(row.request_id).all()
      try {
        for (const attachment of attachments.results || []) {
          await deleteFile(attachment.sharepoint_drive_id, attachment.sharepoint_item_id)
          archivedFilesDeleted++
        }
      } catch (error) {
        failures.push({ requestId: row.request_id, message: error.message })
        continue
      }
    }
    await db.prepare('DELETE FROM ebuy_opportunities WHERE request_id = ?').bind(row.request_id).run()
    deleted++
  }
  return { deleted, archivedFilesDeleted, failures }
}
