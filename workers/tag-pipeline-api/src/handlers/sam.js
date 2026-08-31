/**
 * sam.js — SAM.gov Get Opportunities integration
 *
 * Triggered on demand via POST /sam/trigger from the frontend.
 * The signed-in user's MSAL token is passed in the Authorization header
 * and the SAM config (NAICS codes, window settings) read from SAMConfig tables.
 * No app-only credentials needed — workbook access uses the user's delegated token.
 *
 * POST /sam/trigger body:
 *   {
 *     config: {
 *       naicsCodes:  string[],  // from SAMNAICSTable
 *       skipDays:    number,    // from SAMSettingsTable
 *       windowDays:  number,    // from SAMSettingsTable
 *     },
 *     force:  boolean,          // if true, skip 12h throttle check (Settings page force pull)
 *   }
 *
 * GET  /sam/key-status   — { expired: bool }
 * GET  /sam/run-status   — last run log from KV
 * GET  /sam/debug        — step-by-step diagnostic for authenticated users
 *
 * Secrets required:
 *   SAM_API_KEY         — SAM.gov public API key (expires every 90 days)
 *                         Rotate: wrangler secret put SAM_API_KEY
 *   WORKBOOK_ID         — SharePoint workbook item ID (same as VITE_ONEDRIVE_FILE_ID)
 */

const SAM_BASE  = 'https://api.sam.gov/opportunities/v2/search'
import { getAppOnlyGraphToken } from '../lib/graph.js'
import { putAutomationRun } from '../lib/automationHealth.js'
import { isRfiWorkflowNoticeType } from '../lib/noticeTypes.js'
import { isSAMApiUrl, normalizeSAMOpportunityDetail, samDescriptionText } from '../lib/samOpportunityDetail.js'
import {
  claimSAMArchive,
  ensureSAMArchive,
  findSAMArchive,
  getSAMArchive,
  markSAMArchiveReviewState,
  samArchiveStorageReady,
  updateSAMArchive,
} from '../lib/samArchiveRepository.js'
import { cancelDocumentAnalysis, getDocumentAnalysis, reviewDocumentFinding, runSAMArchiveDocumentAnalysis } from '../lib/documentAnalysis.js'
// Pulls are intentionally paged in small, checkpointable units. The browser
// advances delegated pulls while it remains open. Autonomous pulls use a
// Cloudflare Workflow so every unit gets its own retryable durable step.
const PAGE_SIZE = 10
const PAGE_DELAY = 250   // ms between paginated follow-up requests
const FOLLOW_UP_CACHE_TTL_SECONDS = 12 * 60 * 60
const FOLLOW_UP_MAX_PAGES = 4
const FOLLOW_ON_TITLE_MATCHER_VERSION = 2
// SAM rejects a range whose endpoints are exactly a calendar year apart in
// practice, despite documenting a one-year maximum. Keep every individual
// request strictly below that boundary and combine adjacent windows.
const MAX_SAM_DATE_RANGE_DAYS = 364

// Shared subrequest budget — Cloudflare Workers cap outbound fetch() calls
// per request (50 on the free plan, higher on paid). Every SAM.gov fetch,
// every Graph API read/write/delete, and every KV put/get all count against
// this. Kept as module-level constants so the write cap and the delete cap
// can be reasoned about together.
const MAX_WRITES_PER_RUN  = 10
const MAX_DELETES_PER_RUN = 10
const DISCOVERY_PROCUREMENT_TYPES = ['r', 'o', 'k']

// Hardcoded — matches frontend graphService.js constant exactly
const DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'

// ── Helpers ───────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Fetch with retry for transient upstream failures ────────────────────
// SAM.gov's API periodically returns 5xx errors (e.g. "no healthy upstream")
// during brief infrastructure blips. Those are worth a couple of quick
// retries. 4xx errors (bad request, bad/expired key, etc) are NOT retried —
// retrying an unchanged request against those just wastes subrequest budget.
async function fetchWithRetry(url, { maxRetries = 2, baseDelayMs = 400 } = {}) {
  let lastRes
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url)
    if (res.status < 500) return res   // success, or a non-retryable client error
    lastRes = res
    if (attempt < maxRetries) await sleep(baseDelayMs * Math.pow(2, attempt))
  }
  return lastRes   // exhausted retries — caller handles the still-failing response
}

function todayISO() {
  return new Date().toISOString().split('T')[0]
}

function formatDateParam(d) {
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd   = String(d.getUTCDate()).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  return `${mm}/${dd}/${yyyy}`
}

function dateFromValue(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return isNaN(date.getTime()) ? null : date
}

function splitSAMDateRange(from, to) {
  const windows = []
  const last = new Date(to)
  let start = new Date(from)
  while (start <= last) {
    const end = new Date(start)
    end.setUTCDate(end.getUTCDate() + MAX_SAM_DATE_RANGE_DAYS)
    if (end > last) end.setTime(last.getTime())
    windows.push({ from: new Date(start), to: end })
    start = new Date(end)
    start.setUTCDate(start.getUTCDate() + 1)
  }
  return windows
}

function parseResponseDate(val) {
  if (!val) return ''
  const s = String(val).trim()
  // ISO datetime with a time component — preserve it in full (including
  // timezone offset if present) so the frontend can show the actual
  // response deadline time, not just the date. Previously this was always
  // truncated to date-only even when SAM.gov sent a real deadline time.
  const isoDateTime = s.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  if (isoDateTime) return s
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const us = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (us) return `${us[3]}-${us[1]}-${us[2]}`
  return s.slice(0, 10)
}

export function parsePOC(pocList) {
  if (!Array.isArray(pocList) || pocList.length === 0) return ''
  const ordered = [...pocList].sort((left, right) =>
    Number(String(right?.type || '').toLowerCase() === 'primary') - Number(String(left?.type || '').toLowerCase() === 'primary')
  )
  const unique = new Map()
  ordered.forEach((poc) => {
    const name = String(poc?.fullName || poc?.fullname || '').trim()
    const email = String(poc?.email || '').trim()
    const phone = String(poc?.phone || '').trim()
    const key = email.toLowerCase() || `${name.toLowerCase()}|${phone}`
    if (key && !unique.has(key)) unique.set(key, [name, email, phone].filter(Boolean).join(' | '))
  })
  return [...unique.values()].join('\n')
}

export function parseOrg(fullParentPathName) {
  const parts = String(fullParentPathName || '').split('.').map((s) => s.trim()).filter(Boolean)
  return {
    department: parts[0] || '',
    agency:     parts[1] || parts[0] || '',
    office:     parts[2] || '',
  }
}

// ── Solicitation-number dedup helpers ───────────────────────────────────────
// Two different Notice IDs can represent the same underlying opportunity —
// SAM.gov commonly reissues/amends a notice under a new Notice ID while
// keeping the same Solicitation Number. Notice-ID-only dedup (the existing
// behavior) doesn't catch this, so the same opportunity can show up twice
// under different Notice IDs. These helpers let us also dedup by
// Solicitation Number and keep only the most recently posted variant.

function normalizeSolNum(s) {
  return String(s || '').trim().toUpperCase()
}

export function solicitationFamily(value) {
  return normalizeSolNum(value)
    .replace(/(?:[_-](?:AMEND(?:MENT)?[_-]?)?\d{1,4})$/i, '')
    .replace(/(?:\.\d{1,4})$/i, '')
}

function normalizeNoticeId(s) {
  return String(s || '').trim().toUpperCase()
}

// True if `a` is strictly more recent than `b`. Both are already normalized
// to 'YYYY-MM-DD' by parseResponseDate, so a plain string compare works.
// An empty/missing date sorts as "oldest", so a record with a real posted
// date always wins over one without.
function newerRecord(aPostedDate, bPostedDate) {
  return String(aPostedDate || '') > String(bPostedDate || '')
}

// ── Graph API helpers (using frontend-supplied delegated token) ────────────

function workbookBase(env) {
  return `https://graph.microsoft.com/v1.0/drives/${DRIVE_ID}/items/${env.WORKBOOK_ID}/workbook`
}

async function graphFetch(env, token, path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const retryableRead = method === 'GET'
  const maxRetries = retryableRead ? 2 : 0

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const res = await fetch(`${workbookBase(env)}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    })

    if (res.status === 204) return null

    // Excel occasionally returns a plain-text 502/503/504 response instead of
    // Graph JSON. Retry only reads: retrying a row-add after an ambiguous
    // gateway failure could create a duplicate opportunity.
    if (retryableRead && [429, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get('Retry-After'))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 350 * Math.pow(2, attempt)
      await sleep(delay)
      continue
    }

    const raw = await res.text()
    let data = null
    if (raw) {
      try {
        data = JSON.parse(raw)
      } catch {
        if (!res.ok) throw new Error(`Graph error ${res.status}: ${raw.slice(0, 180)}`)
        throw new Error(`Graph returned an invalid JSON response (${res.status})`)
      }
    }
    if (!res.ok) throw new Error(data?.error?.message || `Graph error: ${res.status}`)
    return data
  }

  throw new Error('Graph read retry loop ended unexpectedly')
}

async function getTableData(env, token, tableName) {
  const [rowsData, colsData] = await Promise.all([
    graphFetch(env, token, `/tables/${tableName}/rows`),
    graphFetch(env, token, `/tables/${tableName}/columns`),
  ])
  const headers = (colsData?.value || []).map((c) => c.name)
  const rows = (rowsData?.value || []).map((row) => {
    const obj = {}
    headers.forEach((h, i) => { obj[h] = row.values[0][i] })
    obj._rowIndex = row.index
    return obj
  })
  return { headers, rows }
}

async function getTableRows(env, token, tableName) {
  return (await getTableData(env, token, tableName)).rows
}

export function isFlaggedSAMOpportunity(row) {
  return ['yes', 'true', '1', 'flagged'].includes(String(row?.Flagged || '').trim().toLowerCase())
}

// ── Delete expired + solicitation-superseded rows, one shared cap ──────────
// (sequential, capped to preserve subrequest budget; descending index order
// so earlier deletes don't shift the row indices of later ones)

async function cleanupRows(env, token, existingRows, dedupDeleteRowIndices = new Set()) {
  const today = todayISO()
  const expiredIndices = existingRows
    .filter((r) => {
      if (String(r.Status || '').trim().toLowerCase() === 'dismissed') return false
      if (isFlaggedSAMOpportunity(r)) return false
      const rd = String(r['Response Date'] || '').trim().slice(0, 10)
      return rd && rd < today
    })
    .map((r) => r._rowIndex)

  // Combine both cleanup reasons under one cap so we never risk exceeding
  // the subrequest budget even when a run has both expired rows AND
  // solicitation-superseded duplicates to remove. De-duped via Set in case
  // a row happens to be both (rare, but possible).
  const dismissedIndices = new Set(existingRows
    .filter((row) => String(row.Status || '').trim().toLowerCase() === 'dismissed')
    .map((row) => row._rowIndex))
  const flaggedIndices = new Set(existingRows
    .filter(isFlaggedSAMOpportunity)
    .map((row) => row._rowIndex))
  const allIndices = [...new Set([...expiredIndices, ...dedupDeleteRowIndices])]
    .filter((rowIndex) => !dismissedIndices.has(rowIndex) && !flaggedIndices.has(rowIndex))
    .sort((a, b) => b - a)   // descending so indices stay valid as we delete
    .slice(0, MAX_DELETES_PER_RUN)

  for (const rowIndex of allIndices) {
    await graphFetch(env, token,
      `/tables/NewOpportunitiesTable/rows/itemAt(index=${rowIndex})`,
      { method: 'DELETE' }
    )
  }
  return allIndices.length
}

// ── Append a new opportunity row ──────────────────────────────────────────

const NEW_OPP_HEADERS = [
  'Notice ID', 'Solicitation Number', 'Title', 'Set-Aside Type',
  'Department', 'Agency', 'Office', 'Response Date', 'Point of Contact',
  'NAICS Code', 'Posted Date', 'SAM.gov URL', 'Date Added', 'Status',
  'Notice Type', 'Flagged',
]

async function appendOpportunity(env, token, data, headers = NEW_OPP_HEADERS) {
  const row = headers.map((h) => data[h] ?? '')
  await graphFetch(env, token, '/tables/NewOpportunitiesTable/rows/add', {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  })
}

async function updateOpportunityRow(env, token, rowIndex, data, headers = NEW_OPP_HEADERS) {
  const row = headers.map((header) => data[header] ?? '')
  await graphFetch(env, token,
    `/tables/NewOpportunitiesTable/rows/itemAt(index=${rowIndex})`,
    {
      method: 'PATCH',
      body: JSON.stringify({ values: [row] }),
    },
  )
}

// ── SAM API fetcher ───────────────────────────────────────────────────────

async function fetchSAMForNAICS(env, naicsCode, postedFrom, postedTo, rdlFrom, rdlTo, offset = 0) {
  const params = new URLSearchParams({
    api_key:    env.SAM_API_KEY,
    ncode:      naicsCode,
    postedFrom,
    postedTo,
    rdlfrom:    rdlFrom,
    rdlto:      rdlTo,
    limit:      String(PAGE_SIZE),
    offset:     String(offset),
  })
  // SAM documents ptype as a repeatable array parameter. One paginated query
  // therefore discovers Sources Sought, Solicitations, and Combined
  // Synopsis/Solicitations without tripling the Workflow checkpoints.
  DISCOVERY_PROCUREMENT_TYPES.forEach((type) => params.append('ptype', type))

  const res = await fetchWithRetry(`${SAM_BASE}?${params}`)

  if (res.status === 401) {
    await setKeyExpired(env, true)
    throw Object.assign(new Error('SAM API key expired or invalid'), { code: 'KEY_EXPIRED' })
  }
  if (res.status === 204) return { records: [], nextOffset: offset, hasMore: false }
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`SAM API error ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = await res.json()
  const records = data.opportunitiesData || []
  const total = Number(data.totalRecords)
  const nextOffset = offset + records.length
  return {
    records,
    nextOffset,
    hasMore: records.length === PAGE_SIZE && (!Number.isFinite(total) || nextOffset < total),
  }
}

// ── Map a SAM record to our column structure ──────────────────────────────

export function normalizeDiscoveryNoticeType(...values) {
  const types = values
    .flat()
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean)
  const combined = types.join(' ')
  if (types.includes('MRAS') || combined.includes('MARKET RESEARCH')) return 'MRAS'
  if (types.includes('K') || types.includes('RFQ') || combined.includes('COMBINED')) return 'RFQ'
  if (types.includes('O') || types.includes('RFP') || combined.includes('SOLICITATION')) return 'RFP'
  if (types.includes('R') || types.includes('RFI') || (combined.includes('SOURCE') && combined.includes('SOUGHT'))) return 'RFI'
  return ''
}

function mapRecord(raw, naicsCode) {
  const org = parseOrg(raw.fullParentPathName)
  const noticeType = normalizeDiscoveryNoticeType(raw.type, raw.baseType, raw.title)
  return {
    'Notice ID':           String(raw.noticeId || '').trim(),
    'Solicitation Number': String(raw.solicitationNumber || '').trim(),
    'Title':               String(raw.title || '').trim(),
    'Set-Aside Type':      String(raw.typeOfSetAsideDescription || '').trim(),
    'Department':          org.department,
    'Agency':              org.agency,
    'Office':              org.office,
    'Response Date':       parseResponseDate(raw.responseDeadLine),
    'Point of Contact':    parsePOC(raw.pointOfContact),
    'NAICS Code':          naicsCode,
    'Posted Date':         parseResponseDate(raw.postedDate),
    'SAM.gov URL':         String(raw.uiLink || '').trim(),
    'Date Added':          todayISO(),
    'Status':              'new',
    'Notice Type':         noticeType,
  }
}

export function samArchiveInputForDiscoveryRow(row = {}) {
  const noticeId = String(row['Notice ID'] || '').trim()
  const solicitationNumber = String(row['Solicitation Number'] || '').trim()
  const opportunityKey = String(solicitationNumber || noticeId).trim().toLowerCase()
  if (!opportunityKey) return null
  return {
    opportunityKey,
    noticeId,
    solicitationNumber,
    title: String(row.Title || '').trim(),
    department: String(row.Department || '').trim(),
    agency: String(row.Agency || '').trim(),
  }
}

function safeArchiveInstancePart(value) {
  return String(value || 'opportunity').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 55)
}

async function queueNewSAMArchives(env, rows) {
  if (!env.SAM_ARCHIVE_WORKFLOW?.createBatch) return { queued: 0, unavailable: true }
  const requests = rows
    .map(samArchiveInputForDiscoveryRow)
    .filter(Boolean)
    .map((archiveInput) => ({
      id: `sam-archive-new-${safeArchiveInstancePart(archiveInput.opportunityKey)}-${crypto.randomUUID().slice(0, 8)}`,
      params: { opportunityKey: archiveInput.opportunityKey, cursor: 0, archiveInput },
      retention: { successRetention: '3 days', errorRetention: '7 days' },
    }))
  if (!requests.length) return { queued: 0 }
  const instances = await env.SAM_ARCHIVE_WORKFLOW.createBatch(requests)
  return { queued: instances.filter(Boolean).length }
}

export async function fetchSAMOpportunityRecord(env, { noticeId = '', solicitationNumber = '', postedDate = '' } = {}) {
  if (!env.SAM_API_KEY) throw Object.assign(new Error('SAM_API_KEY not configured'), { status: 503 })
  const notice = String(noticeId || '').trim()
  const solicitation = String(solicitationNumber || '').trim()
  if (!notice && !solicitation) throw Object.assign(new Error('A notice ID or solicitation number is required'), { status: 400 })
  const today = new Date()
  const posted = postedDate ? new Date(postedDate) : null
  const anchor = posted && !Number.isNaN(posted.getTime()) ? posted : today
  const from = new Date(anchor)
  const to = new Date(anchor)
  from.setUTCDate(from.getUTCDate() - Math.floor(MAX_SAM_DATE_RANGE_DAYS / 2))
  to.setUTCDate(to.getUTCDate() + Math.floor(MAX_SAM_DATE_RANGE_DAYS / 2))
  if (to > today) to.setTime(today.getTime())
  const params = new URLSearchParams({
    api_key: env.SAM_API_KEY,
    postedFrom: formatDateParam(from),
    postedTo: formatDateParam(to),
    limit: '10',
    offset: '0',
  })
  if (notice) params.set('noticeid', notice)
  else params.set('solnum', solicitation)
  const response = await fetchWithRetry(`${SAM_BASE}?${params}`)
  if (response.status === 401) {
    await setKeyExpired(env, true)
    throw Object.assign(new Error('SAM API key expired or invalid'), { status: 502, code: 'KEY_EXPIRED' })
  }
  if (response.status === 204) throw Object.assign(new Error('The SAM.gov opportunity was not found'), { status: 404 })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(payload?.message || `SAM.gov opportunity lookup failed (${response.status})`), { status: 502 })
  const records = payload?.opportunitiesData || []
  const record = records.find((item) => notice && normalizeNoticeId(item.noticeId) === normalizeNoticeId(notice))
    || records.find((item) => solicitation && normalizeSolNum(item.solicitationNumber) === normalizeSolNum(solicitation))
    || records[0]
  if (!record) throw Object.assign(new Error('The SAM.gov opportunity was not found'), { status: 404 })
  return record
}

export async function resolveSAMOpportunityDescription(env, record) {
  const descriptionUrl = String(record?.description || '').trim()
  if (!isSAMApiUrl(descriptionUrl)) {
    return { ...record, descriptionText: samDescriptionText(record?.description) }
  }
  try {
    const url = new URL(descriptionUrl)
    if (!/\/opportunities\/v1\/noticedesc$/i.test(url.pathname)) return { ...record, descriptionText: '' }
    url.searchParams.set('api_key', env.SAM_API_KEY)
    const response = await fetchWithRetry(url.toString())
    if (!response.ok) {
      console.warn(JSON.stringify({ event: 'sam_description_fetch_failed', noticeId: record?.noticeId, status: response.status }))
      return { ...record, descriptionText: '' }
    }
    const raw = await response.text()
    let payload = raw
    try { payload = JSON.parse(raw) } catch { /* some SAM responses are plain HTML/text */ }
    return { ...record, descriptionText: samDescriptionText(payload) }
  } catch (error) {
    console.warn(JSON.stringify({ event: 'sam_description_fetch_failed', noticeId: record?.noticeId, message: error.message }))
    return { ...record, descriptionText: '' }
  }
}

function mergeSAMArchive(detail, archive) {
  if (!archive) return { ...detail, archive: null }
  const files = new Map(archive.files.map((file) => [file.sourceUrl, file]))
  return {
    ...detail,
    attachments: detail.attachments.map((attachment) => ({
      ...attachment,
      ...(files.get(attachment.sourceUrl) || {}),
    })),
    archive: {
      opportunityKey: archive.opportunityKey,
      archiveStatus: archive.archiveStatus,
      progressPhase: archive.progressPhase,
      attachmentTotal: archive.attachmentTotal,
      archivedCount: archive.archivedCount,
      failedCount: archive.failedCount,
      errorMessage: archive.errorMessage,
      webUrl: archive.webUrl,
      updatedAt: archive.updatedAt,
    },
  }
}

async function startSAMArchive(env, detail, { force = false } = {}) {
  if (!env.EBUY_DB || !(await samArchiveStorageReady(env.EBUY_DB))) {
    throw Object.assign(new Error('Apply the latest D1 migration to enable the SAM.gov archive'), { status: 503, code: 'migration_required' })
  }
  if (!env.SAM_ARCHIVE_WORKFLOW?.createBatch) {
    throw Object.assign(new Error('SAM.gov archive Workflow is not configured'), { status: 503 })
  }
  const opportunityKey = String(detail.solicitationNumber || detail.noticeId).trim().toLowerCase()
  let archive = await ensureSAMArchive(env.EBUY_DB, {
    opportunityKey,
    noticeId: detail.noticeId,
    solicitationNumber: detail.solicitationNumber,
    title: detail.title,
    department: detail.organization?.department,
    agency: detail.organization?.subTier,
    attachmentTotal: detail.attachments.length,
  })
  const instanceId = `sam-archive-${crypto.randomUUID()}`
  const claimed = await claimSAMArchive(env.EBUY_DB, opportunityKey, instanceId, { force })
  if (!claimed) return { started: false, archive }
  try {
    const instances = await env.SAM_ARCHIVE_WORKFLOW.createBatch([{
      id: instanceId,
      params: { opportunityKey, cursor: 0 },
      retention: { successRetention: '3 days', errorRetention: '7 days' },
    }])
    archive = await updateSAMArchive(env.EBUY_DB, opportunityKey, { workflowInstanceId: instances[0]?.id || instanceId })
    return { started: Boolean(instances[0]), instanceId: instances[0]?.id || instanceId, archive }
  } catch (error) {
    await updateSAMArchive(env.EBUY_DB, opportunityKey, { archiveStatus: 'error', progressPhase: 'SAM.gov archive could not start', errorMessage: error.message })
    throw Object.assign(new Error(`Could not start the SAM.gov archive: ${error.message}`), { status: 502 })
  }
}

function normalizedNoticeType(value) {
  return normalizeDiscoveryNoticeType(value)
}

function solicitationDedupKey(solicitationNumber, noticeType) {
  const solicitation = normalizeSolNum(solicitationNumber)
  return solicitation ? `${normalizedNoticeType(noticeType)}:${solicitation}` : ''
}

// ── RFI follow-on matcher ────────────────────────────────────────────────
// Finds RFP or RFQ follow-ons for an RFI, MRAS, or RFQ opportunity.
// The SAM API cannot express every one of our matching rules as a query
// parameter. Procurement type is the only hard gate; organizational continuity,
// POC, NAICS, title language, and explicit source references are weighted evidence.

// Keep every title term, including common procurement words. Common words
// carry less weight than distinctive subject-matter terms, but they still
// contribute to both eligibility and the evidence shown to reviewers.
const TITLE_FILLER_WORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the',
  'this', 'that', 'to', 'with', 'will',
])
const TITLE_PROCUREMENT_WORDS = new Set([
  'contract', 'program', 'project', 'requirement', 'service', 'support',
])
const TITLE_PHRASE_ALIASES = [
  [/\bcyber\s+security\b/g, 'cybersecurity'],
  [/\bdata\s+cent(?:er|re)\b/g, 'datacenter'],
  [/\bhelp\s+desk\b/g, 'helpdesk'],
  [/\bhealth\s+care\b/g, 'healthcare'],
  [/\binformation\s+technology\b/g, 'it'],
  [/\boperations?\s+and\s+maintenance\b/g, 'om'],
  [/\bartificial\s+intelligence\b/g, 'ai'],
  [/\bmachine\s+learning\b/g, 'ml'],
  [/\bidentity\s+and\s+access\s+management\b/g, 'iam'],
  [/\bquality\s+assurance\b/g, 'qa'],
  [/\belectronic\s+health\s+records?\b/g, 'ehr'],
  [/\benterprise\s+resource\s+planning\b/g, 'erp'],
  [/\bcustomer\s+relationship\s+management\b/g, 'crm'],
]
const TITLE_TOKEN_ALIASES = new Map([
  ['cyber', 'cybersecurity'], ['infosec', 'cybersecurity'],
  ['workforce', 'personnel'],
  ['purchase', 'acquisition'], ['procurement', 'acquisition'],
  ['consultancy', 'consulting'], ['advisory', 'consulting'],
  ['modernisation', 'modernization'],
  ['catalogue', 'catalog'],
])

const DEFAULT_FOLLOW_UP_RULES = {
  departmentRule: 'Exact',
  agencyRule: 'Exact',
  pocRule: 'Exact',
  titleOverlapPercent: 40,
  noticeTypes: 'RFP, RFQ',
  submissionWindowDays: 364,
  noSubmissionLookbackDays: 150,
  noSubmissionLookaheadDays: 150,
}

function numberRule(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

function normalizedFollowUpRules(rules = {}) {
  const choice = (value) => String(value || '').trim()
  return {
    departmentRule: ['Exact', 'Ignore'].includes(choice(rules.departmentRule)) ? choice(rules.departmentRule) : DEFAULT_FOLLOW_UP_RULES.departmentRule,
    agencyRule: ['Exact', 'Ignore'].includes(choice(rules.agencyRule)) ? choice(rules.agencyRule) : DEFAULT_FOLLOW_UP_RULES.agencyRule,
    pocRule: ['Exact', 'Ignore'].includes(choice(rules.pocRule)) ? choice(rules.pocRule) : DEFAULT_FOLLOW_UP_RULES.pocRule,
    titleOverlapPercent: numberRule(rules.titleOverlapPercent, DEFAULT_FOLLOW_UP_RULES.titleOverlapPercent, 1, 100),
    noticeTypes: choice(rules.noticeTypes) || DEFAULT_FOLLOW_UP_RULES.noticeTypes,
    submissionWindowDays: numberRule(rules.submissionWindowDays, DEFAULT_FOLLOW_UP_RULES.submissionWindowDays, 1, 364),
    noSubmissionLookbackDays: numberRule(rules.noSubmissionLookbackDays, DEFAULT_FOLLOW_UP_RULES.noSubmissionLookbackDays, 0, 364),
    noSubmissionLookaheadDays: numberRule(rules.noSubmissionLookaheadDays, DEFAULT_FOLLOW_UP_RULES.noSubmissionLookaheadDays, 0, 364),
  }
}

export function requestedFollowUpTypes(noticeTypes) {
  // Keep the argument for backwards-compatible settings/workbook rows while
  // enforcing the supported follow-on path consistently. SAM uses `o` for
  // solicitation/RFP records and `k` for combined/RFQ records.
  void noticeTypes
  return ['o', 'k']
}

function normalized(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function cacheFingerprint(value) {
  let hash = 2166136261
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function singularTitleToken(token) {
  if (token.length <= 3 || token.endsWith('ss') || token.endsWith('us') || token.endsWith('is')) return token
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`
  if (/(?:sses|shes|ches|xes|zes)$/.test(token)) return token.slice(0, -2)
  if (token.endsWith('s')) return token.slice(0, -1)
  return token
}

function titleTokens(title) {
  let text = normalized(title)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
  TITLE_PHRASE_ALIASES.forEach(([pattern, replacement]) => { text = text.replace(pattern, replacement) })
  return text.split(/\s+/)
    .map((token) => singularTitleToken(token))
    .map((token) => TITLE_TOKEN_ALIASES.get(token) || token)
    .filter(Boolean)
}

function titleTokenWeight(token) {
  if (TITLE_FILLER_WORDS.has(token)) return 0.15
  if (TITLE_PROCUREMENT_WORDS.has(token)) return 0.45
  return 1
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + Number(left[leftIndex - 1] !== right[rightIndex - 1]),
      )
    }
    for (let index = 0; index < current.length; index++) previous[index] = current[index]
  }
  return previous[right.length]
}

function fuzzyTitleTokenMatch(left, right) {
  if (left.length < 5 || right.length < 5 || left[0] !== right[0]) return false
  return 1 - (editDistance(left, right) / Math.max(left.length, right.length)) >= 0.86
}

function phraseCoverage(sourceTokens, candidateTokens) {
  if (sourceTokens.length < 2) return null
  const candidatePhrases = new Set()
  for (const size of [2, 3]) {
    for (let index = 0; index <= candidateTokens.length - size; index++) {
      candidatePhrases.add(candidateTokens.slice(index, index + size).join(' '))
    }
  }
  let available = 0
  let matched = 0
  for (const size of [2, 3]) {
    for (let index = 0; index <= sourceTokens.length - size; index++) {
      const tokens = sourceTokens.slice(index, index + size)
      const weight = tokens.reduce((sum, token) => sum + titleTokenWeight(token), 0)
      available += weight
      if (candidatePhrases.has(tokens.join(' '))) matched += weight
    }
  }
  return available ? matched / available : null
}

export function matchFollowOnTitles(sourceTitle, candidateTitle) {
  const sourceTokens = titleTokens(sourceTitle)
  const candidateTokens = titleTokens(candidateTitle)
  const source = [...new Set(sourceTokens)]
  const candidate = [...new Set(candidateTokens)]
  if (!source.length || !candidate.length) return { percent: 0, matchedTerms: [], phrasePercent: 0 }

  const unusedCandidates = new Set(candidate)
  const matches = []
  source.forEach((sourceToken) => {
    if (unusedCandidates.has(sourceToken)) {
      unusedCandidates.delete(sourceToken)
      matches.push({ source: sourceToken, candidate: sourceToken, kind: 'exact' })
      return
    }
    const fuzzy = [...unusedCandidates].find((candidateToken) => fuzzyTitleTokenMatch(sourceToken, candidateToken))
    if (fuzzy) {
      unusedCandidates.delete(fuzzy)
      matches.push({ source: sourceToken, candidate: fuzzy, kind: 'fuzzy' })
    }
  })

  const sourceWeight = source.reduce((sum, token) => sum + titleTokenWeight(token), 0)
  const candidateWeight = candidate.reduce((sum, token) => sum + titleTokenWeight(token), 0)
  const matchedSourceWeight = matches.reduce((sum, match) => sum + titleTokenWeight(match.source), 0)
  const matchedCandidateWeight = matches.reduce((sum, match) => sum + titleTokenWeight(match.candidate), 0)
  const recall = matchedSourceWeight / sourceWeight
  const precision = matchedCandidateWeight / candidateWeight
  // F2 favours coverage of the original title while still penalizing a
  // candidate padded with largely unrelated language.
  const tokenScore = recall && precision ? (5 * precision * recall) / ((4 * precision) + recall) : 0
  const phraseScore = phraseCoverage(sourceTokens, candidateTokens)
  const combined = phraseScore === null ? tokenScore : (tokenScore * 0.8) + (phraseScore * 0.2)
  return {
    percent: Math.round(Math.min(1, combined) * 100),
    matchedTerms: matches.map((match) => match.kind === 'fuzzy' ? `${match.source}≈${match.candidate}` : match.source),
    phrasePercent: Math.round((phraseScore || 0) * 100),
  }
}

function matchingPOC(raw, email) {
  const target = normalized(email)
  if (!target || !Array.isArray(raw?.pointOfContact)) return null
  return raw.pointOfContact.find((poc) => normalized(poc?.email) === target) || null
}

function exactOrganizationMatch(left, right) {
  const key = (value) => {
    const aliased = normalized(value)
      .replace(/department of (?:defense|war) education activity|\bdowea\b/g, ' dodea ')
      .replace(/\bdept\b/g, ' department ')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9\s]/g, ' ')
    return aliased.split(/\s+/)
      .filter((token) => token && !new Set(['the', 'of', 'department', 'united', 'states', 'us']).has(token))
      .sort()
      .join(' ')
  }
  const a = key(left)
  const b = key(right)
  return Boolean(a && b && a === b)
}

function candidateText(raw) {
  return normalized([
    raw.title,
    raw.description,
    raw.additionalInfoLink,
    raw.solicitationNumber,
  ].filter(Boolean).join(' '))
}

function sourceReferences(raw, source) {
  const text = candidateText(raw)
  return [source.noticeId, source.solicitationNumber]
    .map(normalized)
    .filter((value) => value.length >= 5 && text.includes(value))
}

export function followUpCandidate(raw, source) {
  const rules = normalizedFollowUpRules(source.rules)
  const sourceSubmission = dateFromValue(source.submissionDate)
  const candidatePosted = dateFromValue(raw.postedDate)
  // A follow-on must be posted strictly AFTER the source was submitted. This
  // guards against a broad API response ever admitting an older notice.
  if (sourceSubmission && (!candidatePosted || candidatePosted <= sourceSubmission)) return null
  const org = parseOrg(raw.fullParentPathName)
  const departmentMatches = exactOrganizationMatch(org.department, source.department)
  const agencyMatches = exactOrganizationMatch(org.agency, source.agency)
  const officeMatches = exactOrganizationMatch(org.office, source.office)
  const poc = matchingPOC(raw, source.pocEmail)
  const titleMatch = matchFollowOnTitles(source.title, raw.title)
  const overlap = titleMatch.percent
  if (normalized(raw.noticeId) === normalized(source.noticeId)) return null

  // The criteria selected by the user determine eligibility. Additional
  // organization and procurement signals rank the qualifying candidates;
  // they must not impose an unrelated hidden score threshold.
  if (rules.departmentRule === 'Exact' && source.department && !departmentMatches) return null
  if (rules.agencyRule === 'Exact' && source.agency && !agencyMatches) return null
  if (rules.pocRule === 'Exact' && source.pocEmail && !poc) return null
  if (overlap < rules.titleOverlapPercent) return null

  const references = sourceReferences(raw, source)
  const candidateNaics = String(raw.naicsCode || raw.naics || '').trim()
  const naicsMatches = Boolean(candidateNaics && source.naicsCode && normalized(candidateNaics) === normalized(source.naicsCode))
  const reasons = []
  let score = 0
  if (references.length) { score += 50; reasons.push(`References ${references.join(' or ')}`) }
  if (poc) { score += 30; reasons.push('Same point of contact') }
  if (agencyMatches) { score += 25; reasons.push('Same agency') }
  if (departmentMatches) { score += 10; reasons.push('Same department') }
  if (officeMatches) { score += 10; reasons.push('Same office') }
  if (naicsMatches) { score += 15; reasons.push('Same NAICS') }
  const titlePoints = Math.min(25, Math.round(overlap / 4))
  if (titlePoints) {
    score += titlePoints
    const evidence = titleMatch.matchedTerms.slice(0, 6).join(', ')
    reasons.push(`${overlap}% title match${evidence ? ` (${evidence})` : ''}`)
  }

  // Ignored criteria do not add weight to the ranking.
  if (rules.departmentRule === 'Ignore' && departmentMatches) score -= 10
  if (rules.agencyRule === 'Ignore' && agencyMatches) score -= 25
  if (rules.pocRule === 'Ignore' && poc) score -= 30
  return {
    noticeId:           String(raw.noticeId || '').trim(),
    solicitationNumber: String(raw.solicitationNumber || '').trim(),
    title:              String(raw.title || '').trim(),
    setAsideType:       String(raw.typeOfSetAsideDescription || '').trim(),
    department:         org.department,
    agency:             org.agency,
    office:             org.office,
    responseDate:       parseResponseDate(raw.responseDeadLine),
    postedDate:         parseResponseDate(raw.postedDate),
    naicsCode:          candidateNaics,
    samLink:            String(raw.uiLink || '').trim(),
    pocName:            String(poc?.fullName || poc?.fullname || '').trim(),
    pocEmail:           String(poc?.email || '').trim(),
    pocPhone:           String(poc?.phone || '').trim(),
    type:               String(raw.type || '').trim(),
    noticeType:         normalizeDiscoveryNoticeType(raw.type, raw.baseType, raw.title),
    keywordOverlapPercent: overlap,
    titleMatchPercent:  overlap,
    titleMatchEvidence: titleMatch.matchedTerms,
    matchScore:         score,
    confidence:         score >= 70 ? 'Strong' : score >= 45 ? 'Likely' : 'Possible',
    matchReasons:       reasons,
  }
}

async function fetchFollowUpNotices(env, ptype, postedFrom, postedTo) {
  const records = []
  let offset = 0
  for (let page = 0; page < FOLLOW_UP_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      api_key: env.SAM_API_KEY,
      ptype,
      postedFrom,
      postedTo,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })
    const res = await fetchWithRetry(`${SAM_BASE}?${params}`)
    if (res.status === 204) break
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`SAM API error ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = await res.json()
    const pageRecords = data.opportunitiesData || []
    records.push(...pageRecords)
    const total = data.totalRecords ?? pageRecords.length
    offset += PAGE_SIZE
    if (offset >= total || pageRecords.length < PAGE_SIZE) break
    await sleep(PAGE_DELAY)
  }
  return records
}

export async function findRFIFollowUps(env, source) {
  const rules = normalizedFollowUpRules(source.rules)
  const now = new Date()
  const submissionDate = dateFromValue(source.submissionDate)
  const from = submissionDate ? new Date(submissionDate) : new Date(now)
  const to = submissionDate ? new Date(submissionDate) : new Date(now)

  if (submissionDate) {
    // Start on the following day: a follow-on must be posted strictly after
    // the source submission date, never on or before it.
    from.setUTCDate(from.getUTCDate() + 1)
    to.setUTCDate(to.getUTCDate() + rules.submissionWindowDays)
  } else {
    // With no submission date, use the configurable fallback around today.
    from.setUTCDate(from.getUTCDate() - rules.noSubmissionLookbackDays)
    to.setUTCDate(to.getUTCDate() + rules.noSubmissionLookaheadDays)
  }

  const responseSets = await Promise.all(
    splitSAMDateRange(from, to).flatMap(({ from: windowFrom, to: windowTo }) =>
      requestedFollowUpTypes(rules.noticeTypes).map((ptype) =>
        fetchFollowUpNotices(env, ptype, formatDateParam(windowFrom), formatDateParam(windowTo))
      )
    )
  )
  const unique = new Map()
  for (const raw of responseSets.flat()) {
    const candidate = followUpCandidate(raw, source)
    if (!candidate) continue
    const key = candidate.noticeId || candidate.solicitationNumber
    if (key && !unique.has(key)) unique.set(key, candidate)
  }
  return [...unique.values()].sort((a, b) =>
    Number(b.matchScore || 0) - Number(a.matchScore || 0) ||
    String(a.responseDate || '').localeCompare(String(b.responseDate || ''))
  )
}

// ── KV helpers ────────────────────────────────────────────────────────────

async function setKeyExpired(env, expired) {
  if (!env.CACHE) return
  const current = await env.CACHE.get('sam_key_expired', 'json')
  if (current?.expired === expired) return
  await env.CACHE.put('sam_key_expired', JSON.stringify({ expired }), {
    expirationTtl: 60 * 60 * 24 * 100,
  })
}

async function getKeyExpired(env) {
  if (!env.CACHE) return false
  const val = await env.CACHE.get('sam_key_expired', 'json')
  return val?.expired === true
}

async function setRunLog(env, log, { completed = false } = {}) {
  if (!env.CACHE) return
  if (completed) {
    await putAutomationRun(env, 'sam_run_log', log)
    return
  }
  await env.CACHE.put('sam_run_log', JSON.stringify(log), {
    expirationTtl: 60 * 60 * 24 * 180,
  })
}

async function getRunLog(env) {
  if (!env.CACHE) return null
  return env.CACHE.get('sam_run_log', 'json')
}

async function handleFollowUps(req, env) {
  if (!env.SAM_API_KEY) return json({ error: 'SAM_API_KEY not configured' }, 503)

  const url = new URL(req.url)
  const source = {
    department: url.searchParams.get('department')?.trim() || '',
    agency:     url.searchParams.get('agency')?.trim() || '',
    office:     url.searchParams.get('office')?.trim() || '',
    naicsCode:  url.searchParams.get('naicsCode')?.trim() || '',
    pocEmail:   url.searchParams.get('pocEmail')?.trim() || '',
    title:      url.searchParams.get('title')?.trim() || '',
    noticeId:   url.searchParams.get('noticeId')?.trim() || '',
    solicitationNumber: url.searchParams.get('solicitationNumber')?.trim() || '',
    submissionDate: url.searchParams.get('submissionDate')?.trim() || '',
    rules: {
      departmentRule: url.searchParams.get('departmentRule')?.trim(),
      agencyRule: url.searchParams.get('agencyRule')?.trim(),
      pocRule: url.searchParams.get('pocRule')?.trim(),
      titleOverlapPercent: url.searchParams.get('titleOverlapPercent')?.trim(),
      noticeTypes: url.searchParams.get('noticeTypes')?.trim(),
      submissionWindowDays: url.searchParams.get('submissionWindowDays')?.trim(),
      noSubmissionLookbackDays: url.searchParams.get('noSubmissionLookbackDays')?.trim(),
      noSubmissionLookaheadDays: url.searchParams.get('noSubmissionLookaheadDays')?.trim(),
    },
  }
  source.rules = normalizedFollowUpRules(source.rules)
  const missing = Object.entries(source)
    .filter(([key, value]) => {
      if (['noticeId', 'solicitationNumber', 'submissionDate', 'rules', 'department', 'agency', 'office', 'naicsCode', 'pocEmail'].includes(key)) return false
      return !value
    })
    .map(([key]) => key)
  if (missing.length > 0) {
    return json({ error: `Missing follow-up criteria: ${missing.join(', ')}` }, 400)
  }

  // The criteria are also the cache identity: if an RFI's title, POC, or
  // organization changes, it naturally gets a fresh matching result.
  const cacheKey = `rfi_followups:${cacheFingerprint(JSON.stringify({
    ...source,
    titleMatcherVersion: FOLLOW_ON_TITLE_MATCHER_VERSION,
  }))}`
  const cached = env.CACHE ? await env.CACHE.get(cacheKey, 'json') : null
  if (cached) return json({ ...cached, cached: true })

  try {
    const matches = await findRFIFollowUps(env, source)
    const response = { matches, count: matches.length, rules: source.rules }
    if (env.CACHE) {
      await env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: FOLLOW_UP_CACHE_TTL_SECONDS })
    }
    return json(response)
  } catch (err) {
    console.error('[SAM] Follow-up lookup error:', err.message)
    return json({ error: err.message }, 502)
  }
}

// ── Core pull logic (shared by trigger) ──────────────────────────────────

function sameCursor(a, b) {
  return Number(a?.naicsIndex) === Number(b?.naicsIndex) && Number(a?.offset) === Number(b?.offset)
}

function pullRunContext(previousLog, resumeCursor, startedAt) {
  // A resumed checkpoint belongs to the preceding partial/running pull only
  // when it starts from the cursor the Worker previously published. This lets
  // the status show one truthful total across all bounded batches, while a
  // fresh manual pull always starts at zero.
  const continuing = Boolean(
    resumeCursor &&
    previousLog &&
    ['partial', 'running'].includes(previousLog.status) &&
    sameCursor(previousLog.nextCursor, resumeCursor)
  )

  return {
    runId: continuing ? previousLog.runId || crypto.randomUUID() : crypto.randomUUID(),
    startedAt: continuing ? previousLog.startedAt || previousLog.timestamp || startedAt : startedAt,
    totalFetched: continuing ? Number(previousLog.totalFetched ?? previousLog.fetched) || 0 : 0,
    totalWritten: continuing ? Number(previousLog.totalWritten ?? previousLog.written) || 0 : 0,
    totalDeduped: continuing ? Number(previousLog.totalDeduped ?? previousLog.deduped) || 0 : 0,
    totalDeleted: continuing ? Number(previousLog.totalDeleted ?? previousLog.deleted) || 0 : 0,
  }
}

async function runSAMPull(
  env,
  token,
  config,
  resumeCursor = null,
  legacyResumeFrom = 0,
  previousLogOverride = null,
) {
  const runStart = new Date().toISOString()
  console.log('[SAM] Pull started:', runStart)
  const previousLog = resumeCursor
    ? previousLogOverride || await getRunLog(env)
    : null
  const run = pullRunContext(previousLog, resumeCursor, runStart)

  const { naicsCodes = [], skipDays = 3, windowDays = 90 } = config
  const startIndex = Math.max(
    0,
    Math.min(Number(resumeCursor?.naicsIndex ?? legacyResumeFrom) || 0, naicsCodes.length)
  )
  const startOffset = startIndex < naicsCodes.length
    ? Math.max(0, Number(resumeCursor?.offset) || 0)
    : 0

  if (!naicsCodes.length) {
    const err = 'No NAICS codes provided'
    await setRunLog(env, { success: false, status: 'error', timestamp: runStart, runId: run.runId, startedAt: run.startedAt, error: err }, { completed: true })
    throw new Error(err)
  }

  // Mark the run as in-progress immediately so /sam/run-status reflects a
  // live pull rather than stale data from the previous run (or nothing) —
  // this is the "monitor progress" ask. Intentionally limited to a handful
  // of KV writes total for the whole run (not one per NAICS code), since
  // each KV put() also counts against the subrequest budget.
  if (!resumeCursor) {
    await setRunLog(env, {
      status: 'running', phase: 'fetching', timestamp: runStart, runId: run.runId, startedAt: run.startedAt,
      naicsTotal: naicsCodes.length, naicsProcessed: startIndex, nextNaicsIndex: startIndex,
      nextCursor: { naicsIndex: startIndex, offset: startOffset },
      fetched: run.totalFetched, written: run.totalWritten, deduped: run.totalDeduped, deleted: run.totalDeleted,
      totalFetched: run.totalFetched, totalWritten: run.totalWritten, totalDeduped: run.totalDeduped, totalDeleted: run.totalDeleted,
    })
  }

  // Build date ranges
  const now        = new Date()
  const postedFrom = formatDateParam(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, now.getUTCDate())))
  const postedTo   = formatDateParam(now)
  const rdlStart   = new Date(now)
  rdlStart.setUTCDate(rdlStart.getUTCDate() + skipDays)
  const rdlEnd     = new Date(rdlStart)
  rdlEnd.setUTCDate(rdlEnd.getUTCDate() + windowDays)
  const rdlFrom    = formatDateParam(rdlStart)
  const rdlTo      = formatDateParam(rdlEnd)

  console.log(`[SAM] ${naicsCodes.length} NAICS | Posted: ${postedFrom}→${postedTo} | Deadline: ${rdlFrom}→${rdlTo}`)

  // Get existing rows ONCE — reused for Notice-ID dedup, Solicitation-Number
  // dedup, AND expired-row cleanup, saving subrequests.
  let existingRows
  let existingHeaders
  try {
    const table = await getTableData(env, token, 'NewOpportunitiesTable')
    existingRows = table.rows
    existingHeaders = table.headers
  } catch (err) {
    const msg = `Failed to read NewOpportunitiesTable: ${err.message}`
    await setRunLog(env, {
      success: false, status: 'error', timestamp: runStart, runId: run.runId, startedAt: run.startedAt,
      fetched: run.totalFetched, written: run.totalWritten, deduped: run.totalDeduped, deleted: run.totalDeleted,
      totalFetched: run.totalFetched, totalWritten: run.totalWritten, totalDeduped: run.totalDeduped, totalDeleted: run.totalDeleted,
      error: msg,
    }, { completed: true })
    throw new Error(msg)
  }

  const existingIds = new Set(
    existingRows.map((r) => normalizeNoticeId(r['Notice ID'])).filter(Boolean)
  )
  const existingByNotice = new Map()
  existingRows.forEach((row) => {
    const key = normalizeNoticeId(row['Notice ID'])
    if (key && !existingByNotice.has(key)) existingByNotice.set(key, row)
  })
  const dismissedNoticeIds = new Set()
  const dismissedSolicitationFamilies = new Set()
  existingRows.forEach((row) => {
    if (String(row.Status || '').trim().toLowerCase() !== 'dismissed') return
    const noticeId = normalizeNoticeId(row['Notice ID'])
    const family = solicitationFamily(row['Solicitation Number'])
    if (noticeId) dismissedNoticeIds.add(noticeId)
    if (family) dismissedSolicitationFamilies.add(family)
  })

  // Solicitation Number -> the most-recent variant we currently know about
  // (either already in the sheet, or a candidate fetched earlier this run).
  // `fromExisting: true` means rowIndex points at a real sheet row that
  // should be deleted if a newer candidate supersedes it; `false` means it
  // points at an in-memory candidate not yet written, which can simply be
  // dropped from the write list instead of needing a delete.
  const solNumIndex = new Map()
  const duplicateExistingRowIndices = new Set()
  const existingNoticeRows = new Map()
  existingRows.forEach((r) => {
    if (String(r.Status || '').trim().toLowerCase() === 'dismissed') return
    const noticeKey = normalizeNoticeId(r['Notice ID'])
    if (noticeKey) {
      const existingNotice = existingNoticeRows.get(noticeKey)
      if (existingNotice !== undefined) {
        duplicateExistingRowIndices.add(r._rowIndex)
        return
      }
      existingNoticeRows.set(noticeKey, r._rowIndex)
    }
    // Legacy discovery rows were all treated as RFI, including some RFP/RFQ
    // rows written before compact SAM type codes were supported. Do not use a
    // stored RFI label to delete another existing row by solicitation number
    // until SAM has revalidated and repaired that row's type. Exact Notice ID
    // duplicate cleanup above remains safe.
    if (isRfiWorkflowNoticeType(normalizedNoticeType(r['Notice Type']))) return
    const solKey = solicitationDedupKey(r['Solicitation Number'], r['Notice Type'])
    if (!solKey) return
    const postedDate = String(r['Posted Date'] || '')
    const current = solNumIndex.get(solKey)
    if (!current || newerRecord(postedDate, current.postedDate)) {
      if (current?.fromExisting) duplicateExistingRowIndices.add(current.rowIndex)
      solNumIndex.set(solKey, { noticeId: r['Notice ID'], rowIndex: r._rowIndex, postedDate, fromExisting: true })
    } else {
      duplicateExistingRowIndices.add(r._rowIndex)
    }
  })

  // ── Phase 1: fetch + buffer candidates (not written yet) ───────────────
  // Buffering before writing lets us resolve Solicitation-Number dedup
  // correctly across the whole batch instead of writing blindly as we go.
  // Every invocation fetches exactly one small page for one NAICS code. Its
  // cursor is persisted before the next page or NAICS code is started.
  //
  // Wrapped so a hard failure here (expired key, systemic SAM.gov outage)
  // is *recorded* rather than thrown immediately — cleanup below only
  // depends on existingRows (already read via the Graph API, independent of
  // SAM.gov), so it must still run even when the SAM.gov side fails.
  // Previously a fetch failure threw straight out of this function and
  // skipped cleanup entirely, which meant expired SAM opportunity rows
  // stopped getting deleted for as long as SAM.gov was having problems.
  let totalFetched  = 0
  let naicsProcessed = startIndex
  let nextNaicsIndex = startIndex
  let hasMoreWork = false
  const hasNoticeTypeColumn = existingHeaders.includes('Notice Type')
  const naicsErrors = hasNoticeTypeColumn
    ? []
    : ['NewOpportunitiesTable is missing the Notice Type column. MRAS, RFP, and RFQ results were skipped until that column is added.']
  const candidates  = []   // { mapped, noticeId, noticeKey, solKey }
  const typeRepairs = []
  let fatalError = null

  let nextCursor = { naicsIndex: startIndex, offset: startOffset }
  if (startIndex < naicsCodes.length) {
    const naics = naicsCodes[startIndex]
    let page
    try {
      page = await fetchSAMForNAICS(env, naics, postedFrom, postedTo, rdlFrom, rdlTo, startOffset)
      console.log(`[SAM] NAICS ${naics}, offset ${startOffset}: ${page.records.length} record(s)`)
      totalFetched += page.records.length
    } catch (err) {
      if (err.code === 'KEY_EXPIRED') {
        fatalError = 'SAM API key expired or invalid'
      } else {
        naicsErrors.push(`NAICS ${naics}: ${err.message}`)
        console.error('[SAM] Fetch error:', err.message)
        if (/SAM API error 5\d\d/.test(err.message)) {
          fatalError = `SAM.gov API appears to be unavailable (${err.message}). Try the pull again shortly.`
        } else {
          // A malformed or isolated NAICS request should not block all later
          // codes. Move to the next code and surface the warning at the end.
          nextNaicsIndex = startIndex + 1
          naicsProcessed = nextNaicsIndex
          nextCursor = { naicsIndex: nextNaicsIndex, offset: 0 }
          hasMoreWork = nextNaicsIndex < naicsCodes.length
        }
      }
    }

    if (!fatalError && page) {
      for (const raw of page.records) {
        const noticeId = String(raw.noticeId || '').trim()
        const noticeKey = normalizeNoticeId(noticeId)
        if (!noticeId) continue
        if (String(raw.active || '').toLowerCase() !== 'yes') continue
        const mapped = mapRecord(raw, naics)
        const incomingFamily = solicitationFamily(mapped['Solicitation Number'])
        if (dismissedNoticeIds.has(noticeKey) || (incomingFamily && dismissedSolicitationFamilies.has(incomingFamily))) {
          continue
        }
        const existing = existingByNotice.get(noticeKey)
        if (existing) {
          // Rows written before compact SAM ptype codes were supported may
          // have been labelled RFI. Repair only the type and preserve every
          // user-controlled field, including Status.
          const needsTypeRepair = hasNoticeTypeColumn && normalizedNoticeType(existing['Notice Type']) !== mapped['Notice Type']
          if (needsTypeRepair) {
            typeRepairs.push({
              rowIndex: existing._rowIndex,
              row: {
                ...existing,
                ...(needsTypeRepair ? { 'Notice Type': mapped['Notice Type'] } : {}),
              },
            })
          }
          continue
        }
        if (existingIds.has(noticeKey)) continue
        if (!hasNoticeTypeColumn && mapped['Notice Type'] !== 'RFI') continue
        const solKey = solicitationDedupKey(mapped['Solicitation Number'], mapped['Notice Type'])
        // Deduplicate before buffering. A page is at most ten records,
        // matching the write cap for this checkpointed pull unit.
        const knownSol = solKey ? solNumIndex.get(solKey) : null
        if (knownSol && !newerRecord(mapped['Posted Date'], knownSol.postedDate)) continue

        candidates.push({ mapped, noticeId, noticeKey, solKey })
      }

      if (page.hasMore) {
        hasMoreWork = true
        nextNaicsIndex = startIndex
        naicsProcessed = startIndex
        nextCursor = { naicsIndex: startIndex, offset: page.nextOffset }
      } else {
        nextNaicsIndex = startIndex + 1
        naicsProcessed = nextNaicsIndex
        hasMoreWork = nextNaicsIndex < naicsCodes.length
        nextCursor = { naicsIndex: nextNaicsIndex, offset: 0 }
      }
    }
  }

  // ── Resolve dedup ────────────────────────────────────────────────────────
  // Pass 1: collapse same Notice ID appearing more than once in this batch
  // (happens when a solicitation matches more than one tracked NAICS code).
  const byNoticeId = new Map()
  for (const c of candidates) {
    if (!byNoticeId.has(c.noticeKey)) byNoticeId.set(c.noticeKey, c)
  }

  // Pass 2: Solicitation-Number dedup against both existing sheet rows and
  // other candidates from this same batch — keep only the most recently
  // posted variant per solicitation.
  const dedupDeleteRowIndices = new Set(duplicateExistingRowIndices)
  const toWrite = []

  for (const c of byNoticeId.values()) {
    if (!c.solKey) { toWrite.push(c); continue }

    const current = solNumIndex.get(c.solKey)
    if (!current) {
      solNumIndex.set(c.solKey, { noticeId: c.noticeId, rowIndex: null, postedDate: c.mapped['Posted Date'], fromExisting: false })
      toWrite.push(c)
      continue
    }

    if (newerRecord(c.mapped['Posted Date'], current.postedDate)) {
      if (current.fromExisting) {
        dedupDeleteRowIndices.add(current.rowIndex)
      } else {
        const staleIdx = toWrite.findIndex((w) => w.noticeId === current.noticeId)
        if (staleIdx !== -1) toWrite.splice(staleIdx, 1)
      }
      solNumIndex.set(c.solKey, { noticeId: c.noticeId, rowIndex: null, postedDate: c.mapped['Posted Date'], fromExisting: false })
      toWrite.push(c)
    }
    // else: an existing row or an already-queued candidate is the same age
    // or newer — this candidate is a stale duplicate, drop it entirely.
  }

  // ── Phase 2: write survivors, capped to stay within subrequest budget ──
  // Skipped entirely if phase 1 hit a fatal error (nothing valid to write).
  let totalWritten = 0
  let totalRepaired = 0
  const writtenRows = []
  if (!fatalError && (toWrite.length > 0 || typeRepairs.length > 0)) {
    for (const repair of typeRepairs) {
      try {
        await updateOpportunityRow(env, token, repair.rowIndex, repair.row, existingHeaders)
        totalRepaired++
      } catch (err) {
        console.error(`[SAM] Notice type repair failed for row ${repair.rowIndex}:`, err.message)
      }
    }
    for (const c of toWrite) {
      try {
        await appendOpportunity(env, token, c.mapped, existingHeaders)
        totalWritten++
        writtenRows.push(c.mapped)
      } catch (err) {
        console.error(`[SAM] Write failed for ${c.noticeId}:`, err.message)
      }
    }

    // Archive preservation is detached from the workbook write. One batch
    // call starts small, durable file workflows without spending this pull's
    // remaining Graph/SAM subrequest budget or rolling back a saved record.
    if (writtenRows.length) {
      try {
        const archiveQueue = await queueNewSAMArchives(env, writtenRows)
        if (archiveQueue.unavailable) {
          naicsErrors.push('SAM.gov attachment archiving is not configured; opportunity records were still saved.')
        }
      } catch (error) {
        console.warn(JSON.stringify({ event: 'sam_archive_queue_failed', count: writtenRows.length, message: error.message }))
        naicsErrors.push(`SAM.gov attachment archiving will need a retry: ${error.message}`)
      }
    }
  }
  // Any completed fetch phase proves the key is valid, even when it produced
  // no new rows to write.
  if (!fatalError) await setKeyExpired(env, false)

  // ── Cleanup: expired rows + solicitation-superseded rows, one shared cap ──
  // Runs unconditionally (as long as existingRows was read successfully,
  // guaranteed by this point) — independent of whether the SAM.gov fetch/
  // write phases above succeeded, so expired rows keep getting swept even
  // during a SAM.gov outage.
  let deleted = 0
  try {
    deleted = await cleanupRows(env, token, existingRows, dedupDeleteRowIndices)
  } catch (err) {
    console.error('[SAM] Cleanup error:', err.message)
  }

  if (fatalError) {
    const log = {
      success: false, status: 'error', timestamp: new Date().toISOString(), runId: run.runId, startedAt: run.startedAt,
      error: fatalError, warnings: naicsErrors.length > 0 ? naicsErrors : undefined,
      batchFetched: totalFetched, batchWritten: totalWritten, batchDeduped: dedupDeleteRowIndices.size, batchDeleted: deleted,
      batchRepaired: totalRepaired,
      fetched: run.totalFetched + totalFetched, written: run.totalWritten + totalWritten,
      deduped: run.totalDeduped + dedupDeleteRowIndices.size, deleted: run.totalDeleted + deleted,
      totalFetched: run.totalFetched + totalFetched, totalWritten: run.totalWritten + totalWritten,
      totalDeduped: run.totalDeduped + dedupDeleteRowIndices.size, totalDeleted: run.totalDeleted + deleted,
    }
    await setRunLog(env, log, { completed: true })
    throw new Error(fatalError)
  }

  const complete = !hasMoreWork && nextNaicsIndex >= naicsCodes.length
  const completedAt = new Date().toISOString()
  const log = {
    success:   complete,
    status:    complete ? 'success' : 'partial',
    timestamp: completedAt,
    runId: run.runId,
    startedAt: run.startedAt,
    completedAt: complete ? completedAt : undefined,
    nextNaicsIndex,
    nextCursor,
    naicsTotal: naicsCodes.length,
    naicsProcessed,
    batchFetched: totalFetched,
    batchWritten: totalWritten,
    batchRepaired: totalRepaired,
    batchDeduped: dedupDeleteRowIndices.size,
    batchDeleted: deleted,
    fetched:   run.totalFetched + totalFetched,
    written:   run.totalWritten + totalWritten,
    deduped:   run.totalDeduped + dedupDeleteRowIndices.size,
    deleted:   run.totalDeleted + deleted,
    totalFetched: run.totalFetched + totalFetched,
    totalWritten: run.totalWritten + totalWritten,
    totalDeduped: run.totalDeduped + dedupDeleteRowIndices.size,
    totalDeleted: run.totalDeleted + deleted,
    warnings:  naicsErrors.length > 0 ? naicsErrors : undefined,
  }
  await setRunLog(env, log, { completed: true })
  console.log(`[SAM] Done. Run ${run.runId} | Batch written: ${totalWritten} | Total written: ${log.totalWritten} | Complete: ${complete}`)
  return log
}

function scheduledSAMConfig(naicsRows, settingsRows) {
  const settings = Object.fromEntries(settingsRows.map((row) => [String(row.Setting || '').trim(), row.Value]))
  const num = (value, fallback, min, max) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
  }
  return {
    naicsCodes: naicsRows
      .map((row) => String(row['NAICS Code'] || row.NAICS || row.Code || '').trim())
      .filter(Boolean),
    skipDays: num(settings['Skip Days'], 3, 0, 30),
    windowDays: num(settings['Window Days'], 90, 7, 365),
  }
}

// Execute one autonomous checkpoint with Microsoft Graph application
// permissions. SAMPullWorkflow repeatedly calls this function until it
// returns a terminal status. Keeping each checkpoint separate preserves the
// free-plan subrequest headroom while removing the wait for another cron run.
export async function runScheduledSAMPull(env, continuation = null) {
  const startedAt = new Date().toISOString()
  if (!env.SAM_API_KEY || !env.WORKBOOK_ID) {
    const message = !env.SAM_API_KEY ? 'SAM_API_KEY is not configured' : 'WORKBOOK_ID is not configured'
    console.error(JSON.stringify({ event: 'scheduled_sam_pull', status: 'skipped', message, startedAt }))
    return { ok: false, skipped: true, message }
  }

  try {
    const token = await getAppOnlyGraphToken(env)
    const [naicsRows, settingsRows, storedRun] = await Promise.all([
      getTableRows(env, token, 'SAMNAICSTable'),
      getTableRows(env, token, 'SAMSettingsTable'),
      continuation ? Promise.resolve(null) : getRunLog(env),
    ])
    const config = scheduledSAMConfig(naicsRows, settingsRows)
    if (!config.naicsCodes.length) throw new Error('SAMNAICSTable does not contain any NAICS codes')

    const previousRun = continuation || storedRun
    const resumeCursor = previousRun?.status === 'partial' ? previousRun.nextCursor || null : null
    const result = await runSAMPull(env, token, config, resumeCursor, 0, previousRun)
    console.log(JSON.stringify({
      event: 'scheduled_sam_pull', status: result.status, source: 'app-only',
      runId: result.runId, batchWritten: result.batchWritten, totalWritten: result.totalWritten,
      startedAt, completedAt: new Date().toISOString(),
    }))
    return { ok: true, source: 'app-only', result }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown scheduled SAM pull error'
    console.error(JSON.stringify({ event: 'scheduled_sam_pull', status: 'error', source: 'app-only', message, startedAt }))
    return { ok: false, source: 'app-only', error: message }
  }
}

export async function startScheduledSAMPull(env, scheduledTime = Date.now()) {
  // An autonomous pull must run as a Workflow chain. Running one checkpoint
  // as a fallback leaves a partial pull waiting for the next cron and makes
  // the schedule appear healthy when the binding is actually missing.
  if (!env.SAM_PULL_WORKFLOW?.createBatch) {
    const message = 'SAM_PULL_WORKFLOW binding is unavailable; autonomous opportunity pull was not started'
    console.error(JSON.stringify({
      event: 'scheduled_sam_pull_workflow',
      status: 'error',
      message,
    }))
    await setRunLog(env, {
      success: false,
      status: 'error',
      timestamp: new Date().toISOString(),
      error: message,
    }, { completed: true })
    return { ok: false, source: 'workflow', error: message }
  }

  const timestamp = new Date(Number(scheduledTime) || Date.now())
  const slot = timestamp.toISOString().slice(0, 13).replace('T', '-')
  const instanceId = `sam-pull-${slot}`
  const instances = await env.SAM_PULL_WORKFLOW.createBatch([{
    id: instanceId,
    params: { scheduledTime: timestamp.toISOString() },
    retention: { successRetention: '1 day', errorRetention: '3 days' },
  }])
  const instance = instances[0] || null

  console.log(JSON.stringify({
    event: 'scheduled_sam_pull_workflow',
    status: instance ? 'started' : 'already_started',
    instanceId: instance?.id || instanceId,
    scheduledTime: timestamp.toISOString(),
  }))

  return {
    ok: true,
    source: 'workflow',
    started: Boolean(instance),
    instanceId: instance?.id || instanceId,
  }
}

// ── HTTP handler ──────────────────────────────────────────────────────────

export async function handleSAM(req, env, ctx) {
  const url = new URL(req.url)

  // GET /sam/opportunity — live SAM.gov record enriched with archive state.
  if (url.pathname === '/sam/opportunity' && req.method === 'GET') {
    // v2 excludes links scraped from free-form descriptions. Keeping the
    // cache versioned prevents an old generated link from returning when a
    // live SAM.gov lookup temporarily fails after this integrity fix.
    const cacheKey = `sam:opportunity-detail:v2:${normalizeNoticeId(url.searchParams.get('noticeId') || url.searchParams.get('solicitationNumber') || '')}`
    const cached = cacheKey && await env.CACHE?.get(cacheKey, 'json')
    try {
      const record = await fetchSAMOpportunityRecord(env, {
        noticeId: url.searchParams.get('noticeId') || '',
        solicitationNumber: url.searchParams.get('solicitationNumber') || '',
        postedDate: url.searchParams.get('postedDate') || '',
      })
      const detail = normalizeSAMOpportunityDetail(await resolveSAMOpportunityDescription(env, record))
      const archive = env.EBUY_DB && await samArchiveStorageReady(env.EBUY_DB)
        ? await findSAMArchive(env.EBUY_DB, detail)
        : null
      const opportunity = mergeSAMArchive(detail, archive)
      if (JSON.stringify(cached) !== JSON.stringify(opportunity)) {
        await env.CACHE?.put(cacheKey, JSON.stringify(opportunity), { expirationTtl: 90 * 24 * 60 * 60 })
      }
      return json({ opportunity })
    } catch (error) {
      if (cached) return json({ opportunity: cached, warning: error.message, stale: true })
      return json({ error: error.message, code: error.code || 'sam_opportunity_failed' }, error.status || 500)
    }
  }

  // POST /sam/archive — start or retry bounded SharePoint preservation.
  if (url.pathname === '/sam/archive' && req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({}))
      const record = await fetchSAMOpportunityRecord(env, body)
      const detail = normalizeSAMOpportunityDetail(record)
      return json({ ok: true, ...(await startSAMArchive(env, detail, { force: body.force === true })) }, 202)
    } catch (error) {
      return json({ error: error.message, code: error.code || 'sam_archive_failed' }, error.status || 500)
    }
  }

  if (url.pathname === '/sam/archive/status' && req.method === 'GET') {
    if (!env.EBUY_DB || !(await samArchiveStorageReady(env.EBUY_DB))) return json({ archive: null })
    return json({ archive: await getSAMArchive(env.EBUY_DB, url.searchParams.get('key') || '') })
  }

  if (url.pathname === '/sam/archive/analysis' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
    try {
      const run = await runSAMArchiveDocumentAnalysis(env, body)
      const key = run.opportunityKey || body.solicitationNumber || body.noticeId
      return json({ ok: true, run, analysis: await getDocumentAnalysis(env, key) })
    } catch (error) {
      return json({ error: error.message, code: error.code || 'sam_document_analysis_failed' }, error.status || 500)
    }
  }

  if (url.pathname === '/sam/archive/analysis' && req.method === 'GET') {
    try {
      const requestedKey = url.searchParams.get('key') || ''
      const archive = await findSAMArchive(env.EBUY_DB, { opportunityKey: requestedKey })
      return json({ analysis: await getDocumentAnalysis(env, archive?.opportunityKey || requestedKey) })
    } catch (error) {
      return json({ error: error.message, code: error.code || 'sam_document_analysis_failed' }, error.status || 500)
    }
  }

  if (url.pathname === '/sam/archive/analysis/review' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    try {
      const archive = await findSAMArchive(env.EBUY_DB, body)
      return json({ ok: true, analysis: await reviewDocumentFinding(env, archive?.opportunityKey || body.opportunityKey, body) })
    } catch (error) {
      return json({ error: error.message, code: error.code || 'sam_document_review_failed' }, error.status || 500)
    }
  }

  if (url.pathname === '/sam/archive/review' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    if (!env.EBUY_DB || !(await samArchiveStorageReady(env.EBUY_DB))) return json({ archive: null })
    let archive = await findSAMArchive(env.EBUY_DB, body)
    // Dismiss can win the race against the automatically queued archive.
    // Persist the review state as a lightweight placeholder so the archive
    // Workflow cannot later recreate the opportunity as an undismissed item.
    if (!archive) {
      archive = await ensureSAMArchive(env.EBUY_DB, {
        opportunityKey: body.solicitationNumber || body.noticeId,
        noticeId: body.noticeId,
        solicitationNumber: body.solicitationNumber,
      })
    }
    const updated = await markSAMArchiveReviewState(env.EBUY_DB, archive.opportunityKey, body.reviewState)
    if (String(body.reviewState || '').toLowerCase() === 'dismissed') {
      await cancelDocumentAnalysis(env.EBUY_DB, archive.opportunityKey)
    }
    return json({ archive: updated })
  }

  // GET /sam/key-status
  if (url.pathname === '/sam/key-status' && req.method === 'GET') {
    const expired = await getKeyExpired(env)
    return json({ expired })
  }

  // GET /sam/run-status
  if (url.pathname === '/sam/run-status' && req.method === 'GET') {
    const log = await getRunLog(env)
    return json(log || { success: null, status: null, timestamp: null })
  }

  // GET /sam/follow-ups — find RFP or RFQ notices following an RFI/MRAS/RFQ
  if (url.pathname === '/sam/follow-ups' && req.method === 'GET') {
    return handleFollowUps(req, env)
  }

  // GET /sam/debug is protected by the Worker-wide Entra validation.
  if (url.pathname === '/sam/debug' && req.method === 'GET') {
    const result = { steps: {} }

    // Test token + workbook using a token from the request if provided
    const authHeader = req.headers.get('Authorization') || ''
    const testToken  = authHeader.replace('Bearer ', '').trim()

    if (!testToken) {
      result.steps.token = { ok: false, error: 'No Authorization header provided for debug' }
      return json(result)
    }

    result.steps.token = { ok: true, note: 'Using provided delegated token' }

    try {
      const wb = await graphFetch(env, testToken, '')
      result.steps.workbook = { ok: true, name: wb?.name || '(no name)' }
    } catch (err) {
      result.steps.workbook = { ok: false, error: err.message }
      return json(result)
    }

    try {
      const tables = await graphFetch(env, testToken, '/tables')
      result.steps.tables = { ok: true, names: (tables?.value || []).map((t) => t.name) }
    } catch (err) {
      result.steps.tables = { ok: false, error: err.message }
      return json(result)
    }

    for (const tbl of ['SAMNAICSTable', 'SAMSettingsTable', 'NewOpportunitiesTable']) {
      try {
        const rows = await getTableRows(env, testToken, tbl)
        result.steps[tbl] = { ok: true, rowCount: rows.length, sample: rows[0] || null }
      } catch (err) {
        result.steps[tbl] = { ok: false, error: err.message }
      }
    }

    return json(result)
  }

  // POST /sam/trigger uses the same verified delegated token as all browser
  // routes. Do not accept a second token in the request body.
  if (url.pathname === '/sam/trigger' && req.method === 'POST') {
    if (!env.SAM_API_KEY)  return json({ error: 'SAM_API_KEY not configured' }, 503)
    if (!env.WORKBOOK_ID)  return json({ error: 'WORKBOOK_ID not configured' }, 503)

    let body
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }

    const { config, force = false, resumeCursor = null, resumeFrom = 0 } = body
    const token = String(req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')

    if (!token) return json({ error: 'Missing Authorization token' }, 401)
    if (!config?.naicsCodes?.length) return json({ error: 'Missing or empty config.naicsCodes' }, 400)

    const lastLog = await getRunLog(env)
    // Freshness can be bypassed, but a manual pull must not overlap a live
    // autonomous or browser pull. Concurrent pulls can both read the same
    // workbook state before either appends, creating duplicate rows.
    if (!resumeCursor && !resumeFrom && ['running', 'partial'].includes(lastLog?.status)) {
      const activityAt = Date.parse(lastLog.timestamp || lastLog.startedAt || '')
      const stillActive = Number.isFinite(activityAt) && Date.now() - activityAt < 15 * 60 * 1000
      if (stillActive) {
        return json({
          error: 'An opportunity pull is already running. Follow its existing progress instead of starting another pull.',
          code: 'pull_in_progress',
          run: lastLog,
        }, 409)
      }
    }

    // 12h throttle check (skipped when force=true, e.g. Settings page force pull)
    if (!force && !resumeCursor && !resumeFrom) {
      if (lastLog?.success && lastLog?.timestamp) {
        const lastRun  = new Date(lastLog.timestamp)
        const hoursSince = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60)
        if (hoursSince < 12) {
          return json({
            throttled: true,
            message:   `Opportunities were last pulled ${Math.floor(hoursSince)}h ${Math.floor((hoursSince % 1) * 60)}m ago. No pull needed — data is fresh.`,
            lastRun:   lastLog.timestamp,
            written:   lastLog.written,
          })
        }
      }
    }

    // Complete one small, checkpointed chunk while the browser request is
    // still open. This is deliberately not waitUntil(): delegated Graph
    // access is only reliable while the user keeps the app open, whereas a
    // waitUntil task can be terminated shortly after this response returns.
    const result = await runSAMPull(env, token, config, resumeCursor, resumeFrom)
    return json({
      ok: true,
      message: result.status === 'partial'
        ? 'SAM pull chunk completed. Continuing automatically.'
        : 'SAM pull completed.',
      force,
      resumeCursor,
      result,
    })
  }

  return json({ error: 'Not found' }, 404)
}
