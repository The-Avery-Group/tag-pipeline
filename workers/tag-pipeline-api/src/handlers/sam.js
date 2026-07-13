/**
 * sam.js — SAM.gov Get Opportunities integration
 *
 * Triggered on demand via POST /sam/trigger from the frontend.
 * The frontend supplies its own MSAL token (used for Graph API writes)
 * and the SAM config (NAICS codes, window settings) read from SAMConfig tables.
 * No app-only credentials needed — workbook access uses the user's delegated token.
 *
 * POST /sam/trigger body:
 *   {
 *     token:  string,           // MSAL access token from frontend
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
 * GET  /sam/debug        — step-by-step diagnostic (requires X-Trigger-Secret)
 *
 * Secrets required:
 *   SAM_API_KEY         — SAM.gov public API key (expires every 90 days)
 *                         Rotate: wrangler secret put SAM_API_KEY
 *   SAM_TRIGGER_SECRET  — Any string; sent as X-Trigger-Secret header
 *                         Set: wrangler secret put SAM_TRIGGER_SECRET
 *   WORKBOOK_ID         — SharePoint workbook item ID (same as VITE_ONEDRIVE_FILE_ID)
 */

const SAM_BASE  = 'https://api.sam.gov/opportunities/v2/search'
const PAGE_SIZE = 500
// Was referenced (`sleep(PAGE_DELAY)`) but never defined anywhere in this file —
// pre-existing bug, unrelated to this changeset. Fixed opportunistically since
// it's directly adjacent to code being touched here; a missing constant means
// `sleep(undefined)` → NaN delay → effectively no pause between paginated
// SAM.gov requests, which risks tripping their rate limiter on large result sets.
const PAGE_DELAY = 250   // ms between paginated SAM.gov requests
const FOLLOW_UP_LOOKBACK_DAYS = 548 // 18 months — enough to cover long RFI-to-RFP cycles
const FOLLOW_UP_CACHE_TTL_SECONDS = 12 * 60 * 60
const FOLLOW_UP_MAX_PAGES = 4

// Shared subrequest budget — Cloudflare Workers cap outbound fetch() calls
// per request (50 on the free plan, higher on paid). Every SAM.gov fetch,
// every Graph API read/write/delete, and every KV put/get all count against
// this. Kept as module-level constants so the write cap and the delete cap
// can be reasoned about together.
const MAX_WRITES_PER_RUN  = 15
const MAX_DELETES_PER_RUN = 10

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

function parsePOC(pocList) {
  if (!Array.isArray(pocList) || pocList.length === 0) return ''
  const primary = pocList.find((p) => String(p?.type || '').toLowerCase() === 'primary') || pocList[0]
  if (!primary) return ''
  const name  = String(primary.fullName || primary.fullname || '').trim()
  const email = String(primary.email  || '').trim()
  const phone = String(primary.phone  || '').trim()
  return [name, email, phone].filter(Boolean).join(' | ')
}

function parseOrg(fullParentPathName) {
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
  const res = await fetch(`${workbookBase(env)}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  if (res.status === 204) return null
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message || `Graph error: ${res.status}`)
  return data
}

async function getTableRows(env, token, tableName) {
  const [rowsData, colsData] = await Promise.all([
    graphFetch(env, token, `/tables/${tableName}/rows`),
    graphFetch(env, token, `/tables/${tableName}/columns`),
  ])
  const headers = (colsData?.value || []).map((c) => c.name)
  return (rowsData?.value || []).map((row) => {
    const obj = {}
    headers.forEach((h, i) => { obj[h] = row.values[0][i] })
    obj._rowIndex = row.index
    return obj
  })
}

// ── Delete expired + solicitation-superseded rows, one shared cap ──────────
// (sequential, capped to preserve subrequest budget; descending index order
// so earlier deletes don't shift the row indices of later ones)

async function cleanupRows(env, token, existingRows, dedupDeleteRowIndices = new Set()) {
  const today = todayISO()
  const expiredIndices = existingRows
    .filter((r) => {
      const rd = String(r['Response Date'] || '').trim().slice(0, 10)
      return rd && rd < today
    })
    .map((r) => r._rowIndex)

  // Combine both cleanup reasons under one cap so we never risk exceeding
  // the subrequest budget even when a run has both expired rows AND
  // solicitation-superseded duplicates to remove. De-duped via Set in case
  // a row happens to be both (rare, but possible).
  const allIndices = [...new Set([...expiredIndices, ...dedupDeleteRowIndices])]
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
]

async function appendOpportunity(env, token, data) {
  const row = NEW_OPP_HEADERS.map((h) => data[h] ?? '')
  await graphFetch(env, token, '/tables/NewOpportunitiesTable/rows/add', {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  })
}

// ── SAM API fetcher ───────────────────────────────────────────────────────

async function fetchSAMForNAICS(env, naicsCode, postedFrom, postedTo, rdlFrom, rdlTo) {
  const records = []
  let offset = 0
  let total  = null

  while (true) {
    const params = new URLSearchParams({
      api_key:    env.SAM_API_KEY,
      ptype:      'r',
      ncode:      naicsCode,
      postedFrom,
      postedTo,
      rdlfrom:    rdlFrom,
      rdlto:      rdlTo,
      limit:      String(PAGE_SIZE),
      offset:     String(offset),
    })

    const res = await fetchWithRetry(`${SAM_BASE}?${params}`)

    if (res.status === 401) {
      await setKeyExpired(env, true)
      throw Object.assign(new Error('SAM API key expired or invalid'), { code: 'KEY_EXPIRED' })
    }
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`SAM API error ${res.status}: ${body.slice(0, 200)}`)
    }

    const data = await res.json()
    const page = data.opportunitiesData || []
    if (total === null) total = data.totalRecords || 0
    records.push(...page)
    if (page.length === 0 || records.length >= total) break
    offset += PAGE_SIZE
    await sleep(PAGE_DELAY)
  }

  return records
}

// ── Map a SAM record to our column structure ──────────────────────────────

function mapRecord(raw, naicsCode) {
  const org = parseOrg(raw.fullParentPathName)
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
  }
}

// ── RFI follow-up matcher ────────────────────────────────────────────────
// Finds follow-on RFP/RFQ notices for an RFI/Sources-Sought opportunity.
// The SAM API cannot express every one of our matching rules as a query
// parameter, so we retrieve recent RFP/RFQ notices and apply the four hard
// requirements below before returning any candidate to the browser.

const TITLE_STOP_WORDS = new Set([
  'and', 'for', 'the', 'with', 'from', 'this', 'that', 'will', 'services',
  'service', 'support', 'contract', 'program', 'project', 'requirement',
])

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

function titleKeywords(title) {
  return new Set(
    normalized(title)
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !TITLE_STOP_WORDS.has(word))
  )
}

function titleOverlapPercent(sourceTitle, candidateTitle) {
  const source = titleKeywords(sourceTitle)
  const candidate = titleKeywords(candidateTitle)
  if (source.size === 0 || candidate.size === 0) return 0
  let common = 0
  source.forEach((word) => { if (candidate.has(word)) common++ })
  return Math.round((common / source.size) * 100)
}

function matchingPOC(raw, email) {
  const target = normalized(email)
  if (!target || !Array.isArray(raw?.pointOfContact)) return null
  return raw.pointOfContact.find((poc) => normalized(poc?.email) === target) || null
}

function followUpCandidate(raw, source) {
  const org = parseOrg(raw.fullParentPathName)
  if (normalized(org.department) !== normalized(source.department)) return null
  if (normalized(org.agency) !== normalized(source.agency)) return null
  const poc = matchingPOC(raw, source.pocEmail)
  if (!poc) return null
  const overlap = titleOverlapPercent(source.title, raw.title)
  if (overlap < 40) return null
  if (normalized(raw.noticeId) === normalized(source.noticeId)) return null

  return {
    noticeId:           String(raw.noticeId || '').trim(),
    solicitationNumber: String(raw.solicitationNumber || '').trim(),
    title:              String(raw.title || '').trim(),
    setAsideType:       String(raw.typeOfSetAsideDescription || '').trim(),
    department:         org.department,
    agency:             org.agency,
    office:             org.office,
    responseDate:       parseResponseDate(raw.responseDeadLine),
    naicsCode:          String(raw.naicsCode || raw.naics || '').trim(),
    samLink:            String(raw.uiLink || '').trim(),
    pocName:            String(poc.fullName || poc.fullname || '').trim(),
    pocEmail:           String(poc.email || '').trim(),
    pocPhone:           String(poc.phone || '').trim(),
    type:               String(raw.type || '').trim(),
    keywordOverlapPercent: overlap,
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

async function findRFIFollowUps(env, source) {
  const now = new Date()
  const from = new Date(now)
  from.setUTCDate(from.getUTCDate() - FOLLOW_UP_LOOKBACK_DAYS)
  const submissionDate = dateFromValue(source.submissionDate)
  const from = submissionDate ? new Date(submissionDate) : new Date(now)
  const to = submissionDate ? new Date(submissionDate) : new Date(now)

  if (submissionDate) {
    // SAM permits at most a one-year Posted Date range. Start at the RFI's
    // submission date so only later notices can qualify as follow-ons.
    to.setUTCFullYear(to.getUTCFullYear() + 1)
  } else {
    // With no submission date, center the one-year search window on today.
    from.setUTCMonth(from.getUTCMonth() - 6)
    to.setUTCMonth(to.getUTCMonth() + 6)
  }

  const [rfps, rfqs] = await Promise.all([
    fetchFollowUpNotices(env, 'o', formatDateParam(from), formatDateParam(now)),
    fetchFollowUpNotices(env, 'k', formatDateParam(from), formatDateParam(now)),
    fetchFollowUpNotices(env, 'o', formatDateParam(from), formatDateParam(to)),
    fetchFollowUpNotices(env, 'k', formatDateParam(from), formatDateParam(to)),
  ])
  const unique = new Map()
  for (const raw of [...rfps, ...rfqs]) {
    const candidate = followUpCandidate(raw, source)
    if (!candidate) continue
    const key = candidate.noticeId || candidate.solicitationNumber
    if (key && !unique.has(key)) unique.set(key, candidate)
  }
  return [...unique.values()].sort((a, b) => String(a.responseDate || '').localeCompare(String(b.responseDate || '')))
}

// ── KV helpers ────────────────────────────────────────────────────────────

async function setKeyExpired(env, expired) {
  if (!env.CACHE) return
  await env.CACHE.put('sam_key_expired', JSON.stringify({ expired }), {
    expirationTtl: 60 * 60 * 24 * 100,
  })
}

async function getKeyExpired(env) {
  if (!env.CACHE) return false
  const val = await env.CACHE.get('sam_key_expired', 'json')
  return val?.expired === true
}

async function setRunLog(env, log) {
  if (!env.CACHE) return
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
    pocEmail:   url.searchParams.get('pocEmail')?.trim() || '',
    title:      url.searchParams.get('title')?.trim() || '',
    noticeId:   url.searchParams.get('noticeId')?.trim() || '',
    submissionDate: url.searchParams.get('submissionDate')?.trim() || '',
  }
  const missing = Object.entries(source)
    .filter(([key, value]) => key !== 'noticeId' && !value)
    .filter(([key, value]) => key !== 'noticeId' && key !== 'submissionDate' && !value)
    .map(([key]) => key)
  if (missing.length > 0) {
    return json({ error: `Missing follow-up criteria: ${missing.join(', ')}` }, 400)
  }

  // The criteria are also the cache identity: if an RFI's title, POC, or
  // organization changes, it naturally gets a fresh matching result.
  const cacheKey = `rfi_followups:${cacheFingerprint(JSON.stringify(source))}`
  const cached = env.CACHE ? await env.CACHE.get(cacheKey, 'json') : null
  if (cached) return json({ ...cached, cached: true })

  try {
    const matches = await findRFIFollowUps(env, source)
    const response = { matches, count: matches.length }
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

async function runSAMPull(env, token, config) {
  const runStart = new Date().toISOString()
  console.log('[SAM] Pull started:', runStart)

  const { naicsCodes = [], skipDays = 3, windowDays = 90 } = config

  if (!naicsCodes.length) {
    const err = 'No NAICS codes provided'
    await setRunLog(env, { success: false, status: 'error', timestamp: runStart, error: err })
    throw new Error(err)
  }

  // Mark the run as in-progress immediately so /sam/run-status reflects a
  // live pull rather than stale data from the previous run (or nothing) —
  // this is the "monitor progress" ask. Intentionally limited to a handful
  // of KV writes total for the whole run (not one per NAICS code), since
  // each KV put() also counts against the subrequest budget.
  await setRunLog(env, {
    status: 'running', phase: 'fetching', timestamp: runStart, startedAt: runStart,
    naicsTotal: naicsCodes.length, naicsProcessed: 0,
  })

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
  try {
    existingRows = await getTableRows(env, token, 'NewOpportunitiesTable')
  } catch (err) {
    const msg = `Failed to read NewOpportunitiesTable: ${err.message}`
    await setRunLog(env, { success: false, status: 'error', timestamp: runStart, error: msg })
    throw new Error(msg)
  }

  const existingIds = new Set(
    existingRows.map((r) => String(r['Notice ID'] || '').trim()).filter(Boolean)
  )

  // Solicitation Number -> the most-recent variant we currently know about
  // (either already in the sheet, or a candidate fetched earlier this run).
  // `fromExisting: true` means rowIndex points at a real sheet row that
  // should be deleted if a newer candidate supersedes it; `false` means it
  // points at an in-memory candidate not yet written, which can simply be
  // dropped from the write list instead of needing a delete.
  const solNumIndex = new Map()
  existingRows.forEach((r) => {
    const solNum = normalizeSolNum(r['Solicitation Number'])
    if (!solNum) return
    const postedDate = String(r['Posted Date'] || '')
    const current = solNumIndex.get(solNum)
    if (!current || newerRecord(postedDate, current.postedDate)) {
      solNumIndex.set(solNum, { noticeId: r['Notice ID'], rowIndex: r._rowIndex, postedDate, fromExisting: true })
    }
  })

  // ── Phase 1: fetch + buffer candidates (not written yet) ───────────────
  // Buffering before writing lets us resolve Solicitation-Number dedup
  // correctly across the whole batch instead of writing blindly as we go.
  // Stops once we've buffered roughly enough candidates to fill this run's
  // write cap (mirrors the previous early-exit-on-cap behavior) so we don't
  // spend the full NAICS-list fetch budget on runs that would hit the write
  // cap anyway — any NAICS codes left unprocessed are picked up next run.
  //
  // Wrapped so a hard failure here (expired key, systemic SAM.gov outage)
  // is *recorded* rather than thrown immediately — cleanup below only
  // depends on existingRows (already read via the Graph API, independent of
  // SAM.gov), so it must still run even when the SAM.gov side fails.
  // Previously a fetch failure threw straight out of this function and
  // skipped cleanup entirely, which meant expired New Opportunities rows
  // stopped getting deleted for as long as SAM.gov was having problems.
  let totalFetched  = 0
  let naicsProcessed = 0
  const naicsErrors = []
  const candidates  = []   // { mapped, noticeId, solNum }
  let fatalError = null

  for (const naics of naicsCodes) {
    if (fatalError) break
    if (candidates.length >= MAX_WRITES_PER_RUN) {
      naicsErrors.push(`Fetch cap reached — ${naicsCodes.length - naicsProcessed} NAICS code(s) left for next run`)
      break
    }

    let records
    try {
      records = await fetchSAMForNAICS(env, naics, postedFrom, postedTo, rdlFrom, rdlTo)
      console.log(`[SAM] NAICS ${naics}: ${records.length} record(s)`)
      totalFetched += records.length
    } catch (err) {
      if (err.code === 'KEY_EXPIRED') {
        fatalError = 'SAM API key expired or invalid'
        naicsProcessed++
        break
      }

      naicsErrors.push(`NAICS ${naics}: ${err.message}`)
      console.error('[SAM] Fetch error:', err.message)

      // If the very FIRST NAICS code we attempt fails with a server-side
      // (5xx) error — even after the retries already attempted inside
      // fetchSAMForNAICS — this is very likely a systemic SAM.gov outage
      // rather than a one-off blip on that specific request. Stop
      // immediately instead of burning the rest of the run's subrequest
      // budget hammering a dead upstream with every remaining NAICS code.
      // A failure on a LATER code, after others already succeeded, is
      // treated as an isolated per-request issue and doesn't abort the run.
      if (naicsProcessed === 0 && /SAM API error 5\d\d/.test(err.message)) {
        fatalError = `SAM.gov API appears to be unavailable (${err.message}). Will retry automatically on the next pull.`
        console.error('[SAM]', fatalError)
        naicsProcessed++
        break
      }

      naicsProcessed++
      continue
    }

    for (const raw of records) {
      const noticeId = String(raw.noticeId || '').trim()
      if (!noticeId || existingIds.has(noticeId)) continue
      if (String(raw.active || '').toLowerCase() !== 'yes') continue
      const mapped = mapRecord(raw, naics)
      candidates.push({ mapped, noticeId, solNum: normalizeSolNum(mapped['Solicitation Number']) })
    }

    naicsProcessed++
  }

  // ── Resolve dedup ────────────────────────────────────────────────────────
  // Pass 1: collapse same Notice ID appearing more than once in this batch
  // (happens when a solicitation matches more than one tracked NAICS code).
  const byNoticeId = new Map()
  for (const c of candidates) {
    if (!byNoticeId.has(c.noticeId)) byNoticeId.set(c.noticeId, c)
  }

  // Pass 2: Solicitation-Number dedup against both existing sheet rows and
  // other candidates from this same batch — keep only the most recently
  // posted variant per solicitation.
  const dedupDeleteRowIndices = new Set()   // existing rows superseded by a newer candidate this run
  const toWrite = []

  for (const c of byNoticeId.values()) {
    if (!c.solNum) { toWrite.push(c); continue }

    const current = solNumIndex.get(c.solNum)
    if (!current) {
      solNumIndex.set(c.solNum, { noticeId: c.noticeId, rowIndex: null, postedDate: c.mapped['Posted Date'], fromExisting: false })
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
      solNumIndex.set(c.solNum, { noticeId: c.noticeId, rowIndex: null, postedDate: c.mapped['Posted Date'], fromExisting: false })
      toWrite.push(c)
    }
    // else: an existing row or an already-queued candidate is the same age
    // or newer — this candidate is a stale duplicate, drop it entirely.
  }

  // ── Phase 2: write survivors, capped to stay within subrequest budget ──
  // Skipped entirely if phase 1 hit a fatal error (nothing valid to write).
  let totalWritten = 0
  if (!fatalError) {
    await setRunLog(env, {
      status: 'running', phase: 'writing', timestamp: runStart, startedAt: runStart,
      naicsTotal: naicsCodes.length, naicsProcessed,
      toWrite: Math.min(toWrite.length, MAX_WRITES_PER_RUN), written: 0,
    })

    for (const c of toWrite) {
      if (totalWritten >= MAX_WRITES_PER_RUN) {
        const remaining = toWrite.length - totalWritten
        naicsErrors.push(`Write cap reached — ${remaining} opportunit${remaining === 1 ? 'y' : 'ies'} left for next run`)
        break
      }
      try {
        await appendOpportunity(env, token, c.mapped)
        totalWritten++
      } catch (err) {
        console.error(`[SAM] Write failed for ${c.noticeId}:`, err.message)
      }
    }

    // Clear key-expired flag — only reachable when the key demonstrably worked
    await setKeyExpired(env, false)
  }

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
      success: false, status: 'error', timestamp: runStart, error: fatalError,
      warnings: naicsErrors.length > 0 ? naicsErrors : undefined, deleted,
    }
    await setRunLog(env, log)
    throw new Error(fatalError)
  }

  const log = {
    success:   true,
    status:    'success',
    timestamp: runStart,
    fetched:   totalFetched,
    written:   totalWritten,
    deduped:   dedupDeleteRowIndices.size,
    deleted,
    warnings:  naicsErrors.length > 0 ? naicsErrors : undefined,
  }
  await setRunLog(env, log)
  console.log(`[SAM] Done. Fetched: ${totalFetched} | Written: ${totalWritten} | Deduped: ${dedupDeleteRowIndices.size} | Deleted: ${deleted}`)
  return log
}

// ── HTTP handler ──────────────────────────────────────────────────────────

export async function handleSAM(req, env, ctx) {
  const url = new URL(req.url)

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

  // GET /sam/follow-ups — find RFP/RFQ notices that follow an RFI
  if (url.pathname === '/sam/follow-ups' && req.method === 'GET') {
    return handleFollowUps(req, env)
  }

  // GET /sam/debug — step-by-step diagnostic (requires X-Trigger-Secret)
  if (url.pathname === '/sam/debug' && req.method === 'GET') {
    if (!env.SAM_TRIGGER_SECRET) return json({ error: 'SAM_TRIGGER_SECRET not configured' }, 503)
    const provided = req.headers.get('X-Trigger-Secret') || ''
    if (provided !== env.SAM_TRIGGER_SECRET) return json({ error: 'Unauthorized' }, 401)

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

  // POST /sam/trigger — on-demand pull using frontend-supplied token
  if (url.pathname === '/sam/trigger' && req.method === 'POST') {
    if (!env.SAM_TRIGGER_SECRET) return json({ error: 'SAM_TRIGGER_SECRET not configured' }, 503)
    const provided = req.headers.get('X-Trigger-Secret') || ''
    if (provided !== env.SAM_TRIGGER_SECRET) return json({ error: 'Unauthorized' }, 401)

    if (!env.SAM_API_KEY)  return json({ error: 'SAM_API_KEY not configured' }, 503)
    if (!env.WORKBOOK_ID)  return json({ error: 'WORKBOOK_ID not configured' }, 503)

    let body
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }

    const { token, config, force = false } = body

    if (!token) return json({ error: 'Missing token in request body' }, 400)
    if (!config?.naicsCodes?.length) return json({ error: 'Missing or empty config.naicsCodes' }, 400)

    // 12h throttle check (skipped when force=true, e.g. Settings page force pull)
    if (!force) {
      const lastLog = await getRunLog(env)
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

    // Run in background so response returns immediately
    const pullPromise = runSAMPull(env, token, config)
    if (ctx?.waitUntil) ctx.waitUntil(pullPromise)
    else pullPromise.catch((err) => console.error('[SAM] Pull error:', err))

    return json({
      ok:      true,
      message: 'SAM pull started — check /sam/run-status in a few minutes for results',
      force,
    })
  }

  return json({ error: 'Not found' }, 404)
}
