/**
 * sam.js — SAM.gov Get Opportunities integration
 *
 * Cron: 0 8 * * * (UTC) = 3 AM EST / 4 AM EDT daily
 *
 * Flow per run:
 *   1. Read SAMNAICSTable + SAMSettingsTable from workbook via Graph API
 *   2. For each NAICS code: paginate SAM.gov API (ptype=r, Sources Sought only)
 *   3. Deduplicate by noticeId across all NAICS calls
 *   4. Map fields, append new rows to NewOpportunitiesTable (skip existing noticeIds)
 *   5. Delete rows where Response Date < today (all statuses)
 *   6. On 401 from SAM API: set sam_key_expired=true in KV
 *
 * HTTP handler (GET /sam/key-status):
 *   Returns { expired: bool } — frontend polls this to show rotation reminder.
 *
 * Secrets required:
 *   SAM_API_KEY         — SAM.gov public API key (rotate every 90 days)
 *   MS_TENANT_ID        — Azure AD tenant
 *   MS_CLIENT_ID        — App registration client ID
 *   MS_CLIENT_SECRET    — App registration secret
 *   DRIVE_ID            — SharePoint drive ID (already set)
 *   WORKBOOK_ID         — SharePoint workbook item ID
 */

const SAM_BASE   = 'https://api.sam.gov/opportunities/v2/search'
const PAGE_SIZE  = 500
const REQ_DELAY  = 500   // ms between paginated calls per NAICS

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
  // MM/DD/YYYY as required by SAM API
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  return `${mm}/${dd}/${yyyy}`
}

function parseResponseDate(val) {
  // SAM returns various formats — normalise to YYYY-MM-DD
  if (!val) return ''
  const s = String(val).trim()
  // Try ISO-like
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  // Try with time component
  const dt = s.match(/^(\d{4}-\d{2}-\d{2})T/)
  if (dt) return dt[1]
  // Try MM/DD/YYYY
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
  const parts = [name, email, phone].filter(Boolean)
  return parts.join(' | ')
}

function parseOrg(fullParentPathName) {
  const parts = String(fullParentPathName || '').split('.').map((s) => s.trim()).filter(Boolean)
  return {
    department: parts[0] || '',
    agency:     parts[1] || parts[0] || '',
    office:     parts[2] || '',
  }
}

// ── Graph API helpers ─────────────────────────────────────────────────────

async function getGraphToken(env) {
  const res = await fetch(
    `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        scope:         'https://graph.microsoft.com/.default',
      }),
    }
  )
  if (!res.ok) throw new Error(`Graph token error: ${res.status}`)
  const { access_token } = await res.json()
  return access_token
}

function workbookBase(env) {
  return `https://graph.microsoft.com/v1.0/drives/${env.DRIVE_ID}/items/${env.WORKBOOK_ID}/workbook`
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

// ── Read workbook tables ──────────────────────────────────────────────────

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

async function readConfig(env, token) {
  const [naicsRows, settingsRows] = await Promise.all([
    getTableRows(env, token, 'SAMNAICSTable'),
    getTableRows(env, token, 'SAMSettingsTable'),
  ])

  const naicsCodes = naicsRows
    .map((r) => String(r['NAICS Code'] || '').trim())
    .filter(Boolean)

  const settingsMap = {}
  settingsRows.forEach((r) => {
    const k = String(r['Setting'] || '').trim()
    if (k) settingsMap[k] = r['Value']
  })

  return {
    naicsCodes,
    skipDays:   Number(settingsMap['Skip Days']   ?? 3),
    windowDays: Number(settingsMap['Window Days'] ?? 90),
  }
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
  // Collect in descending order so indices stay valid as we delete
  const toDelete = rows
    .filter((r) => {
      const rd = String(r['Response Date'] || '').trim().slice(0, 10)
      return rd && rd < today
    })
    .sort((a, b) => b._rowIndex - a._rowIndex)

  for (const row of toDelete) {
    await graphFetch(env, token,
      `/tables/NewOpportunitiesTable/rows/itemAt(index=${row._rowIndex})`,
      { method: 'DELETE' }
    )
  }
  console.log(`[SAM] Deleted ${toDelete.length} expired row(s)`)
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
      ptype:      'r',              // Sources Sought only
      ncode:      naicsCode,
      postedFrom,
      postedTo,
      rdlfrom:    rdlFrom,
      rdlto:      rdlTo,
      limit:      String(PAGE_SIZE),
      offset:     String(offset),
    })

    const res = await fetch(`${SAM_BASE}?${params}`)

    // 401 = key expired or invalid
    if (res.status === 401) throw Object.assign(new Error('SAM API key expired or invalid'), { code: 'KEY_EXPIRED' })
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
    expirationTtl: 60 * 60 * 24 * 100,  // 100 days — longer than key lifetime
  })
}

async function getKeyExpired(env) {
  if (!env.CACHE) return false
  const val = await env.CACHE.get('sam_key_expired', 'json')
  return val?.expired === true
}

// ── Cron handler ──────────────────────────────────────────────────────────

export async function handleSAMCron(env) {
  console.log('[SAM] Cron started:', new Date().toISOString())

  if (!env.SAM_API_KEY)    return console.error('[SAM] SAM_API_KEY secret not set')
  if (!env.MS_TENANT_ID)   return console.error('[SAM] MS_TENANT_ID not set')
  if (!env.WORKBOOK_ID)    return console.error('[SAM] WORKBOOK_ID not set')

  let token
  try {
    token = await getGraphToken(env)
  } catch (err) {
    return console.error('[SAM] Failed to get Graph token:', err.message)
  }

  // Read config
  let config
  try {
    config = await readConfig(env, token)
    console.log(`[SAM] ${config.naicsCodes.length} NAICS codes | Skip ${config.skipDays}d | Window ${config.windowDays}d`)
  } catch (err) {
    return console.error('[SAM] Failed to read SAMConfig:', err.message)
  }

  // Build date ranges
  const now       = new Date()
  const postedFrom = formatDateParam(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, now.getUTCDate())))
  const postedTo   = formatDateParam(now)
  const rdlStart   = new Date(now)
  rdlStart.setUTCDate(rdlStart.getUTCDate() + config.skipDays)
  const rdlEnd     = new Date(rdlStart)
  rdlEnd.setUTCDate(rdlEnd.getUTCDate() + config.windowDays)
  const rdlFrom    = formatDateParam(rdlStart)
  const rdlTo      = formatDateParam(rdlEnd)

  console.log(`[SAM] Posted: ${postedFrom}→${postedTo} | Deadline: ${rdlFrom}→${rdlTo}`)

  // Get existing notice IDs to skip duplicates
  let existingIds
  try {
    existingIds = await getExistingNoticeIds(env, token)
    console.log(`[SAM] ${existingIds.size} existing notice(s) in sheet`)
  } catch (err) {
    return console.error('[SAM] Failed to read existing rows:', err.message)
  }

  // Fetch and write
  let totalFetched  = 0
  let totalWritten  = 0
  const seen = new Set(existingIds)

  for (const naics of config.naicsCodes) {
    let records
    try {
      records = await fetchSAMForNAICS(env, naics, postedFrom, postedTo, rdlFrom, rdlTo)
      console.log(`[SAM] NAICS ${naics}: ${records.length} record(s)`)
      totalFetched += records.length
    } catch (err) {
      if (err.code === 'KEY_EXPIRED') {
        await setKeyExpired(env, true)
        console.error('[SAM] API key expired — stopping run, frontend notified')
        return
      }
      console.error(`[SAM] Fetch error for NAICS ${naics}:`, err.message)
      continue
    }

    for (const raw of records) {
      const noticeId = String(raw.noticeId || '').trim()
      if (!noticeId || seen.has(noticeId)) continue
      if (String(raw.active || '').toLowerCase() !== 'yes') continue

      seen.add(noticeId)
      const mapped = mapRecord(raw, naics)

      try {
        await appendOpportunity(env, token, mapped)
        totalWritten++
      } catch (err) {
        console.error(`[SAM] Failed to write ${noticeId}:`, err.message)
      }
    }

    await sleep(REQ_DELAY)
  }

  // Clear key-expired flag if run succeeded
  await setKeyExpired(env, false)

  // Delete expired rows
  let deleted = 0
  try {
    deleted = await deleteExpiredRows(env, token)
  } catch (err) {
    console.error('[SAM] Cleanup error:', err.message)
  }

  console.log(`[SAM] Done. Fetched: ${totalFetched} | Written: ${totalWritten} | Deleted: ${deleted}`)
}

// ── HTTP handler ──────────────────────────────────────────────────────────

export async function handleSAM(req, env) {
  const url = new URL(req.url)

  // GET /sam/key-status — frontend polls for rotation reminder
  if (url.pathname === '/sam/key-status' && req.method === 'GET') {
    const expired = await getKeyExpired(env)
    return json({ expired })
  }

  return json({ error: 'Not found' }, 404)
}
