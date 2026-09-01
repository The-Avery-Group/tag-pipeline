function clean(value) { return String(value || '').trim() }
function key(value) { return clean(value).toLowerCase() }

function publicArchive(row, files = []) {
  if (!row) return null
  return {
    opportunityKey: row.opportunity_key,
    noticeId: row.notice_id,
    solicitationNumber: row.solicitation_number,
    title: row.title,
    department: row.department,
    agency: row.agency,
    reviewState: row.review_state,
    archiveStatus: row.archive_status,
    progressPhase: row.progress_phase,
    workflowInstanceId: row.workflow_instance_id,
    sharePointDriveId: row.sharepoint_drive_id,
    folderId: row.sharepoint_folder_id,
    webUrl: row.sharepoint_web_url,
    attachmentTotal: Number(row.attachment_total || 0),
    archivedCount: Number(row.archived_count || 0),
    failedCount: Number(row.failed_count || 0),
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    files: files.map((file) => ({
      id: file.id,
      sourceUrl: file.source_url,
      fileName: file.file_name,
      contentType: file.content_type,
      byteSize: Number(file.byte_size || 0) || null,
      sourceSignature: file.source_signature,
      archiveStatus: file.archive_status,
      sharePointDriveId: file.sharepoint_drive_id,
      itemId: file.sharepoint_item_id,
      webUrl: file.sharepoint_web_url,
      archivedAt: file.archived_at,
      errorMessage: file.error_message,
    })),
  }
}

export async function samArchiveStorageReady(db) {
  if (!db) return false
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sam_archives'").first())
}

export async function ensureSAMArchive(db, input) {
  const opportunityKey = key(input.opportunityKey || input.solicitationNumber || input.noticeId)
  if (!opportunityKey) throw Object.assign(new Error('A SAM.gov opportunity identifier is required'), { status: 400 })
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO sam_archives (
      opportunity_key, notice_id, solicitation_number, title, department, agency,
      attachment_total, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(opportunity_key) DO UPDATE SET
      notice_id = CASE WHEN excluded.notice_id != '' THEN excluded.notice_id ELSE sam_archives.notice_id END,
      solicitation_number = CASE WHEN excluded.solicitation_number != '' THEN excluded.solicitation_number ELSE sam_archives.solicitation_number END,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE sam_archives.title END,
      department = CASE WHEN excluded.department != '' THEN excluded.department ELSE sam_archives.department END,
      agency = CASE WHEN excluded.agency != '' THEN excluded.agency ELSE sam_archives.agency END,
      attachment_total = excluded.attachment_total,
      updated_at = excluded.updated_at`)
    .bind(
      opportunityKey, clean(input.noticeId), clean(input.solicitationNumber), clean(input.title),
      clean(input.department), clean(input.agency), Number(input.attachmentTotal || 0), now, now,
    ).run()
  return getSAMArchive(db, opportunityKey)
}

export async function getSAMArchive(db, opportunityKey) {
  const archive = await db.prepare('SELECT * FROM sam_archives WHERE opportunity_key = ?').bind(key(opportunityKey)).first()
  if (!archive) return null
  const files = await db.prepare('SELECT * FROM sam_archive_files WHERE opportunity_key = ? ORDER BY created_at').bind(archive.opportunity_key).all()
  return publicArchive(archive, files.results || [])
}

export async function findSAMArchive(db, input = {}) {
  const candidates = [input.opportunityKey, input.solicitationNumber, input.noticeId].map(key).filter(Boolean)
  for (const candidate of candidates) {
    const row = await db.prepare(`SELECT * FROM sam_archives WHERE opportunity_key = ? OR lower(notice_id) = ? OR lower(solicitation_number) = ? ORDER BY updated_at DESC LIMIT 1`)
      .bind(candidate, candidate, candidate).first()
    if (row) return getSAMArchive(db, row.opportunity_key)
  }
  return null
}

export async function claimSAMArchive(db, opportunityKey, instanceId, { force = false } = {}) {
  const now = new Date().toISOString()
  const allowed = force ? "archive_status != 'running'" : "archive_status IN ('new', 'partial', 'error')"
  const result = await db.prepare(`UPDATE sam_archives SET archive_status = 'running', progress_phase = 'Preparing SAM.gov archive', workflow_instance_id = ?, error_message = NULL, completed_at = NULL, updated_at = ? WHERE opportunity_key = ? AND ${allowed}`)
    .bind(instanceId, now, key(opportunityKey)).run()
  return Number(result.meta?.changes || 0) > 0
}

export async function updateSAMArchive(db, opportunityKey, patch = {}) {
  const columns = {
    reviewState: 'review_state', archiveStatus: 'archive_status', progressPhase: 'progress_phase',
    workflowInstanceId: 'workflow_instance_id', driveId: 'sharepoint_drive_id', folderId: 'sharepoint_folder_id',
    webUrl: 'sharepoint_web_url', attachmentTotal: 'attachment_total', archivedCount: 'archived_count',
    failedCount: 'failed_count', errorMessage: 'error_message', purgeAfter: 'purge_after', completedAt: 'completed_at',
  }
  const entries = Object.entries(patch).filter(([name]) => columns[name])
  if (!entries.length) return getSAMArchive(db, opportunityKey)
  const setters = entries.map(([name]) => `${columns[name]} = ?`)
  const values = entries.map(([, value]) => value ?? null)
  setters.push('updated_at = ?')
  values.push(new Date().toISOString(), key(opportunityKey))
  await db.prepare(`UPDATE sam_archives SET ${setters.join(', ')} WHERE opportunity_key = ?`).bind(...values).run()
  return getSAMArchive(db, opportunityKey)
}

export async function getSAMArchiveFile(db, opportunityKey, sourceUrl) {
  return db.prepare('SELECT * FROM sam_archive_files WHERE opportunity_key = ? AND source_url = ?')
    .bind(key(opportunityKey), clean(sourceUrl)).first()
}

export async function recordSAMArchiveFile(db, input) {
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO sam_archive_files (
      id, opportunity_key, source_url, file_name, content_type, byte_size, source_signature,
      archive_status, sharepoint_drive_id, sharepoint_item_id, sharepoint_web_url,
      archived_at, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET file_name = excluded.file_name, content_type = excluded.content_type,
      byte_size = excluded.byte_size, source_signature = excluded.source_signature,
      archive_status = excluded.archive_status, sharepoint_drive_id = excluded.sharepoint_drive_id,
      sharepoint_item_id = excluded.sharepoint_item_id, sharepoint_web_url = excluded.sharepoint_web_url,
      archived_at = excluded.archived_at, error_message = excluded.error_message, updated_at = excluded.updated_at`)
    .bind(
      input.id, key(input.opportunityKey), clean(input.sourceUrl), clean(input.fileName) || 'SAM attachment',
      clean(input.contentType) || 'application/octet-stream', Number(input.byteSize || 0) || null,
      clean(input.sourceSignature), clean(input.archiveStatus) || 'pending', input.driveId || null,
      input.itemId || null, input.webUrl || null, input.archivedAt || null, input.errorMessage || null, now, now,
    ).run()
}

export async function updateSAMArchiveFileLocation(db, id, moved) {
  await db.prepare(`UPDATE sam_archive_files SET sharepoint_drive_id = ?, sharepoint_item_id = ?, sharepoint_web_url = ?, file_name = COALESCE(?, file_name), byte_size = COALESCE(?, byte_size), archive_status = 'moved', error_message = NULL, updated_at = ? WHERE id = ?`)
    .bind(moved.driveId, moved.itemId, moved.webUrl, moved.fileName || null, Number(moved.byteSize || 0) || null, new Date().toISOString(), id).run()
}

export async function markSAMArchiveReviewState(db, opportunityKey, reviewState) {
  const normalized = clean(reviewState).toLowerCase() || 'new'
  const purgeAfter = normalized === 'dismissed'
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    : null
  return updateSAMArchive(db, opportunityKey, { reviewState: normalized, purgeAfter })
}

export async function purgeDismissedSAMArchives(db, { limit = 10, deleteFile, deleteFolder } = {}) {
  if (!(await samArchiveStorageReady(db))) return { deleted: 0, filesDeleted: 0, failures: [] }
  const rows = await db.prepare(`SELECT opportunity_key FROM sam_archives WHERE review_state = 'dismissed' AND archive_status != 'moved' AND purge_after IS NOT NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?`)
    .bind(new Date().toISOString(), Math.min(25, Math.max(1, Number(limit || 10)))).all()
  let deleted = 0
  let filesDeleted = 0
  const failures = []
  for (const row of rows.results || []) {
    const archive = await getSAMArchive(db, row.opportunity_key)
    try {
      for (const file of archive?.files || []) {
        if (!file.itemId || !deleteFile) continue
        await deleteFile(file.sharePointDriveId, file.itemId)
        filesDeleted++
      }
      if (deleteFolder && archive?.sharePointDriveId) {
        await deleteFolder(archive.sharePointDriveId, archive.opportunityKey)
      }
      await db.batch([
        db.prepare('DELETE FROM opportunity_analysis_reviews WHERE opportunity_key = ?').bind(row.opportunity_key),
        db.prepare('DELETE FROM opportunity_past_performance_matches WHERE opportunity_key = ?').bind(row.opportunity_key),
        db.prepare('DELETE FROM opportunity_document_analysis WHERE opportunity_key = ?').bind(row.opportunity_key),
        db.prepare('DELETE FROM opportunity_analysis_jobs WHERE opportunity_key = ?').bind(row.opportunity_key),
        db.prepare('DELETE FROM sam_archives WHERE opportunity_key = ?').bind(row.opportunity_key),
      ])
      deleted++
    } catch (error) {
      failures.push({ opportunityKey: row.opportunity_key, message: error.message })
    }
  }
  return { deleted, filesDeleted, failures }
}
