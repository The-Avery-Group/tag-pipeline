import { strFromU8, unzipSync } from 'fflate'
import { extractText, getDocumentProxy } from 'unpdf'

import { getAppOnlyGraphToken } from './graph.js'
import { childByName, driveIdFor, getItem, graphResponse, listWorkspaceFlatFiles } from './opportunityWorkspaceSharePoint.js'
import { getWorkspace } from './opportunityWorkspaceRepository.js'
import { findSAMArchive } from './samArchiveRepository.js'
import { normalizeWorkspaceKey } from './opportunityWorkspaceDomain.js'
import { findEbuyPipelineSource, getEbuyWorkspaceArchive } from './ebuyRepository.js'

const PAST_PERFORMANCE_FOLDER = 'Past Performance'
const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_FILES_PER_RUN = 3

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim() }
function xmlText(value) {
  return clean(String(value || '')
    .replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
}
function extension(name) { return String(name || '').split('.').pop().toLowerCase() }
function signature(file) { return `${file.id}:${file.size || 0}:${file.lastModifiedDateTime || ''}` }

function ooxmlSections(bytes, name) {
  const archive = unzipSync(new Uint8Array(bytes))
  const ext = extension(name)
  if (ext === 'docx') {
    const xml = archive['word/document.xml'] ? strFromU8(archive['word/document.xml']) : ''
    return [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((match, index) => ({ text: xmlText(match[0]), location: `paragraph ${index + 1}` })).filter((item) => item.text)
  }
  if (ext === 'pptx') {
    return Object.keys(archive).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path)).sort().map((path) => ({
      text: xmlText(strFromU8(archive[path])), location: `slide ${Number(path.match(/slide(\d+)/)?.[1] || 0)}`,
    })).filter((item) => item.text)
  }
  if (ext === 'xlsx') {
    return Object.keys(archive).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path)).sort().map((path) => ({
      text: xmlText(strFromU8(archive[path])), location: `sheet ${Number(path.match(/sheet(\d+)/)?.[1] || 0)}`,
    })).filter((item) => item.text)
  }
  return []
}

export async function extractDocumentSections(bytes, fileName, mimeType = '') {
  const ext = extension(fileName)
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    const result = await extractText(pdf, { mergePages: false })
    return (result.text || []).map((text, index) => ({ text: clean(text), location: `page ${index + 1}` })).filter((item) => item.text)
  }
  if (['docx', 'pptx', 'xlsx'].includes(ext)) return ooxmlSections(bytes, fileName)
  if (['txt', 'csv', 'md', 'html', 'htm', 'xml', 'json'].includes(ext) || mimeType.startsWith('text/')) {
    return new TextDecoder().decode(bytes).split(/\n{2,}/).map((text, index) => ({ text: clean(text), location: `section ${index + 1}` })).filter((item) => item.text)
  }
  throw Object.assign(new Error('This file format is not supported for automatic text extraction'), { code: 'unsupported_document_format' })
}

export function extractCitedRequirements(sections, fileName) {
  const signal = /\b(shall|must|required|requirement|deliverable|minimum|no later than|due date|submission|security clearance|period of performance)\b/i
  const seen = new Set()
  const requirements = []
  for (const section of sections) {
    const statements = section.text.split(/(?<=[.!?;])\s+/)
    for (const statement of statements) {
      const text = clean(statement)
      const key = text.toLowerCase()
      if (text.length < 20 || text.length > 900 || !signal.test(text) || seen.has(key)) continue
      seen.add(key)
      requirements.push({ text, citation: { fileName, location: section.location } })
      if (requirements.length >= 100) return requirements
    }
  }
  return requirements
}

function pastPerformanceMetadata(sections) {
  const text = sections.map((item) => item.text).join('\n')
  const valueFor = (labels) => {
    const match = text.match(new RegExp(`(?:${labels.join('|')})\\s*[:\\-]\\s*([^\\n]{2,240})`, 'i'))
    return clean(match?.[1])
  }
  return {
    customer: valueFor(['customer', 'client', 'agency']),
    contractNumber: valueFor(['contract number', 'contract no\\.?']),
    periodOfPerformance: valueFor(['period of performance', 'performance period']),
    contractValue: valueFor(['contract value', 'award value', 'value']),
    scope: valueFor(['scope', 'description', 'services provided']),
    outcome: valueFor(['outcome', 'results', 'accomplishments']),
  }
}

function matchPastPerformance(opportunity, records) {
  const sourceTokens = new Set(clean([opportunity.title, opportunity.department, opportunity.agency, opportunity.noticeType].join(' ')).toLowerCase().match(/[a-z0-9]{3,}/g) || [])
  return records.map((record) => {
    const target = `${record.service_category} ${record.file_name} ${record.extracted_text}`.toLowerCase()
    const matches = [...sourceTokens].filter((token) => target.includes(token))
    const score = Math.min(100, matches.length * 8 + (target.includes(clean(opportunity.agency).toLowerCase()) ? 25 : 0))
    return { record, score, evidence: matches.slice(0, 12) }
  }).filter((item) => item.score >= 16).sort((a, b) => b.score - a.score).slice(0, 12)
}

async function downloadFile(token, driveId, file) {
  if (Number(file.size || 0) > MAX_FILE_BYTES) throw Object.assign(new Error('File exceeds the 15 MB automatic-analysis limit'), { code: 'document_too_large' })
  const response = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${encodeURIComponent(file.id)}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`Could not download ${file.name} for analysis (${response.status})`)
  return response.arrayBuffer()
}

async function listFolderFiles(token, driveId, root, serviceCategory = '') {
  const folders = [{ id: root.id, path: '', serviceCategory }]
  const files = []
  for (let index = 0; index < folders.length && index < 80; index += 1) {
    const folder = folders[index]
    let next = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folder.id}/children?$select=id,name,webUrl,folder,file,size,lastModifiedDateTime&$top=200`
    while (next) {
      const { body } = await graphResponse(next, token)
      for (const item of body.value || []) {
        const path = [folder.path, item.name].filter(Boolean).join('/')
        if (item.folder) folders.push({ id: item.id, path, serviceCategory: folder.path ? folder.serviceCategory : item.name })
        else files.push({ ...item, path, serviceCategory: folder.serviceCategory })
      }
      next = body['@odata.nextLink'] || ''
    }
  }
  return files
}

async function analyzeOpportunityFiles(env, workspace, files, token) {
  const existing = await env.EBUY_DB.prepare('SELECT * FROM opportunity_document_analysis WHERE opportunity_key = ?')
    .bind(workspace.opportunityKey).all()
  const byItem = new Map((existing.results || []).map((row) => [row.sharepoint_item_id, row]))
  const changed = files.filter((file) => byItem.get(file.id)?.source_signature !== signature(file)).slice(0, MAX_FILES_PER_RUN)
  for (const file of changed) {
    const now = new Date().toISOString()
    let status = 'ready'; let text = ''; let requirements = []; let errorMessage = null
    try {
      const sections = await extractDocumentSections(await downloadFile(token, workspace.sharePointDriveId, file), file.name, file.mimeType || '')
      text = sections.map((item) => item.text).join('\n').slice(0, 250000)
      requirements = extractCitedRequirements(sections, file.name)
    } catch (error) { status = error.code === 'unsupported_document_format' ? 'unsupported' : 'error'; errorMessage = error.message }
    await env.EBUY_DB.prepare(`INSERT INTO opportunity_document_analysis (
        id, opportunity_key, sharepoint_drive_id, sharepoint_item_id, file_name, file_path, source_kind,
        source_signature, status, extracted_text, requirements_json, summary, error_message, analyzed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'opportunity', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(opportunity_key, sharepoint_item_id) DO UPDATE SET file_name = excluded.file_name,
        file_path = excluded.file_path, source_signature = excluded.source_signature, status = excluded.status,
        extracted_text = excluded.extracted_text, requirements_json = excluded.requirements_json,
        summary = excluded.summary, error_message = excluded.error_message, analyzed_at = excluded.analyzed_at,
        updated_at = excluded.updated_at`)
      .bind(crypto.randomUUID(), workspace.opportunityKey, workspace.sharePointDriveId, file.id, file.name, file.path || '', signature(file), status, text, JSON.stringify(requirements), clean(text).slice(0, 800), errorMessage, now, now, now).run()
  }
  return { processed: changed.length, remaining: Math.max(0, files.filter((file) => byItem.get(file.id)?.source_signature !== signature(file)).length - changed.length) }
}

async function analyzePastPerformance(env, workspace, token) {
  const driveId = driveIdFor(env)
  const workbook = await getItem(env, token, driveId, env.WORKBOOK_ID)
  const root = await childByName(env, token, driveId, workbook.parentReference.id, PAST_PERFORMANCE_FOLDER)
  if (!root?.folder) return { processed: 0, remaining: 0, missing: true }
  const files = await listFolderFiles(token, driveId, root)
  const current = await env.EBUY_DB.prepare('SELECT * FROM past_performance_documents').all()
  const byItem = new Map((current.results || []).map((row) => [row.sharepoint_item_id, row]))
  const changed = files.filter((file) => byItem.get(file.id)?.source_signature !== signature(file)).slice(0, MAX_FILES_PER_RUN)
  for (const file of changed) {
    const now = new Date().toISOString()
    let status = 'ready'; let text = ''; let metadata = {}; let errorMessage = null
    try {
      const sections = await extractDocumentSections(await downloadFile(token, driveId, file), file.name, file.file?.mimeType || '')
      text = sections.map((item) => item.text).join('\n').slice(0, 250000)
      metadata = pastPerformanceMetadata(sections)
    } catch (error) { status = error.code === 'unsupported_document_format' ? 'unsupported' : 'error'; errorMessage = error.message }
    await env.EBUY_DB.prepare(`INSERT INTO past_performance_documents (
        id, sharepoint_drive_id, sharepoint_item_id, service_category, file_name, file_path,
        source_signature, status, extracted_text, metadata_json, error_message, analyzed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sharepoint_item_id) DO UPDATE SET service_category = excluded.service_category,
        file_name = excluded.file_name, file_path = excluded.file_path, source_signature = excluded.source_signature,
        status = excluded.status, extracted_text = excluded.extracted_text, metadata_json = excluded.metadata_json,
        error_message = excluded.error_message, analyzed_at = excluded.analyzed_at, updated_at = excluded.updated_at`)
      .bind(crypto.randomUUID(), driveId, file.id, file.serviceCategory || 'Uncategorized', file.name, file.path, signature(file), status, text, JSON.stringify(metadata), errorMessage, now, now, now).run()
  }
  const ready = await env.EBUY_DB.prepare("SELECT * FROM past_performance_documents WHERE status = 'ready'").all()
  const matches = matchPastPerformance(workspace, ready.results || [])
  const matchNow = new Date().toISOString()
  await env.EBUY_DB.prepare('DELETE FROM opportunity_past_performance_matches WHERE opportunity_key = ?').bind(workspace.opportunityKey).run()
  if (matches.length) await env.EBUY_DB.batch(matches.map((match) => env.EBUY_DB.prepare(`INSERT INTO opportunity_past_performance_matches
      (opportunity_key, past_performance_id, score, evidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(workspace.opportunityKey, match.record.id, match.score, JSON.stringify(match.evidence), matchNow, matchNow)))
  return { processed: changed.length, remaining: Math.max(0, files.filter((file) => byItem.get(file.id)?.source_signature !== signature(file)).length - changed.length), missing: false }
}

export async function runDocumentAnalysis(env, opportunityKey) {
  const workspace = await getWorkspace(env.EBUY_DB, opportunityKey)
  if (!workspace?.rootFolderId) throw Object.assign(new Error('Set up the opportunity workspace before analyzing documents'), { status: 409 })
  const token = await getAppOnlyGraphToken(env)
  const index = await listWorkspaceFlatFiles(env, workspace)
  const opportunity = await analyzeOpportunityFiles(env, workspace, index.files, token)
  const pastPerformance = await analyzePastPerformance(env, workspace, token)
  return { opportunity, pastPerformance }
}

export async function runSAMArchiveDocumentAnalysis(env, input) {
  const archive = await findSAMArchive(env.EBUY_DB, input)
  if (!archive) throw Object.assign(new Error('SAM.gov attachment archive is not ready yet'), { status: 409 })
  const token = await getAppOnlyGraphToken(env)
  const key = normalizeWorkspaceKey(archive.opportunityKey)
  const source = {
    opportunityKey: key,
    sharePointDriveId: archive.sharePointDriveId || '',
    title: archive.title,
    department: archive.department,
    agency: archive.agency,
    noticeType: input.noticeType || '',
  }
  // Archive files can theoretically span drives after a move. Analyze each
  // drive group independently while preserving one opportunity identity.
  let processed = 0; let remaining = 0
  const grouped = new Map()
  for (const original of archive.files || []) {
    if (!original.itemId || !original.sharePointDriveId) continue
    const item = { id: original.itemId, name: original.fileName, path: original.fileName, size: original.byteSize, mimeType: original.contentType, lastModifiedDateTime: original.sourceSignature || original.archivedAt }
    if (!grouped.has(original.sharePointDriveId)) grouped.set(original.sharePointDriveId, [])
    grouped.get(original.sharePointDriveId).push(item)
  }
  for (const [driveId, driveFiles] of grouped) {
    const result = await analyzeOpportunityFiles(env, { ...source, sharePointDriveId: driveId }, driveFiles, token)
    processed += result.processed; remaining += result.remaining
  }
  const pastPerformance = await analyzePastPerformance(env, source, token)
  return { opportunity: { processed, remaining }, pastPerformance }
}

export async function runEbuyArchiveDocumentAnalysis(env, requestId) {
  const [archive, opportunity] = await Promise.all([
    getEbuyWorkspaceArchive(env.EBUY_DB, requestId),
    findEbuyPipelineSource(env.EBUY_DB, requestId),
  ])
  if (!archive) throw Object.assign(new Error('eBuy attachment archive is not ready yet'), { status: 409 })
  const token = await getAppOnlyGraphToken(env)
  const source = {
    opportunityKey: normalizeWorkspaceKey(archive.requestId),
    sharePointDriveId: '',
    title: opportunity?.title || '', department: opportunity?.buyerDepartment || '',
    agency: opportunity?.buyerAgency || '', noticeType: opportunity?.requestType || '',
  }
  let processed = 0; let remaining = 0
  const grouped = new Map()
  for (const file of archive.attachments || []) {
    if (!file.sharepoint_item_id || !file.sharepoint_drive_id) continue
    const item = { id: file.sharepoint_item_id, name: file.file_name, path: file.file_name, size: file.byte_size, mimeType: file.content_type, lastModifiedDateTime: file.source_hash || file.archived_at }
    if (!grouped.has(file.sharepoint_drive_id)) grouped.set(file.sharepoint_drive_id, [])
    grouped.get(file.sharepoint_drive_id).push(item)
  }
  for (const [driveId, files] of grouped) {
    const result = await analyzeOpportunityFiles(env, { ...source, sharePointDriveId: driveId }, files, token)
    processed += result.processed; remaining += result.remaining
  }
  const pastPerformance = await analyzePastPerformance(env, source, token)
  return { opportunity: { processed, remaining }, pastPerformance }
}

export async function getDocumentAnalysis(env, opportunityKey) {
  const key = normalizeWorkspaceKey(opportunityKey)
  if (!key) throw Object.assign(new Error('An opportunity identifier is required'), { status: 400 })
  const [documents, matches] = await Promise.all([
    env.EBUY_DB.prepare('SELECT file_name, file_path, status, requirements_json, summary, error_message, analyzed_at FROM opportunity_document_analysis WHERE opportunity_key = ? ORDER BY updated_at DESC').bind(key).all(),
    env.EBUY_DB.prepare(`SELECT p.file_name, p.file_path, p.service_category, p.metadata_json, m.score, m.evidence_json
      FROM opportunity_past_performance_matches m JOIN past_performance_documents p ON p.id = m.past_performance_id
      WHERE m.opportunity_key = ? ORDER BY m.score DESC`).bind(key).all(),
  ])
  return {
    documents: (documents.results || []).map((row) => ({ fileName: row.file_name, filePath: row.file_path, status: row.status, requirements: JSON.parse(row.requirements_json || '[]'), summary: row.summary, error: row.error_message, analyzedAt: row.analyzed_at })),
    requirements: (documents.results || []).flatMap((row) => JSON.parse(row.requirements_json || '[]')),
    pastPerformance: (matches.results || []).map((row) => ({ fileName: row.file_name, filePath: row.file_path, serviceCategory: row.service_category, score: row.score, metadata: JSON.parse(row.metadata_json || '{}'), evidence: JSON.parse(row.evidence_json || '[]') })),
  }
}
