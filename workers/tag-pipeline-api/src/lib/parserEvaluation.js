import { getAppOnlyGraphToken } from './graph.js'
import {
  extractCriticalSubmissionDetails,
  extractDocumentSections,
  isSubmissionTemplateAttachment,
} from './documentAnalysis.js'

const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_PREVIEW_CHARS = 20_000
const MAX_ARTIFACT_CHARS = 1_500_000
const SUPPORTED_EXTENSIONS = new Set([
  'pdf', 'docx', 'xlsx', 'xls', 'xlsm', 'xlsb', 'pptx', 'txt', 'csv', 'md',
  'html', 'htm', 'xml', 'json', 'odt', 'ods', 'png', 'jpg', 'jpeg', 'webp',
])

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim() }
function extension(name) { return String(name || '').split('.').pop().toLowerCase() }
function jsonValue(value, fallback = {}) {
  try { return JSON.parse(value || '') } catch { return fallback }
}
function safeKeyPart(value) {
  return String(value || 'item').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'item'
}

export function parserEvaluationAccess(identity, env) {
  const configured = String(env.DOCUMENT_EVALUATION_ALLOWED_USERS || env.TRANSACTION_CODING_ALLOWED_USERS || '')
    .split(/[\n,;]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  const allowed = new Set(configured)
  const candidates = [identity?.userId, identity?.email]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  return { configured: allowed.size > 0, allowed: candidates.some((candidate) => allowed.has(candidate)) }
}

export async function parserEvaluationStorageReady(db) {
  if (!db) return false
  try {
    await db.prepare('SELECT id FROM parser_evaluation_runs LIMIT 1').first()
    return true
  } catch {
    return false
  }
}

async function candidateRows(db) {
  const queries = [
    db.prepare(`SELECT w.opportunity_key, w.title opportunity_title, 'pipeline' source_service,
        f.sharepoint_drive_id, f.sharepoint_item_id, f.file_name, f.content_type, COALESCE(f.byte_size, 0) byte_size,
        f.updated_at source_updated_at
      FROM opportunity_workspace_files f
      JOIN opportunity_workspaces w ON w.opportunity_key = f.opportunity_key
      WHERE f.archive_status IN ('archived', 'moved')
        AND f.sharepoint_drive_id IS NOT NULL AND f.sharepoint_item_id IS NOT NULL
      ORDER BY f.updated_at DESC LIMIT 250`).all(),
    db.prepare(`SELECT e.request_id opportunity_key, e.title opportunity_title, 'ebuy' source_service,
        a.sharepoint_drive_id, a.sharepoint_item_id, a.file_name, a.content_type, COALESCE(a.byte_size, 0) byte_size,
        a.updated_at source_updated_at
      FROM ebuy_attachments a JOIN ebuy_opportunities e ON e.request_id = a.request_id
      WHERE e.review_state != 'dismissed' AND a.archive_status IN ('archived', 'moved')
        AND a.sharepoint_drive_id IS NOT NULL AND a.sharepoint_item_id IS NOT NULL
      ORDER BY a.updated_at DESC LIMIT 250`).all(),
    db.prepare(`SELECT s.opportunity_key, s.title opportunity_title, 'sam' source_service,
        f.sharepoint_drive_id, f.sharepoint_item_id, f.file_name, f.content_type, COALESCE(f.byte_size, 0) byte_size,
        f.updated_at source_updated_at
      FROM sam_archive_files f JOIN sam_archives s ON s.opportunity_key = f.opportunity_key
      WHERE s.review_state != 'dismissed' AND f.archive_status IN ('archived', 'moved')
        AND f.sharepoint_drive_id IS NOT NULL AND f.sharepoint_item_id IS NOT NULL
      ORDER BY f.updated_at DESC LIMIT 250`).all(),
  ]
  const settled = await Promise.all(queries.map((query) => query.catch(() => ({ results: [] }))))
  const seen = new Set()
  return settled.flatMap((result) => result.results || []).filter((row) => {
    const ext = extension(row.file_name)
    const itemKey = `${row.sharepoint_drive_id}:${row.sharepoint_item_id}`
    if (!SUPPORTED_EXTENSIONS.has(ext) || Number(row.byte_size || 0) > MAX_FILE_BYTES || seen.has(itemKey)) return false
    seen.add(itemKey)
    return true
  })
}

export function chooseRepresentativeDocuments(rows = [], sampleOpportunities = 10, filesPerOpportunity = 4) {
  const groups = new Map()
  for (const row of rows) {
    const key = String(row.opportunity_key || '').trim().toLowerCase()
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const extensionRarity = new Map()
  for (const row of rows) extensionRarity.set(extension(row.file_name), (extensionRarity.get(extension(row.file_name)) || 0) + 1)
  const rankedGroups = [...groups.entries()].map(([key, files]) => ({
    key,
    files,
    diversity: new Set(files.map((file) => extension(file.file_name))).size,
    hasTables: files.some((file) => /xls|csv/i.test(extension(file.file_name))),
    hasLargeFile: files.some((file) => Number(file.byte_size || 0) >= 2 * 1024 * 1024),
  })).sort((left, right) =>
    Number(right.hasTables) - Number(left.hasTables) ||
    right.diversity - left.diversity ||
    Number(right.hasLargeFile) - Number(left.hasLargeFile) ||
    right.files.length - left.files.length ||
    left.key.localeCompare(right.key))

  const selected = []
  for (const group of rankedGroups.slice(0, Math.max(1, Math.min(12, Number(sampleOpportunities || 10))))) {
    const files = [...group.files].sort((left, right) => {
      const rarity = (extensionRarity.get(extension(left.file_name)) || 0) - (extensionRarity.get(extension(right.file_name)) || 0)
      return rarity || Number(right.byte_size || 0) - Number(left.byte_size || 0) || String(right.source_updated_at || '').localeCompare(String(left.source_updated_at || ''))
    })
    const usedExtensions = new Set()
    const picked = []
    for (const file of files) {
      const ext = extension(file.file_name)
      if (!usedExtensions.has(ext)) {
        picked.push(file)
        usedExtensions.add(ext)
      }
      if (picked.length >= filesPerOpportunity) break
    }
    for (const file of files) {
      if (picked.length >= filesPerOpportunity) break
      if (picked.includes(file)) continue
      picked.push(file)
    }
    selected.push(...picked)
  }
  return selected
}

export async function createParserEvaluationRun(env, identity, input = {}) {
  if (!env.EBUY_DB || !(await parserEvaluationStorageReady(env.EBUY_DB))) {
    throw Object.assign(new Error('Apply the parser-evaluation D1 migration before starting the test.'), { status: 503, code: 'migration_required' })
  }
  if (!env.PARSER_EVALUATION_WORKFLOW?.createBatch) {
    throw Object.assign(new Error('The parser-evaluation Workflow is not configured.'), { status: 503, code: 'workflow_not_configured' })
  }
  if (!env.AI?.toMarkdown) {
    throw Object.assign(new Error('The Workers AI document-conversion binding is not configured.'), { status: 503, code: 'ai_binding_not_configured' })
  }
  const sampleOpportunities = Math.max(1, Math.min(12, Number(input.sampleOpportunities || 10)))
  const filesPerOpportunity = Math.max(1, Math.min(6, Number(input.filesPerOpportunity || 4)))
  const rows = await candidateRows(env.EBUY_DB)
  const selected = chooseRepresentativeDocuments(rows, sampleOpportunities, filesPerOpportunity)
  if (!selected.length) throw Object.assign(new Error('No eligible archived documents were found for evaluation.'), { status: 409 })

  const id = crypto.randomUUID()
  const instanceId = `parser-evaluation-${id}`
  const now = new Date().toISOString()
  const opportunities = new Set(selected.map((row) => String(row.opportunity_key || '').toLowerCase()))
  const statements = [env.EBUY_DB.prepare(`INSERT INTO parser_evaluation_runs
    (id, status, progress_phase, requested_by, sample_opportunities, files_per_opportunity,
      total_opportunities, total_documents, workflow_instance_id, created_at, updated_at)
    VALUES (?, 'queued', 'Waiting to compare parsers', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, identity?.name || identity?.email || identity?.userId || '', sampleOpportunities, filesPerOpportunity,
      opportunities.size, selected.length, instanceId, now, now)]
  for (const row of selected) {
    statements.push(env.EBUY_DB.prepare(`INSERT INTO parser_evaluation_documents
      (id, run_id, opportunity_key, opportunity_title, source_service, sharepoint_drive_id,
        sharepoint_item_id, file_name, content_type, byte_size, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, String(row.opportunity_key || '').toLowerCase(), row.opportunity_title || '', row.source_service || '',
        row.sharepoint_drive_id, row.sharepoint_item_id, row.file_name, row.content_type || 'application/octet-stream',
        Number(row.byte_size || 0), now, now))
  }
  await env.EBUY_DB.batch(statements)
  try {
    const instances = await env.PARSER_EVALUATION_WORKFLOW.createBatch([{
      id: instanceId,
      params: { runId: id },
      retention: { successRetention: '3 days', errorRetention: '7 days' },
    }])
    return { runId: id, instanceId: instances[0]?.id || instanceId, totalDocuments: selected.length, totalOpportunities: opportunities.size }
  } catch (error) {
    await env.EBUY_DB.prepare(`UPDATE parser_evaluation_runs SET status = 'error', progress_phase = 'Evaluation could not start',
      error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`).bind(error.message, now, now, id).run()
    throw Object.assign(new Error(`Parser evaluation could not start: ${error.message}`), { status: 502 })
  }
}

function markdownSections(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  const sections = []
  let heading = ''
  let block = []
  let blockIndex = 0
  const flush = () => {
    const text = block.join('\n').trim()
    block = []
    if (!text) return
    blockIndex += 1
    sections.push({ text, location: heading ? `${heading}, block ${blockIndex}` : `markdown block ${blockIndex}` })
  }
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/)
    if (headingMatch) {
      flush()
      heading = clean(headingMatch[1])
      continue
    }
    if (!line.trim()) flush()
    else block.push(line.trim())
  }
  flush()
  return sections
}

function countMatches(text, pattern) { return (String(text || '').match(pattern) || []).length }
function wordSet(text) {
  const words = clean(text).toLowerCase().match(/[a-z0-9]{3,}/g) || []
  return new Set(words.slice(0, 100_000))
}

export function parserMetrics(text, sections = [], durationMs = 0, tokenEstimate = 0) {
  const value = String(text || '')
  return {
    characters: value.length,
    words: (value.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) || []).length,
    sections: sections.length,
    headings: countMatches(value, /^#{1,6}\s+.+$/gm),
    tableRows: countMatches(value, /^\s*\|.+\|\s*$/gm) + sections.filter((section) => /\s\|\s/.test(section.text)).length,
    emails: countMatches(value, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi),
    dates: countMatches(value, /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?)\b/gi),
    durationMs: Math.max(0, Math.round(Number(durationMs || 0))),
    tokenEstimate: Math.max(0, Number(tokenEstimate || 0)),
  }
}

function criticalSummary(critical = {}) {
  return {
    proposalSubmissionInstructions: critical.proposals?.submissionInstructions || [],
    questionsDue: critical.questions?.deadlines || [],
    questionsSubmissionInstructions: critical.questions?.submissionInstructions || [],
  }
}

export function compareParserOutputs(existingText, cloudflareText, existingMetrics, cloudflareMetrics) {
  const existingWords = wordSet(existingText)
  const cloudflareWords = wordSet(cloudflareText)
  const shared = [...existingWords].filter((word) => cloudflareWords.has(word)).length
  const baselineCoverage = existingWords.size ? shared / existingWords.size : cloudflareWords.size ? 0 : 1
  const lengthRatio = existingMetrics.characters ? cloudflareMetrics.characters / existingMetrics.characters : cloudflareMetrics.characters ? 2 : 1
  const missingSignals = []
  if (cloudflareMetrics.emails < existingMetrics.emails) missingSignals.push('email addresses')
  if (cloudflareMetrics.dates < existingMetrics.dates) missingSignals.push('dates')
  if (cloudflareMetrics.tableRows < existingMetrics.tableRows) missingSignals.push('table rows')
  let recommendation = 'review'
  if (baselineCoverage >= 0.93 && lengthRatio >= 0.9 && !missingSignals.length) recommendation = 'cloudflare'
  else if (baselineCoverage < 0.75 || lengthRatio < 0.7 || missingSignals.length >= 2) recommendation = 'existing'
  return {
    baselineCoverage: Number(baselineCoverage.toFixed(3)),
    lengthRatio: Number(lengthRatio.toFixed(3)),
    missingSignals,
    recommendation,
  }
}

async function downloadEvaluationFile(token, row) {
  if (Number(row.byte_size || 0) > MAX_FILE_BYTES) throw new Error('File exceeds the 15 MB evaluation limit')
  const response = await fetch(`https://graph.microsoft.com/v1.0/drives/${row.sharepoint_drive_id}/items/${encodeURIComponent(row.sharepoint_item_id)}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`Could not download ${row.file_name} for evaluation (${response.status})`)
  return response.arrayBuffer()
}

function conversionResult(value) {
  if (Array.isArray(value)) return value[0]
  if (Array.isArray(value?.results)) return value.results[0]
  if (Array.isArray(value?.result)) return value.result[0]
  return value
}

async function saveArtifact(env, key, text, metadata) {
  if (!env.DOCUMENT_EVALUATION) return ''
  await env.DOCUMENT_EVALUATION.put(key, String(text || '').slice(0, MAX_ARTIFACT_CHARS), {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    customMetadata: metadata,
  })
  return key
}

async function updateRunProgress(db, runId) {
  const counts = await db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN status IN ('complete', 'error') THEN 1 ELSE 0 END) processed,
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) successful,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) failed
    FROM parser_evaluation_documents WHERE run_id = ?`).bind(runId).first()
  const total = Number(counts?.total || 0)
  const processed = Number(counts?.processed || 0)
  const completed = total > 0 && processed >= total
  const now = new Date().toISOString()
  await db.prepare(`UPDATE parser_evaluation_runs SET status = ?, progress_phase = ?, processed_documents = ?,
    successful_documents = ?, failed_documents = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
    .bind(completed ? 'complete' : 'running', completed ? 'Parser comparison available' : `Compared ${processed} of ${total} documents`,
      processed, Number(counts?.successful || 0), Number(counts?.failed || 0), completed ? now : null, now, runId).run()
  return { total, processed, completed }
}

export async function beginParserEvaluationRun(env, runId) {
  const now = new Date().toISOString()
  await env.EBUY_DB.prepare(`UPDATE parser_evaluation_runs SET status = 'running', progress_phase = 'Comparing document parsers',
    started_at = COALESCE(started_at, ?), error_message = NULL, updated_at = ? WHERE id = ?`).bind(now, now, runId).run()
}

export async function processNextParserEvaluationDocument(env, runId) {
  const row = await env.EBUY_DB.prepare(`SELECT * FROM parser_evaluation_documents
    WHERE run_id = ? AND status = 'queued' ORDER BY opportunity_key, byte_size DESC, file_name LIMIT 1`).bind(runId).first()
  if (!row) return updateRunProgress(env.EBUY_DB, runId)
  const startedAt = new Date().toISOString()
  await env.EBUY_DB.prepare(`UPDATE parser_evaluation_documents SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ?`)
    .bind(startedAt, startedAt, row.id).run()
  try {
    const token = await getAppOnlyGraphToken(env)
    const bytes = await downloadEvaluationFile(token, row)

    const existingStarted = Date.now()
    let existingSections = []
    let existingText = ''
    let existingError = ''
    try {
      existingSections = await extractDocumentSections(bytes, row.file_name, row.content_type || '')
      existingText = existingSections.map((section) => `[${section.location}]\n${section.text}`).join('\n\n')
    } catch (error) {
      existingError = error.message
    }
    const existingMetrics = parserMetrics(existingText, existingSections, Date.now() - existingStarted)

    const cloudflareStarted = Date.now()
    let cloudflareText = ''
    let cloudflareSections = []
    let cloudflareError = ''
    let cloudflareTokens = 0
    try {
      const raw = await env.AI.toMarkdown({ name: row.file_name, blob: new Blob([bytes], { type: row.content_type || 'application/octet-stream' }) })
      const converted = conversionResult(raw)
      if (!converted || converted.format === 'error' || converted.error) throw new Error(converted?.error || 'Cloudflare returned no converted document')
      cloudflareText = String(converted.data || '')
      cloudflareTokens = Number(converted.tokens || 0)
      cloudflareSections = markdownSections(cloudflareText)
    } catch (error) {
      cloudflareError = error.message
    }
    const cloudflareMetrics = parserMetrics(cloudflareText, cloudflareSections, Date.now() - cloudflareStarted, cloudflareTokens)

    const existingCritical = existingText ? criticalSummary(extractCriticalSubmissionDetails(existingSections, row.file_name)) : {}
    const cloudflareCritical = cloudflareText ? criticalSummary(extractCriticalSubmissionDetails(cloudflareSections, row.file_name)) : {}
    const comparison = {
      ...compareParserOutputs(existingText, cloudflareText, existingMetrics, cloudflareMetrics),
      existingError,
      cloudflareError,
      existingTemplateClassification: existingText ? isSubmissionTemplateAttachment({ name: row.file_name }, existingSections) : null,
      cloudflareTemplateClassification: cloudflareText ? isSubmissionTemplateAttachment({ name: row.file_name }, cloudflareSections) : null,
      existingCritical,
      cloudflareCritical,
    }
    if (existingError && !cloudflareError) comparison.recommendation = 'cloudflare'
    if (cloudflareError && !existingError) comparison.recommendation = 'existing'
    if (existingError && cloudflareError) comparison.recommendation = 'neither'

    const prefix = `evaluation/${safeKeyPart(runId)}/${safeKeyPart(row.id)}`
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString()
    const metadata = { runId, documentId: row.id, expiresAt }
    const [existingKey, cloudflareKey] = await Promise.all([
      existingText ? saveArtifact(env, `${prefix}/existing.txt`, existingText, { ...metadata, parser: 'existing' }) : '',
      cloudflareText ? saveArtifact(env, `${prefix}/cloudflare.md`, cloudflareText, { ...metadata, parser: 'cloudflare' }) : '',
    ])
    const completedAt = new Date().toISOString()
    await env.EBUY_DB.prepare(`UPDATE parser_evaluation_documents SET status = 'complete', existing_artifact_key = ?,
      cloudflare_artifact_key = ?, existing_preview = ?, cloudflare_preview = ?, existing_metrics_json = ?,
      cloudflare_metrics_json = ?, comparison_json = ?, error_message = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
      .bind(existingKey || null, cloudflareKey || null, existingText.slice(0, MAX_PREVIEW_CHARS), cloudflareText.slice(0, MAX_PREVIEW_CHARS),
        JSON.stringify(existingMetrics), JSON.stringify(cloudflareMetrics), JSON.stringify(comparison), completedAt, completedAt, row.id).run()
  } catch (error) {
    const completedAt = new Date().toISOString()
    await env.EBUY_DB.prepare(`UPDATE parser_evaluation_documents SET status = 'error', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
      .bind(error.message, completedAt, completedAt, row.id).run()
  }
  return updateRunProgress(env.EBUY_DB, runId)
}

export async function failParserEvaluationRun(env, runId, error) {
  const now = new Date().toISOString()
  await env.EBUY_DB.prepare(`UPDATE parser_evaluation_runs SET status = 'error', progress_phase = 'Parser evaluation needs attention',
    error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`).bind(error.message, now, now, runId).run()
}

function publicDocument(row) {
  return {
    id: row.id,
    opportunityKey: row.opportunity_key,
    opportunityTitle: row.opportunity_title,
    sourceService: row.source_service,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: Number(row.byte_size || 0),
    status: row.status,
    existingPreview: row.existing_preview || '',
    cloudflarePreview: row.cloudflare_preview || '',
    existingMetrics: jsonValue(row.existing_metrics_json),
    cloudflareMetrics: jsonValue(row.cloudflare_metrics_json),
    comparison: jsonValue(row.comparison_json),
    reviewDecision: row.review_decision || '',
    reviewNotes: row.review_notes || '',
    reviewedBy: row.reviewed_by || '',
    reviewedAt: row.reviewed_at || null,
    error: row.error_message || null,
  }
}

export async function getParserEvaluationReport(env, runId = '') {
  const run = runId
    ? await env.EBUY_DB.prepare('SELECT * FROM parser_evaluation_runs WHERE id = ?').bind(runId).first()
    : await env.EBUY_DB.prepare('SELECT * FROM parser_evaluation_runs ORDER BY created_at DESC LIMIT 1').first()
  if (!run) return { run: null, documents: [] }
  const rows = await env.EBUY_DB.prepare('SELECT * FROM parser_evaluation_documents WHERE run_id = ? ORDER BY opportunity_title, file_name').bind(run.id).all()
  const documents = (rows.results || []).map(publicDocument)
  const recommendations = documents.reduce((counts, document) => {
    const value = document.comparison?.recommendation || (document.status === 'error' ? 'error' : 'unknown')
    counts[value] = (counts[value] || 0) + 1
    return counts
  }, {})
  return {
    run: {
      id: run.id,
      status: run.status,
      progressPhase: run.progress_phase,
      requestedBy: run.requested_by,
      totalOpportunities: Number(run.total_opportunities || 0),
      totalDocuments: Number(run.total_documents || 0),
      processedDocuments: Number(run.processed_documents || 0),
      successfulDocuments: Number(run.successful_documents || 0),
      failedDocuments: Number(run.failed_documents || 0),
      recommendations,
      error: run.error_message || null,
      createdAt: run.created_at,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    },
    documents,
  }
}

export async function reviewParserEvaluationDocument(env, documentId, input, identity) {
  const allowed = new Set(['existing', 'cloudflare', 'both', 'neither', 'insufficient'])
  const decision = String(input.decision || '').trim().toLowerCase()
  if (!allowed.has(decision)) throw Object.assign(new Error('Choose a valid parser-review decision.'), { status: 400 })
  const now = new Date().toISOString()
  await env.EBUY_DB.prepare(`UPDATE parser_evaluation_documents SET review_decision = ?, review_notes = ?, reviewed_by = ?,
    reviewed_at = ?, updated_at = ? WHERE id = ?`).bind(decision, clean(input.notes).slice(0, 1000),
      identity?.name || identity?.email || identity?.userId || '', now, now, documentId).run()
  return { ok: true }
}

export async function purgeParserEvaluationData(env, now = new Date()) {
  if (!env.EBUY_DB || !(await parserEvaluationStorageReady(env.EBUY_DB))) return { runs: 0, objects: 0 }
  const cutoff = new Date(now.getTime() - 7 * 86400000).toISOString()
  const rows = await env.EBUY_DB.prepare(`SELECT id, existing_artifact_key, cloudflare_artifact_key
    FROM parser_evaluation_documents WHERE run_id IN (
      SELECT id FROM parser_evaluation_runs WHERE created_at < ?
    ) LIMIT 250`).bind(cutoff).all()
  const keys = (rows.results || []).flatMap((row) => [row.existing_artifact_key, row.cloudflare_artifact_key]).filter(Boolean)
  if (env.DOCUMENT_EVALUATION && keys.length) await env.DOCUMENT_EVALUATION.delete(keys)
  const result = await env.EBUY_DB.prepare('DELETE FROM parser_evaluation_runs WHERE created_at < ?').bind(cutoff).run()
  return { runs: Number(result.meta?.changes || 0), objects: keys.length }
}
