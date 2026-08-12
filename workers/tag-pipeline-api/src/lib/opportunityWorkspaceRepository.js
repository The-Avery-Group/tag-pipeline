import { normalizeWorkspaceKey, workspaceCalendarYear } from './opportunityWorkspaceDomain.js'

function publicWorkspace(row) {
  if (!row) return null
  return {
    opportunityKey: row.opportunity_key,
    pipelineId: row.pipeline_id,
    noticeId: row.notice_id,
    solicitationNumber: row.solicitation_number,
    title: row.title,
    department: row.department,
    agency: row.agency,
    noticeType: row.notice_type,
    calendarYear: Number(row.calendar_year),
    status: row.status,
    progressPhase: row.progress_phase,
    workflowInstanceId: row.workflow_instance_id,
    sharePointDriveId: row.sharepoint_drive_id,
    rootFolderId: row.root_folder_id,
    samFolderId: row.sam_folder_id,
    webUrl: row.sharepoint_web_url,
    attachmentTotal: Number(row.attachment_total || 0),
    archivedCount: Number(row.archived_count || 0),
    failedCount: Number(row.failed_count || 0),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export async function workspaceStorageStatus(db) {
  if (!db) return { status: 'not_configured', message: 'Opportunity workspace storage is not configured.' }
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'opportunity_workspaces'").first()
  return table
    ? { status: 'ready', message: 'Opportunity workspace storage is ready.' }
    : { status: 'migration_required', message: 'Apply the latest D1 migration to enable opportunity workspaces.' }
}

export async function ensureWorkspaceRequest(db, input) {
  const opportunityKey = normalizeWorkspaceKey(input.opportunityKey || input.pipelineId)
  if (!opportunityKey) throw Object.assign(new Error('An opportunity identifier is required'), { status: 400 })
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO opportunity_workspaces (
      opportunity_key, pipeline_id, notice_id, solicitation_number, title,
      department, agency, notice_type, calendar_year, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(opportunity_key) DO UPDATE SET
      pipeline_id = excluded.pipeline_id,
      notice_id = CASE WHEN excluded.notice_id != '' THEN excluded.notice_id ELSE opportunity_workspaces.notice_id END,
      solicitation_number = CASE WHEN excluded.solicitation_number != '' THEN excluded.solicitation_number ELSE opportunity_workspaces.solicitation_number END,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE opportunity_workspaces.title END,
      department = CASE WHEN excluded.department != '' THEN excluded.department ELSE opportunity_workspaces.department END,
      agency = CASE WHEN excluded.agency != '' THEN excluded.agency ELSE opportunity_workspaces.agency END,
      notice_type = CASE WHEN excluded.notice_type != '' THEN excluded.notice_type ELSE opportunity_workspaces.notice_type END,
      updated_at = excluded.updated_at`)
    .bind(
      opportunityKey,
      String(input.pipelineId || opportunityKey).trim(),
      String(input.noticeId || '').trim(),
      String(input.solicitationNumber || '').trim(),
      String(input.title || '').trim(),
      String(input.department || '').trim(),
      String(input.agency || '').trim(),
      String(input.noticeType || '').trim().toUpperCase(),
      workspaceCalendarYear(input.calendarYear),
      now,
      now,
    ).run()
  return getWorkspace(db, opportunityKey)
}

export async function getWorkspace(db, opportunityKey) {
  const row = await db.prepare('SELECT * FROM opportunity_workspaces WHERE opportunity_key = ?')
    .bind(normalizeWorkspaceKey(opportunityKey)).first()
  return publicWorkspace(row)
}

export async function claimWorkspaceRun(db, opportunityKey, instanceId, { force = false } = {}) {
  const key = normalizeWorkspaceKey(opportunityKey)
  const now = new Date().toISOString()
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const allowed = force
    ? "status IN ('new', 'error', 'partial', 'ready')"
    : `(status IN ('new', 'error', 'partial') OR (status = 'queued' AND updated_at < ?))`
  const bindings = force
    ? [instanceId, now, key]
    : [instanceId, now, key, staleBefore]
  const result = await db.prepare(`UPDATE opportunity_workspaces
      SET status = 'queued', progress_phase = 'Waiting to start', workflow_instance_id = ?,
          error_message = NULL, completed_at = NULL, updated_at = ?
      WHERE opportunity_key = ? AND ${allowed}`)
    .bind(...bindings).run()
  return Number(result.meta?.changes || 0) > 0
}

export async function updateWorkspace(db, opportunityKey, patch = {}) {
  const columns = {
    status: 'status', progressPhase: 'progress_phase', workflowInstanceId: 'workflow_instance_id',
    sharePointDriveId: 'sharepoint_drive_id', rootFolderId: 'root_folder_id', samFolderId: 'sam_folder_id',
    webUrl: 'sharepoint_web_url', attachmentTotal: 'attachment_total', archivedCount: 'archived_count',
    failedCount: 'failed_count', errorMessage: 'error_message', completedAt: 'completed_at',
  }
  const entries = Object.entries(patch).filter(([key]) => columns[key])
  if (!entries.length) return getWorkspace(db, opportunityKey)
  const values = entries.map(([, value]) => value ?? null)
  const setters = entries.map(([key]) => `${columns[key]} = ?`)
  setters.push('updated_at = ?')
  values.push(new Date().toISOString(), normalizeWorkspaceKey(opportunityKey))
  await db.prepare(`UPDATE opportunity_workspaces SET ${setters.join(', ')} WHERE opportunity_key = ?`)
    .bind(...values).run()
  return getWorkspace(db, opportunityKey)
}

export async function getWorkspaceFile(db, opportunityKey, sourceUrl) {
  return db.prepare('SELECT * FROM opportunity_workspace_files WHERE opportunity_key = ? AND source_url = ?')
    .bind(normalizeWorkspaceKey(opportunityKey), sourceUrl).first()
}

export async function recordWorkspaceFile(db, input) {
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO opportunity_workspace_files (
      id, opportunity_key, source_notice_id, source_url, file_name, content_type,
      byte_size, source_signature, archive_status, sharepoint_drive_id,
      sharepoint_item_id, sharepoint_web_url, archived_at, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      file_name = excluded.file_name, content_type = excluded.content_type,
      byte_size = excluded.byte_size, source_signature = excluded.source_signature,
      archive_status = excluded.archive_status, sharepoint_drive_id = excluded.sharepoint_drive_id,
      sharepoint_item_id = excluded.sharepoint_item_id, sharepoint_web_url = excluded.sharepoint_web_url,
      archived_at = excluded.archived_at, error_message = excluded.error_message, updated_at = excluded.updated_at`)
    .bind(
      input.id,
      normalizeWorkspaceKey(input.opportunityKey),
      String(input.sourceNoticeId || ''),
      String(input.sourceUrl),
      String(input.fileName || 'SAM attachment'),
      String(input.contentType || 'application/octet-stream'),
      Number(input.byteSize || 0) || null,
      String(input.sourceSignature || ''),
      String(input.archiveStatus || 'pending'),
      input.driveId || null,
      input.itemId || null,
      input.webUrl || null,
      input.archivedAt || null,
      input.errorMessage || null,
      now,
      now,
    ).run()
}

