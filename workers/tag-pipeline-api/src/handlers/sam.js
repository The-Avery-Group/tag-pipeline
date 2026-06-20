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
const REQ_DELAY = 500   // ms between paginated calls per NAICS

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

function todayISO() {
  return new Date().toISOString().split('T')[0]
}

function formatDateParam(d) {
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd   = String(d.getUTCDate()).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  return `${mm}/${dd}/${yyyy}`
}

function parseResponseDate(val) {
  if (!val) return ''
  const s = String(val).trim()
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const dt = s.match(/^(\d{4}-\d{2}-\d{2})T/)
  if (dt) return dt[1]
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

// ── Read existing noticeIds to avoid duplicates ───────────────────────────

async function getExistingNoticeIds(env, token) {
  const rows = await getTableRows(env, token, 'NewOpportunitiesTable')
  return new Set(rows.map((r) => String(r['Notice ID'] || '').trim()).filter(Boolean))
}

// ── Delete expired rows ───────────────────────────────────────────────────

async function deleteExpiredRows(env, token) {
  const rows = await getTableRows(env, token, 'NewOpportunitiesTable')
  const today = todayISO()
  const toDelete = rows
    .filter((r) => {
      const rd = String(r['Response Date'] || '').trim().slice(0, 10)
      return rd && rd < today
    })
    .sort((a, b) => b._rowIndex - a._rowIndex)   // descending so indices stay valid

  for (const row of toDelete) {
    await graphFetch(env, token,
      `/tables/NewOpportunitiesTable/rows/itemAt(index=${row._rowIndex})`,
      { method: 'DELETE' }
    )
  }
  return toDelete.length
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

    const res = await fetch(`${SAM_BASE}?${params}`)

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
    await sleep(REQ_DELAY)
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

// ── Core pull logic (shared by trigger) ──────────────────────────────────

async function runSAMPull(env, token, config) {
  const runStart = new Date().toISOString()
  console.log('[SAM] Pull started:', runStart)

  const { naicsCodes = [], skipDays = 3, windowDays = 90 } = config

  if (!naicsCodes.length) {
    const err = 'No NAICS codes provided'
    await setRunLog(env, { success: false, timestamp: runStart, error: err })
    throw new Error(err)
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

  // Get existing notice IDs
  let existingIds
  try {
    existingIds = await getExistingNoticeIds(env, token)
  } catch (err) {
    const msg = `Failed to read NewOpportunitiesTable: ${err.message}`
    await setRunLog(env, { success: false, timestamp: runStart, error: msg })
    throw new Error(msg)
  }

  // Fetch and write
  let totalFetched  = 0
  let totalWritten  = 0
  const seen        = new Set(existingIds)
  const naicsErrors = []

  for (const naics of naicsCodes) {
    let records
    try {
      records = await fetchSAMForNAICS(env, naics, postedFrom, postedTo, rdlFrom, rdlTo)
      console.log(`[SAM] NAICS ${naics}: ${records.length} record(s)`)
      totalFetched += records.length
    } catch (err) {
      if (err.code === 'KEY_EXPIRED') {
        const msg = 'SAM API key expired or invalid'
        await setRunLog(env, { success: false, timestamp: runStart, error: msg })
        throw new Error(msg)
      }
      const msg = `NAICS ${naics}: ${err.message}`
      naicsErrors.push(msg)
      console.error(`[SAM] Fetch error for ${msg}`)
      continue
    }

    for (const raw of records) {
      const noticeId = String(raw.noticeId || '').trim()
      if (!noticeId || seen.has(noticeId)) continue
      if (String(raw.active || '').toLowerCase() !== 'yes') continue
      seen.add(noticeId)
      try {
        await appendOpportunity(env, token, mapRecord(raw, naics))
        totalWritten++
      } catch (err) {
        console.error(`[SAM] Failed to write ${noticeId}:`, err.message)
      }
    }

    await sleep(REQ_DELAY)
  }

  // Clear key-expired flag
  await setKeyExpired(env, false)

  // Delete expired rows
  let deleted = 0
  try {
    deleted = await deleteExpiredRows(env, token)
  } catch (err) {
    console.error('[SAM] Cleanup error:', err.message)
  }

  const log = {
    success:   true,
    timestamp: runStart,
    fetched:   totalFetched,
    written:   totalWritten,
    deleted,
    warnings:  naicsErrors.length > 0 ? naicsErrors : undefined,
  }
  await setRunLog(env, log)
  console.log(`[SAM] Done. Fetched: ${totalFetched} | Written: ${totalWritten} | Deleted: ${deleted}`)
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
    return json(log || { success: null, timestamp: null })
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
