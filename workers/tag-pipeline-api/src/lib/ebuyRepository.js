import {
  changedEbuyFields,
  hashEbuyOpportunity,
  lifecycleForEbuyOpportunity,
  normalizeEbuyOpportunity,
  retentionDeadline,
} from './ebuyDomain.js'
import { alertFingerprint, alertStorageReady, getOpportunityAlert, upsertOpportunityAlert } from './opportunityAlerts.js'

function encode(value) { return JSON.stringify(value ?? null) }
function decode(value, fallback) {
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function attachmentIdentity(attachment = {}) {
  return String(attachment.id || attachment.docSeqNum || attachment.fileName || '').trim()
}

function attachmentSnapshot(attachment = {}) {
  return {
    id: attachmentIdentity(attachment),
    name: String(attachment.fileName || attachment.name || 'Attachment').trim(),
    amendmentId: String(attachment.amendmentId || '').trim(),
    contentType: String(attachment.contentType || '').trim().toLowerCase(),
    byteSize: Number(attachment.byteSize || 0) || null,
    sourceUrl: String(attachment.sourceUrl || attachment.docPath || '').trim(),
  }
}

function attachmentChanges(previous = [], current = []) {
  const before = new Map(previous.map((item) => [attachmentIdentity(item), attachmentSnapshot(item)]).filter(([key]) => key))
  const after = new Map(current.map((item) => [attachmentIdentity(item), attachmentSnapshot(item)]).filter(([key]) => key))
  const changes = []
  for (const [id, snapshot] of after) {
    const prior = before.get(id)
    if (!prior) changes.push({ id, name: snapshot.name, change: 'added' })
    else if (JSON.stringify(prior) !== JSON.stringify(snapshot)) changes.push({ id, name: snapshot.name, change: 'updated' })
  }
  for (const [id, snapshot] of before) {
    if (!after.has(id)) changes.push({ id, name: snapshot.name, change: 'removed' })
  }
  return changes
}

function publicOpportunity(row) {
  if (!row) return null
  const raw = decode(row.raw_json, {})
  const sourceProps = raw?.sourceDetails?.rfqProps || {}
  const sourceAdditional = raw?.sourceDetails?.rfqAdditionalInfo || {}
  const sourceDepartment = String(sourceProps.userAgency || '').trim()
  const sourceAgency = String(sourceProps.userBureau || sourceAdditional.ocoAgency || '').trim()
  return {
    ...raw,
    id: row.source_id,
    requestId: row.request_id,
    requestType: row.request_type,
    title: row.title,
    description: row.description,
    referenceNumber: row.reference_number,
    // Resolve legacy rows immediately as well as newly synchronized rows.
    // Earlier builds stored eBuy's userAgency/userBureau labels in reverse.
    buyerAgency: sourceAgency || row.buyer_agency || sourceDepartment,
    buyerDepartment: sourceDepartment || row.buyer_department || row.buyer_agency,
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
    amendmentCount: Array.isArray(raw.amendments) ? raw.amendments.length : 0,
    updatedAt: row.updated_at,
  }
}

function normalizePipelineRecord(record) {
  if (typeof record === 'string') return { id: record.trim(), outlook: '' }
  return {
    id: String(record?.id || record?.pipelineContractId || '').trim(),
    outlook: String(record?.outlook || '').trim(),
  }
}

function activePipelineReviewState(outlook) {
  return String(outlook || '').trim().toLowerCase() === 'tracking' ? 'tracked' : 'added_to_pipeline'
}

function publicSyncRun(row) {
  if (!row) return null
  const details = decode(row.details_json, {})
  const progress = details.progress || (row.status === 'success'
    ? { phase: 'complete', percent: 100, message: 'eBuy synchronization complete' }
    : null)
  return { ...row, details, progress }
}

export const EBUY_SYNC_STALE_AFTER_MS = 30 * 60 * 1000

function syncRunHeartbeat(row) {
  const details = decode(row?.details_json, {})
  return details?.progress?.updatedAt || details?.updatedAt || row?.started_at || null
}

export function isEbuySyncRunStale(row, now = Date.now(), staleAfterMs = EBUY_SYNC_STALE_AFTER_MS) {
  if (!row || row.status !== 'running') return false
  const heartbeat = new Date(syncRunHeartbeat(row)).getTime()
  return !Number.isFinite(heartbeat) || now - heartbeat > staleAfterMs
}

export async function recoverStaleEbuySyncRuns(db, { now = new Date(), staleAfterMs = EBUY_SYNC_STALE_AFTER_MS } = {}) {
  if (!db) return { recovered: 0 }
  const result = await db.prepare("SELECT * FROM ebuy_sync_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 10").all()
  let recovered = 0
  for (const row of result.results || []) {
    if (!isEbuySyncRunStale(row, now.getTime(), staleAfterMs)) continue
    const details = decode(row.details_json, {})
    const message = 'The eBuy synchronization stopped reporting progress and can now be resumed.'
    const progress = {
      ...(details.progress || {}),
      phase: 'error',
      message,
      updatedAt: now.toISOString(),
    }
    const update = await db.prepare(`UPDATE ebuy_sync_runs
      SET status = 'error', completed_at = ?, error_message = ?, details_json = ?
      WHERE id = ? AND status = 'running'`)
      .bind(now.toISOString(), message, encode({ ...details, progress }), row.id).run()
    recovered += Number(update?.meta?.changes || update?.changes || 0)
  }
  return { recovered }
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
      lastSync: publicSyncRun(latest),
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

export async function deleteEbuyFixtureRecords(db) {
  const result = await db.prepare("DELETE FROM ebuy_opportunities WHERE raw_json LIKE '%sanitized-g2x-schema%'").run()
  return Number(result?.meta?.changes || result?.changes || 0)
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

export async function getEbuySyncCandidateFailures(db, runId, limit = 20) {
  const [count, rows] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM ebuy_sync_candidates WHERE run_id = ? AND status = 'error'").bind(runId).first(),
    db.prepare(`SELECT request_id, error_message FROM ebuy_sync_candidates
      WHERE run_id = ? AND status = 'error' ORDER BY updated_at DESC LIMIT ?`)
      .bind(runId, Math.min(100, Math.max(1, Number(limit || 20)))).all(),
  ])
  return {
    count: Number(count?.count || 0),
    items: (rows.results || []).map((row) => ({
      requestId: row.request_id,
      code: 'ebuy_candidate_failed',
      message: row.error_message || 'This eBuy opportunity could not be processed',
    })),
  }
}

export async function getResumableEbuySyncRun(db, { maxAgeHours = 7 * 24 } = {}) {
  const threshold = new Date(Date.now() - Math.max(1, Number(maxAgeHours || 7 * 24)) * 60 * 60 * 1000).toISOString()
  const row = await db.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM ebuy_sync_candidates c WHERE c.run_id = r.id AND c.status = 'complete') AS completed_candidates,
      (SELECT COUNT(*) FROM ebuy_sync_candidates c WHERE c.run_id = r.id AND c.status IN ('pending', 'error')) AS retryable_candidates,
      (SELECT COUNT(*) FROM ebuy_attachments a
        JOIN ebuy_opportunities o ON o.request_id = a.request_id
        WHERE a.archive_status IN ('pending', 'error') AND o.last_seen_at >= r.started_at) AS retryable_attachments
    FROM ebuy_sync_runs r
    WHERE r.status = 'error' AND COALESCE(r.completed_at, r.started_at) >= ?
      AND (
        EXISTS (SELECT 1 FROM ebuy_sync_candidates c WHERE c.run_id = r.id AND c.status IN ('pending', 'error'))
        OR EXISTS (SELECT 1 FROM ebuy_attachments a
          JOIN ebuy_opportunities o ON o.request_id = a.request_id
          WHERE a.archive_status IN ('pending', 'error') AND o.last_seen_at >= r.started_at)
      )
    ORDER BY r.started_at DESC LIMIT 1`).bind(threshold).first()
  if (!row) return null
  return {
    ...row,
    completedCandidates: Number(row.completed_candidates || 0),
    retryableCandidates: Number(row.retryable_candidates || 0),
    retryableAttachments: Number(row.retryable_attachments || 0),
    details: decode(row.details_json, {}),
  }
}

export async function resumeEbuySyncRun(db, id, { retryErrors = true } = {}) {
  const row = await db.prepare('SELECT * FROM ebuy_sync_runs WHERE id = ?').bind(id).first()
  if (!row) throw new Error('The interrupted eBuy synchronization could not be found')
  const now = new Date().toISOString()
  if (retryErrors) {
    await db.prepare("UPDATE ebuy_sync_candidates SET status = 'pending', error_message = NULL, updated_at = ? WHERE run_id = ? AND status = 'error'")
      .bind(now, id).run()
  }
  const counts = await db.prepare(`SELECT
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed,
      COUNT(*) AS total
    FROM ebuy_sync_candidates WHERE run_id = ?`).bind(id).first()
  const discovered = Number(row.discovered_count || counts?.total || 0)
  const processedCandidates = Number(counts?.completed || 0)
  const totalCandidates = Number(counts?.total || 0)
  await db.prepare(`UPDATE ebuy_sync_runs SET status = 'running', completed_at = NULL,
      error_message = NULL, details_json = ? WHERE id = ?`)
    .bind(encode({ progress: {
      phase: 'resuming', percent: totalCandidates ? 30 + Math.round((processedCandidates / totalCandidates) * 40) : 30,
      message: `Resuming ${processedCandidates} of ${totalCandidates} opportunities`,
      processed: processedCandidates, total: totalCandidates, archivedFiles: 0, updatedAt: now,
    } }), id).run()
  return {
    id,
    startedAt: row.started_at,
    discovered,
    inserted: Number(row.inserted_count || 0),
    updated: Number(row.updated_count || 0),
    unchanged: Number(row.unchanged_count || 0),
    removed: Number(row.removed_count || 0),
    archivedFiles: Number(row.archived_file_count || 0),
    processedCandidates,
    totalCandidates,
  }
}

export async function resetRetryableEbuyAttachments(db, runStartedAt) {
  const result = await db.prepare(`UPDATE ebuy_attachments SET archive_status = 'pending', error_message = NULL, updated_at = ?
    WHERE archive_status = 'error' AND request_id IN (
      SELECT request_id FROM ebuy_opportunities WHERE last_seen_at >= ?
    )`).bind(new Date().toISOString(), runStartedAt).run()
  return Number(result?.meta?.changes || result?.changes || 0)
}

export async function countPendingEbuyAttachments(db, runStartedAt) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ebuy_attachments a
    JOIN ebuy_opportunities o ON o.request_id = a.request_id
    WHERE a.archive_status = 'pending' AND o.last_seen_at >= ?`).bind(runStartedAt).first()
  return Number(row?.count || 0)
}

export async function getEbuyAttachmentArchiveProgress(db, runStartedAt) {
  const row = await db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN a.archive_status = 'archived' THEN 1 ELSE 0 END) AS archived,
      SUM(CASE WHEN a.archive_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN a.archive_status = 'error' THEN 1 ELSE 0 END) AS failed
    FROM ebuy_attachments a
    JOIN ebuy_opportunities o ON o.request_id = a.request_id
    WHERE o.last_seen_at >= ?`).bind(runStartedAt).first()
  return {
    total: Number(row?.total || 0),
    archived: Number(row?.archived || 0),
    pending: Number(row?.pending || 0),
    failed: Number(row?.failed || 0),
  }
}

export async function nextPendingEbuyAttachment(db, runStartedAt) {
  const row = await db.prepare(`SELECT a.*, o.raw_json, o.pipeline_contract_id,
      EXISTS(
        SELECT 1 FROM ebuy_attachments archived
        WHERE archived.request_id = a.request_id
          AND archived.archive_status = 'archived'
          AND archived.sharepoint_item_id IS NOT NULL
      ) AS archive_folder_ready
    FROM ebuy_attachments a JOIN ebuy_opportunities o ON o.request_id = a.request_id
    WHERE a.archive_status = 'pending' AND o.last_seen_at >= ?
    ORDER BY a.updated_at, a.request_id, a.id LIMIT 1`).bind(runStartedAt).first()
  if (!row) return null
  const opportunity = decode(row.raw_json, {})
  const attachment = (Array.isArray(opportunity.attachments) ? opportunity.attachments : [])
    .find((item) => String(item.id) === String(row.id))
  return {
    id: row.id,
    requestId: row.request_id,
    pipelineContractId: row.pipeline_contract_id || '',
    contractNumber: opportunity?.sourceDetails?.contractNumber || opportunity?.vehicleSources?.[0] || '',
    archiveFolderReady: Boolean(row.archive_folder_ready),
    attachment: attachment || {
      id: row.id,
      fileName: row.file_name,
      contentType: row.content_type,
      docPath: row.source_url,
      sourceUrl: row.source_url,
    },
  }
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
  const requestedLimit = Math.min(500, Math.max(1, Number(options.limit || 100)))
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
  const total = Number(count?.count || 0)
  const limit = options.all ? Math.max(1, total) : requestedLimit
  const effectivePage = options.all ? 1 : page
  const offset = (effectivePage - 1) * limit
  const result = await db.prepare(`SELECT * FROM ebuy_opportunities ${clause} ORDER BY posted_at DESC, request_id DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, offset).all()
  return {
    opportunities: (result.results || []).map(publicOpportunity),
    page: effectivePage,
    limit,
    total,
    totalPages: options.all ? 1 : Math.max(1, Math.ceil(total / limit)),
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
    versions: (versions.results || []).map((item, index, list) => ({
      changedFields: decode(item.changed_fields_json, []),
      capturedAt: item.captured_at,
      // Versions are returned newest first. The oldest row is the immutable
      // baseline, not a user-facing "change" caused by the first pull.
      initial: index === list.length - 1,
    })),
    amendments: amendments.results || [],
    attachments: (attachments.results || []).map((item) => ({
      id: item.id, amendmentId: item.amendment_id, fileName: item.file_name,
      contentType: item.content_type, byteSize: item.byte_size, archiveStatus: item.archive_status,
      sharepointWebUrl: item.sharepoint_web_url, archivedAt: item.archived_at,
      errorMessage: item.error_message,
    })),
  }
}

export async function findEbuyPipelineSource(db, opportunityKey) {
  const key = String(opportunityKey || '').trim()
  if (!key) return null
  const row = await db.prepare(`SELECT * FROM ebuy_opportunities
    WHERE lower(request_id) = lower(?) OR lower(COALESCE(pipeline_contract_id, '')) = lower(?)
    ORDER BY updated_at DESC LIMIT 1`).bind(key, key).first()
  return publicOpportunity(row)
}

export async function listEbuyFollowOnCandidates(db, { postedAfter = null, postedBefore = null } = {}) {
  // Dismissal is a review preference, not evidence that an opportunity is an
  // invalid follow-on. Compare every RFP/RFQ still retained in the New-tab
  // source store, including dismissed records.
  const where = ["request_type IN ('RFP', 'RFQ')", "lifecycle_status != 'unavailable'"]
  const bindings = []
  if (postedAfter) { where.push('posted_at > ?'); bindings.push(postedAfter) }
  if (postedBefore) { where.push('posted_at <= ?'); bindings.push(postedBefore) }
  const result = await db.prepare(`SELECT * FROM ebuy_opportunities
    WHERE ${where.join(' AND ')}
    ORDER BY posted_at DESC, request_id DESC LIMIT 1000`).bind(...bindings).all()
  return (result.results || []).map(publicOpportunity)
}

export async function startEbuySyncRun(db, mode, details = {}) {
  const id = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const progress = details.progress ? { ...details.progress, updatedAt: startedAt } : null
  await db.prepare('INSERT INTO ebuy_sync_runs (id, mode, status, started_at, details_json) VALUES (?, ?, ?, ?, ?)')
    .bind(id, mode, 'running', startedAt, encode({ ...details, ...(progress ? { progress } : {}) })).run()
  return { id, startedAt }
}

export async function updateEbuySyncRunProgress(db, id, result = {}, progress = {}) {
  const details = { ...(result?.details || {}), progress: { ...progress, updatedAt: new Date().toISOString() } }
  await db.prepare(`UPDATE ebuy_sync_runs SET discovered_count = ?, inserted_count = ?, updated_count = ?,
    unchanged_count = ?, removed_count = ?, archived_file_count = ?, details_json = ?
    WHERE id = ? AND status = 'running'`)
    .bind(
      Number(result?.discovered || 0), Number(result?.inserted || 0), Number(result?.updated || 0),
      Number(result?.unchanged || 0), Number(result?.removed || 0), Number(result?.archivedFiles || 0),
      encode(details), id,
    ).run()
}

export async function hasRunningEbuySync(db) {
  const row = await db.prepare("SELECT id FROM ebuy_sync_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").first()
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
    const existing = await db.prepare('SELECT * FROM ebuy_opportunities WHERE request_id = ?').bind(record.requestId).first()
    const previousRecord = decode(existing?.raw_json, {})
    // Discovery summaries arrive before the slower detail request. Preserve
    // known file and amendment metadata until the detail pass replaces it so
    // a transient eBuy failure cannot erase the information needed to retry.
    if (!record.attachments.length && Array.isArray(previousRecord.attachments)) record.attachments = previousRecord.attachments
    if (!record.amendments.length && Array.isArray(previousRecord.amendments)) record.amendments = previousRecord.amendments
    // Discovery summaries and intermittent detail fallbacks are intentionally
    // partial. Never replace richer saved posting data with an empty field
    // merely because one detail request timed out.
    for (const field of [
      'requestType', 'title', 'description', 'referenceNumber', 'buyerAgency', 'buyerDepartment',
      'buyerName', 'buyerEmail', 'buyerPhone', 'setAsideType', 'contractType', 'awardMethod',
      'placeOfPerformance', 'postedAt', 'closesAt',
    ]) {
      if ((record[field] == null || record[field] === '') && previousRecord[field]) record[field] = previousRecord[field]
    }
    for (const field of ['performanceStates', 'vehicleSources', 'vehicleSins', 'vehiclePairs']) {
      if (!record[field]?.length && Array.isArray(previousRecord[field])) record[field] = previousRecord[field]
    }
    record.sourceDetails = { ...(previousRecord.sourceDetails || {}), ...(record.sourceDetails || {}) }
    const hash = await hashEbuyOpportunity(record)
    const lifecycle = lifecycleForEbuyOpportunity(record, now)
    const changed = existing ? changedEbuyFields(previousRecord, record) : Object.keys(record)
    const state = existing?.review_state || 'new'
    const purgeAfter = retentionDeadline(state, lifecycle, now, settings)
    const rawJson = encode({ ...record, fixtureSource: source === 'fixture' ? 'sanitized-g2x-schema' : undefined })
    const fileChanges = existing
      ? attachmentChanges(previousRecord.attachments, record.attachments)
      : []
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
    // changedEbuyFields uses the material allow-list. Comparing the stored
    // hash alone would create a false history row when the hashing algorithm
    // is upgraded, even though the source opportunity did not change.
    if (!existing || changed.length > 0) {
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
      const changedAttachment = fileChanges.some((item) => item.id === id && item.change !== 'removed')
      batch.push(db.prepare(`INSERT INTO ebuy_attachments (id, request_id, amendment_id, file_name, content_type, byte_size, source_url, archive_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET amendment_id = excluded.amendment_id, file_name = excluded.file_name, content_type = excluded.content_type, byte_size = excluded.byte_size, source_url = COALESCE(excluded.source_url, source_url), archive_status = CASE WHEN ? THEN 'pending' ELSE archive_status END, error_message = CASE WHEN ? THEN NULL ELSE error_message END, updated_at = excluded.updated_at`)
        .bind(id, record.requestId, attachment.amendmentId || null, String(attachment.fileName || 'Attachment'), String(attachment.contentType || 'application/octet-stream'), Number(attachment.byteSize || 0) || null, attachment.sourceUrl || null, source === 'fixture' ? 'fixture' : 'pending', nowIso, nowIso, changedAttachment ? 1 : 0, changedAttachment ? 1 : 0))
    }
    await db.batch(batch)
    if (existing?.pipeline_contract_id && fileChanges.length && await alertStorageReady(db)) {
      const fingerprint = alertFingerprint(fileChanges.map(({ id, name, change }) => ({ id, name, change })))
      const added = fileChanges.filter((item) => item.change === 'added').length
      const updated = fileChanges.filter((item) => item.change === 'updated').length
      const removedFiles = fileChanges.filter((item) => item.change === 'removed').length
      await upsertOpportunityAlert(db, {
        opportunityKey: existing.pipeline_contract_id,
        type: 'ebuy_files',
        fingerprint,
        summary: added && !updated && !removedFiles
          ? `${added} new eBuy file${added === 1 ? '' : 's'}`
          : 'eBuy files updated',
        details: {
          source: 'GSA eBuy',
          requestId: record.requestId,
          files: fileChanges,
          awaitingArchive: fileChanges.some((item) => item.change !== 'removed'),
        },
      })
    }
    seen.push(record.requestId)
    if (!existing) result.inserted++
    else if (changed.length > 0) result.updated++
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

/**
 * Reconcile eBuy's denormalized pipeline marker against the workbook-derived
 * list supplied by the authenticated client. This repairs both sides of an
 * interrupted two-system write: an eBuy record whose workbook row was deleted
 * becomes reviewable again, while a workbook row whose final eBuy PATCH failed
 * is restored to In pipeline/Tracked without creating another opportunity.
 */
export async function reconcileEbuyPipelineRecords(db, pipelineRecords = []) {
  const pipeline = new Map((pipelineRecords || [])
    .map(normalizePipelineRecord)
    .filter((record) => record.id)
    .map((record) => [record.id.toLowerCase(), record]))
  const settingsRow = await db.prepare('SELECT * FROM ebuy_settings WHERE id = 1').first()
  const rows = await db.prepare(`SELECT request_id, review_state, lifecycle_status, pipeline_contract_id
    FROM ebuy_opportunities`).all()
  const statements = []
  let linked = 0
  let unlinked = 0
  const now = new Date()
  const nowIso = now.toISOString()

  for (const row of rows.results || []) {
    const currentPipelineId = String(row.pipeline_contract_id || '').trim()
    const match = pipeline.get(currentPipelineId.toLowerCase()) || pipeline.get(String(row.request_id || '').trim().toLowerCase())
    if (match) {
      const nextReviewState = ['dismissed', 'flagged'].includes(row.review_state)
        ? row.review_state
        : activePipelineReviewState(match.outlook)
      if (currentPipelineId === match.id && row.review_state === nextReviewState) continue
      statements.push(db.prepare(`UPDATE ebuy_opportunities
        SET review_state = ?, pipeline_contract_id = ?, purge_after = NULL, updated_at = ?
        WHERE request_id = ?`).bind(nextReviewState, match.id, nowIso, row.request_id))
      linked++
      continue
    }

    if (!currentPipelineId && !['added_to_pipeline', 'tracked'].includes(row.review_state)) continue
    const nextReviewState = ['added_to_pipeline', 'tracked'].includes(row.review_state) ? 'new' : row.review_state
    const purgeAfter = retentionDeadline(nextReviewState, row.lifecycle_status, now, {
      dismissedRetentionDays: settingsRow?.dismissed_retention_days,
      expiredRetentionDays: settingsRow?.expired_retention_days,
      unavailableRetentionDays: settingsRow?.unavailable_retention_days,
    })
    statements.push(db.prepare(`UPDATE ebuy_opportunities
      SET review_state = ?, pipeline_contract_id = NULL, purge_after = ?, updated_at = ?
      WHERE request_id = ?`).bind(nextReviewState, purgeAfter, nowIso, row.request_id))
    unlinked++
  }

  if (statements.length) await db.batch(statements)
  return { linked, unlinked, changed: statements.length }
}

export async function unlinkEbuyPipelineRecord(db, pipelineContractId) {
  const id = String(pipelineContractId || '').trim()
  if (!id) return { changed: 0 }
  const settingsRow = await db.prepare('SELECT * FROM ebuy_settings WHERE id = 1').first()
  const row = await db.prepare(`SELECT request_id, review_state, lifecycle_status
    FROM ebuy_opportunities
    WHERE lower(request_id) = lower(?) OR lower(COALESCE(pipeline_contract_id, '')) = lower(?)
    LIMIT 1`).bind(id, id).first()
  if (!row) return { changed: 0 }
  const nextReviewState = ['added_to_pipeline', 'tracked'].includes(row.review_state) ? 'new' : row.review_state
  const purgeAfter = retentionDeadline(nextReviewState, row.lifecycle_status, new Date(), {
    dismissedRetentionDays: settingsRow?.dismissed_retention_days,
    expiredRetentionDays: settingsRow?.expired_retention_days,
    unavailableRetentionDays: settingsRow?.unavailable_retention_days,
  })
  await db.prepare(`UPDATE ebuy_opportunities
    SET review_state = ?, pipeline_contract_id = NULL, purge_after = ?, updated_at = ?
    WHERE request_id = ?`).bind(nextReviewState, purgeAfter, new Date().toISOString(), row.request_id).run()
  return { changed: 1, requestId: row.request_id, reviewState: nextReviewState }
}

export async function listArchivedEbuyAttachments(db, requestId) {
  const rows = await db.prepare(`SELECT id, request_id, file_name, content_type, byte_size,
      source_hash, archive_status, sharepoint_drive_id, sharepoint_item_id, sharepoint_web_url
    FROM ebuy_attachments
    WHERE request_id = ? AND archive_status = 'archived' AND sharepoint_item_id IS NOT NULL
    ORDER BY created_at`).bind(requestId).all()
  return rows.results || []
}

export async function getEbuyWorkspaceArchive(db, requestId) {
  const opportunity = await db.prepare(`SELECT request_id FROM ebuy_opportunities
    WHERE lower(request_id) = lower(?) OR lower(COALESCE(pipeline_contract_id, '')) = lower(?)
    LIMIT 1`).bind(requestId, requestId).first()
  if (!opportunity) return null
  return {
    requestId: opportunity.request_id,
    attachments: await listArchivedEbuyAttachments(db, opportunity.request_id),
  }
}

export async function updateEbuyAttachmentLocation(db, id, { driveId, itemId, webUrl, fileName, byteSize }) {
  await db.prepare(`UPDATE ebuy_attachments
    SET sharepoint_drive_id = ?, sharepoint_item_id = ?, sharepoint_web_url = ?,
        file_name = COALESCE(?, file_name), byte_size = COALESCE(?, byte_size),
        archive_status = 'archived', error_message = NULL, updated_at = ?
    WHERE id = ?`).bind(
      driveId || null,
      itemId || null,
      webUrl || null,
      fileName || null,
      Number(byteSize || 0) || null,
      new Date().toISOString(),
      id,
    ).run()
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

  await refreshEbuyFileAlertArchiveState(db, requestId)

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

export async function refreshEbuyFileAlertArchiveState(db, requestId) {
  if (!db || !(await alertStorageReady(db))) return null
  const opportunity = await db.prepare('SELECT pipeline_contract_id FROM ebuy_opportunities WHERE request_id = ?')
    .bind(requestId).first()
  if (!opportunity?.pipeline_contract_id) return null
  const alert = await getOpportunityAlert(db, opportunity.pipeline_contract_id, 'ebuy_files')
  if (!alert || alert.status !== 'active') return alert
  const counts = await db.prepare(`SELECT
      SUM(CASE WHEN archive_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN archive_status = 'error' THEN 1 ELSE 0 END) AS failed
    FROM ebuy_attachments WHERE request_id = ?`).bind(requestId).first()
  return (await upsertOpportunityAlert(db, {
    opportunityKey: opportunity.pipeline_contract_id,
    type: 'ebuy_files',
    fingerprint: alert.fingerprint,
    summary: alert.summary,
    details: {
      ...alert.details,
      awaitingArchive: Number(counts?.pending || 0) > 0,
      archiveFailures: Number(counts?.failed || 0),
    },
  })).alert
}

export async function getArchivedEbuyAttachmentIds(db, requestId) {
  const rows = await db.prepare("SELECT id FROM ebuy_attachments WHERE request_id = ? AND archive_status = 'archived' AND sharepoint_item_id IS NOT NULL")
    .bind(requestId).all()
  return new Set((rows.results || []).map((row) => row.id))
}

export async function recordEbuyAttachmentFailure(db, id, message) {
  await db.prepare(`UPDATE ebuy_attachments SET archive_status = 'error', error_message = ?, updated_at = ? WHERE id = ?`)
    .bind(String(message || 'Attachment archive failed'), new Date().toISOString(), id).run()
  const row = await db.prepare('SELECT request_id FROM ebuy_attachments WHERE id = ?').bind(id).first()
  if (row?.request_id) await refreshEbuyFileAlertArchiveState(db, row.request_id)
}

export async function purgeExpiredEbuyRecords(db, { limit = 25, deleteFile = null } = {}) {
  const now = new Date().toISOString()
  const rows = await db.prepare(`SELECT request_id FROM ebuy_opportunities
    WHERE purge_after IS NOT NULL AND purge_after <= ?
      AND review_state NOT IN ('flagged', 'tracked', 'added_to_pipeline')
      AND pipeline_contract_id IS NULL
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
