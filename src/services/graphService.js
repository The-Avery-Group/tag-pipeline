import { InteractionRequiredAuthError } from '@azure/msal-browser'
import { msalInstance, loginRequest, silentTokenOptions } from '@/auth/msalConfig'
import { externallyChangedPatchedFields, recordIdentity } from '@/utils/recordConflict'
import {
  appendWithReconciliation,
  createFingerprint,
  createStableId,
  queueTableMutation,
} from '@/services/workbookMutations'
import { deterministicDraftId } from '@/utils/followUpEmails'
import { parsePOCNames } from '@/utils/contactOpportunityLinks'

export { parsePOCNames } from '@/utils/contactOpportunityLinks'

// VITE_ONEDRIVE_FILE_ID is the SharePoint drive item ID of the workbook,
// e.g. 01FVYRIFDLMKLW3D4HKVE34O5ZGVXE4Y6H
const ITEM_ID = import.meta.env.VITE_ONEDRIVE_FILE_ID

// The driveId of the SharePoint document library that owns the workbook.
// This is a fixed value tied to the workbook's location, not per-user, so
// it's safe to hardcode here rather than make it an env var.
const DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'

// Resolved once per session
let _resolvedBase = null

async function resolveWorkbookBase() {
  if (_resolvedBase) return _resolvedBase
  _resolvedBase = `https://graph.microsoft.com/v1.0/drives/${DRIVE_ID}/items/${ITEM_ID}/workbook`
  return _resolvedBase
}

// ── In-memory cache ────────────────────────────────────────────────────────
const cache = new Map()
const pendingSheetReads = new Map()
// Table schemas change far less often than table rows. Keep headers across
// routine data refreshes so polling does not double every Graph request.
const headerCache = new Map()
const sessionRefreshListeners = new Set()
let sessionRefreshRequired = false
let silentTokenRequest = null

/**
 * Lets the application present one consistent recovery action when Entra can
 * no longer renew the current session in the background.
 */
export function onSessionRefreshRequired(listener) {
  sessionRefreshListeners.add(listener)
  return () => sessionRefreshListeners.delete(listener)
}

export function isSessionRefreshRequired() {
  return sessionRefreshRequired
}

export function clearSessionRefreshRequired() {
  sessionRefreshRequired = false
}

export function requestSessionRefresh(error) {
  if (sessionRefreshRequired) return
  sessionRefreshRequired = true
  sessionRefreshListeners.forEach((listener) => listener(error))
}

function invalidate(sheet) {
  cache.delete(sheet)
}

/** Clear the entire cache — called by dataCache before a full re-fetch. */
export function invalidateAll() {
  cache.clear()
  // A workbook table can gain or lose columns while the app is open. Keeping
  // the old schema after a full refresh makes row PATCH payloads the wrong
  // width, which Excel rejects with a range-dimensions error.
  headerCache.clear()
  notificationRecipientsUnavailable = false
  contactInteractionsUnavailable = false
}

/** Invalidate only the tables changed by a successful workbook mutation. */
export function invalidateTables(tableNames = []) {
  tableNames.forEach((tableName) => invalidate(tableName))
}

/** Tables already loaded in this browser session. */
export function getCachedTableNames() {
  return [...cache.keys()]
}

async function createWorkbookRecord({ tableName, idColumn, idValue, ...options }) {
  return queueTableMutation(tableName, async () => {
    const saved = await appendWithReconciliation({ idColumn, idValue, ...options })
    const flags = {
      _recovered: Boolean(saved?._recovered),
      _alreadyExisted: Boolean(saved?._alreadyExisted),
    }

    // Appending can change every positional row index, especially when the
    // workbook table is sorted. Do not rebuild the cache from rows captured
    // before the append. Re-read once and return the authoritative saved row.
    invalidate(tableName)
    try {
      const freshRows = await getSheetRows(tableName)
      const identity = String(idValue || '').trim().toLowerCase()
      const current = freshRows.find((row) =>
        String(row?.[idColumn] || '').trim().toLowerCase() === identity
      )
      return current ? { ...current, ...flags } : saved
    } catch {
      // The append already succeeded. Keep the table invalidated so the next
      // reader performs the reconciliation, but never tell the user that a
      // successfully created record failed and encourage a duplicate retry.
      return { ...saved, ...flags, _verificationPending: true }
    }
  })
}

async function getTableHeaders(tableName, { force = false } = {}) {
  if (!force && headerCache.has(tableName)) return headerCache.get(tableName)
  const headerData = await graphFetch(`/tables/${tableName}/columns`)
  const headers = headerData.value.map((column) => column.name)
  headerCache.set(tableName, headers)
  return headers
}

export async function ensureTableColumns(tableName, columnNames = []) {
  let headers = await getTableHeaders(tableName, { force: true })
  const added = []
  for (const name of columnNames) {
    if (headers.includes(name)) continue
    await graphFetch(`/tables/${tableName}/columns`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    added.push(name)
    headerCache.delete(tableName)
    headers = await getTableHeaders(tableName, { force: true })
  }
  if (added.length) invalidate(tableName)
  return { headers, added }
}

// ── Token helper ───────────────────────────────────────────────────────────
export function isInteractionRequiredError(error) {
  return error instanceof InteractionRequiredAuthError ||
    ['interaction_required', 'login_required', 'consent_required'].includes(error?.errorCode)
}

export async function getToken({ interactive = false } = {}) {
  const account = msalInstance.getAllAccounts()[0]
  if (!account) {
    const error = new Error('No authenticated account')
    requestSessionRefresh(error)
    throw error
  }
  try {
    if (!silentTokenRequest) {
      silentTokenRequest = msalInstance.acquireTokenSilent({
        ...loginRequest,
        ...silentTokenOptions,
        account,
      }).finally(() => {
        silentTokenRequest = null
      })
    }
    const response = await silentTokenRequest
    return response.accessToken
  } catch (error) {
    // Background reads must not unexpectedly open a sign-in window. An
    // explicit user action may request the same scopes interactively instead.
    if (!isInteractionRequiredError(error)) throw error
    if (!interactive) {
      requestSessionRefresh(error)
      throw error
    }
    const response = await msalInstance.acquireTokenPopup({ ...loginRequest, account })
    clearSessionRefreshRequired()
    return response.accessToken
  }
}

async function graphFetch(path, options = {}) {
  const { retryReads = false, ...requestOptions } = options
  const token = await getToken()
  const base = await resolveWorkbookBase()
  const method = String(requestOptions.method || 'GET').toUpperCase()
  const retryableRead = retryReads && method === 'GET'

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${base}${path}`, {
      ...requestOptions,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(requestOptions.headers || {}),
      },
    })
    if (res.ok) {
      // 204 No Content
      if (res.status === 204) return null
      return res.json()
    }

    if (res.status === 401) requestSessionRefresh(new Error('Microsoft Graph session is no longer valid'))

    const shouldRetry = retryableRead && [429, 502, 503, 504].includes(res.status) && attempt < 2
    if (shouldRetry) {
      // Consume the response before retrying so the browser can release it.
      await res.text().catch(() => '')
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
      continue
    }

    const err = await res.json().catch(() => ({}))
    const fallback = [502, 503, 504].includes(res.status)
      ? `Microsoft Graph is temporarily unavailable (${res.status}). Please retry.`
      : `Graph API error: ${res.status}`
    const graphError = new Error(err?.error?.message || fallback)
    graphError.status = res.status
    graphError.code = err?.error?.code || ''
    throw graphError
  }
}

/**
 * A lightweight workbook version probe. A change to the SharePoint drive item
 * means at least one table may have changed, without downloading every table
 * merely to discover that nothing changed.
 */
export async function getWorkbookVersion() {
  if (!ITEM_ID) throw new Error('VITE_ONEDRIVE_FILE_ID not set')
  const token = await getToken()
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${DRIVE_ID}/items/${ITEM_ID}?$select=eTag,lastModifiedDateTime`,
    {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        'Cache-Control': 'no-cache',
      },
    },
  )
  if (!response.ok) {
    if (response.status === 401) requestSessionRefresh(new Error('Microsoft Graph session is no longer valid'))
    const body = await response.json().catch(() => ({}))
    throw new Error(body?.error?.message || `Could not check workbook changes (${response.status})`)
  }
  const item = await response.json()
  return { eTag: String(item.eTag || ''), lastModifiedDateTime: item.lastModifiedDateTime || '' }
}

// ── Generic sheet helpers ──────────────────────────────────────────────────

// All column headers that hold date values across every table.
// Excel returns date cells as serial numbers (days since Jan 1 1900).
// We normalise them to ISO strings on every read.
const DATE_COLUMNS = new Set([
  'DueDate', 'CreatedDate', 'UpdatedDate', 'Date',
  'Submission Date (Response Date)*',
  'Contract End Date*',
  'Anticipated year for Award (MM/DD/YYYY)*',
  'Questions Due',
  '8(a) Exit Date',
  'Last Modified*',
  'Interaction Date',
  'Follow-up Date',
  'Response Date',   // NewOpportunitiesTable
  'Posted Date',     // NewOpportunitiesTable
  'Date Added',      // NewOpportunitiesTable
  'Due Date',        // EmailFollowUpDraftsTable
  'Created At',      // Email follow-up tables
  'Updated At',      // Email follow-up tables
  'Enrollment Date', // EmailFollowUpDraftsTable
])

/**
 * Convert an Excel date serial → 'YYYY-MM-DD' or a local ISO date-time.
 * Passes through values that are already ISO strings.
 */
function excelDateToISO(val) {
  if (val === null || val === undefined || val === '') return ''
  // Already a readable string (e.g. manually typed '2025-08-15')
  if (typeof val === 'string') return val
  const serial = Number(val)
  if (isNaN(serial) || serial < 1) return ''
  // 25569 = days between Excel epoch (Jan 1 1900) and Unix epoch (Jan 1 1970)
  const ms = (serial - 25569) * 86400 * 1000
  const d = new Date(ms)
  if (isNaN(d.getTime())) return ''
  // Excel date-times are serials whose fractional part represents the time.
  // Preserve it so response deadlines do not silently become date-only in
  // the opportunity summary. UTC components preserve Excel's wall-clock
  // value without applying the browser's timezone a second time.
  const iso = d.toISOString()
  const hasTime = Math.abs(serial - Math.trunc(serial)) > 1e-8
  return hasTime ? iso.slice(0, 19) : iso.slice(0, 10)
}

/**
 * Convert an ISO date string 'YYYY-MM-DD' → Excel serial number.
 * Writing serials back to Excel prevents Excel from mis-parsing the string.
 */
function isoToExcelSerial(iso) {
  if (!iso || typeof iso !== 'string' || !iso.match(/^\d{4}-\d{2}-\d{2}$/)) return iso
  const [y, m, d] = iso.split('-').map(Number)
  // Use UTC Date to avoid timezone affecting the day count
  const ms = Date.UTC(y, m - 1, d)
  const serial = Math.round(ms / 86400000) + 25569
  return serial
}

/**
 * Read all rows from a named table.
 * Returns array of plain objects keyed by column headers.
 * Date columns are normalised from Excel serial numbers to ISO strings.
 * Also re-normalises any stale cached rows that were stored before this fix.
 */
export async function getSheetRows(tableName) {
  if (cache.has(tableName)) {
    const cached = cache.get(tableName)
    const needsFix = cached.some((row) =>
      [...DATE_COLUMNS].some((col) => col in row && typeof row[col] === 'number')
    )
    if (!needsFix) return cached
    const fixed = cached.map((row) => {
      const obj = { ...row }
      DATE_COLUMNS.forEach((col) => {
        if (col in obj) obj[col] = excelDateToISO(obj[col])
      })
      return obj
    })
    cache.set(tableName, fixed)
    return fixed
  }
  if (pendingSheetReads.has(tableName)) return pendingSheetReads.get(tableName)

  const request = (async () => {
    const getRows = async () => {
      // Contacts can grow independently of the rest of the workbook. Microsoft
      // Graph recommends paging table rows to avoid timeouts on large tables.
      if (tableName !== 'ContactsTable') return graphFetch(`/tables/${tableName}/rows`)

      const pageSize = 250
      const allRows = []
      for (let skip = 0; ; skip += pageSize) {
        const page = await graphFetch(`/tables/${tableName}/rows?$top=${pageSize}&$skip=${skip}`, { retryReads: true })
        const pageRows = page.value || []
        allRows.push(...pageRows)
        if (pageRows.length < pageSize) return { ...page, value: allRows }
      }
    }
    const [data, headers] = await Promise.all([
      getRows(),
      getTableHeaders(tableName),
    ])
    const rows = (data.value || []).map((row) => {
      const obj = {}
      headers.forEach((h, i) => {
        const raw = row.values[0][i]
        obj[h] = DATE_COLUMNS.has(h) ? excelDateToISO(raw) : raw
      })
      obj._rowIndex = row.index
      return obj
    })
    cache.set(tableName, rows)
    return rows
  })()
  pendingSheetReads.set(tableName, request)
  try {
    return await request
  } finally {
    pendingSheetReads.delete(tableName)
  }
}

/**
 * Append a new row to a named table.
 * values: object with keys matching column headers.
 * ISO date strings are converted to Excel serials so Excel stores them correctly.
 */
export async function appendRow(tableName, values, headers) {
  const row = headers.map((h) => {
    const val = values[h] ?? ''
    return DATE_COLUMNS.has(h) ? isoToExcelSerial(val) : val
  })
  const response = await graphFetch(`/tables/${tableName}/rows/add`, {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  })
  invalidate(tableName)
  return response
}

/**
 * Update a row in a named table by row index.
 * patch: object with only the fields to update.
 */
async function updateRowUnlocked(tableName, rowIndex, patch, headers, options = {}) {
  // Never rebuild an Excel row from a stale browser cache. A direct workbook
  // edit can happen while this app is open; read the current row immediately
  // before writing so unrelated changes are retained.
  const cachedAtIndex = cache.get(tableName)?.find((row) => row._rowIndex === rowIndex) || null
  const cached = options.original || cachedAtIndex
  let targetRowIndex = rowIndex
  const identity = String(options.identity || recordIdentity(tableName, cached) || '').trim()
  if (identity) {
    invalidate(tableName)
    const liveRows = await getSheetRows(tableName)
    const located = liveRows.find((row) => recordIdentity(tableName, row) === identity)
    if (!located) throw new Error('This record could not be located by its identifier. Refresh and review it before saving.')
    targetRowIndex = located._rowIndex
  }
  const response = await graphFetch(`/tables/${tableName}/rows/itemAt(index=${targetRowIndex})`, { retryReads: true })
  const values = response?.values?.[0]
  if (!values) throw new Error(`Row ${targetRowIndex} not found in ${tableName}`)
  let activeHeaders = Array.isArray(headers) ? headers : []
  if (activeHeaders.length !== values.length) {
    activeHeaders = await getTableHeaders(tableName, { force: true })
  }
  if (activeHeaders.length !== values.length) {
    throw new Error(
      `${tableName} has ${activeHeaders.length} table columns but this row has ${values.length}. ` +
      'Refresh the workbook table structure before saving.',
    )
  }
  let current = { _rowIndex: targetRowIndex }
  activeHeaders.forEach((header, index) => {
    current[header] = DATE_COLUMNS.has(header) ? excelDateToISO(values[index]) : values[index]
  })

  // A table row index can move when someone edits the workbook directly.
  // Refuse to write if the record at that index is no longer the record the
  // user started editing, rather than silently changing a different record.
  if (identity && identity !== recordIdentity(tableName, current)) {
    // Row insertions and sorting can move a record without changing the
    // record itself. Relocate it by its stable ID, then retain the same
    // field-level conflict check below so external edits are still protected.
    invalidate(tableName)
    const freshRows = await getSheetRows(tableName)
    const relocated = freshRows.find((row) => recordIdentity(tableName, row) === identity)
    if (!relocated) {
      throw new Error('This record changed position in the workbook and could not be located. Refresh and review it before saving.')
    }
    targetRowIndex = relocated._rowIndex
    current = relocated
    // getSheetRows() above used the newly refreshed header list. Keep the
    // outgoing row aligned with that same live schema.
    activeHeaders = await getTableHeaders(tableName)
  }

  const conflictedFields = externallyChangedPatchedFields(cached, current, patch)
  if (conflictedFields.length) {
    throw new Error(`This record was changed in Excel (${conflictedFields.join(', ')}). Refresh and review it before saving.`)
  }

  const merged = { ...current, ...patch }
  const row = activeHeaders.map((h) => {
    const val = merged[h] ?? ''
    return DATE_COLUMNS.has(h) ? isoToExcelSerial(val) : val
  })
  await graphFetch(`/tables/${tableName}/rows/itemAt(index=${targetRowIndex})`, {
    method: 'PATCH',
    body: JSON.stringify({ values: [row] }),
  })
  // Keep the successful write in the shared browser cache. Invalidating here
  // forces every mounted consumer to wait for another Graph read and leaves
  // universal search temporarily indexing the old row.
  const cachedRows = cache.get(tableName)
  if (cachedRows) {
    cache.set(tableName, cachedRows.map((cachedRow) =>
      cachedRow._rowIndex === targetRowIndex
        ? { ...current, ...patch, _rowIndex: targetRowIndex }
        : cachedRow
    ))
  }
}

export function updateRow(tableName, rowIndex, patch, headers, options = {}) {
  return queueTableMutation(tableName, () =>
    updateRowUnlocked(tableName, rowIndex, patch, headers, options)
  )
}

/**
 * Retry an idempotent row patch after transient Graph failures. A PATCH can
 * succeed even when Graph returns an ambiguous 5xx response, so each retry
 * first reloads the table and checks whether the requested values already
 * reached the workbook. Stable record identity prevents retrying against a
 * different row after workbook sorting or row insertion.
 */
export async function updateRowWithReconciliation(tableName, rowIndex, patch, headers, { attempts = 3 } = {}) {
  return queueTableMutation(tableName, async () => {
    const original = cache.get(tableName)?.find((row) => row._rowIndex === rowIndex) || null
    const identity = recordIdentity(tableName, original)
    let targetRowIndex = rowIndex
    let lastError

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await updateRowUnlocked(tableName, targetRowIndex, patch, headers, { original, identity })
        return { reconciled: false, attempts: attempt + 1 }
      } catch (error) {
        lastError = error
        const transient = [429, 502, 503, 504].includes(Number(error?.status))
        if (!transient || !identity || attempt >= attempts - 1) throw error

        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
        invalidate(tableName)
        const freshRows = await getSheetRows(tableName)
        const current = freshRows.find((row) => recordIdentity(tableName, row) === identity)
        if (!current) throw new Error('This record moved in the workbook and could not be located during retry.')

        const applied = Object.entries(patch).every(([field, value]) =>
          String(current?.[field] ?? '').trim() === String(value ?? '').trim()
        )
        if (applied) return { reconciled: true, attempts: attempt + 1 }
        targetRowIndex = current._rowIndex
      }
    }

    throw lastError
  })
}

/**
 * Delete a row from a named table by row index.
 */
export function deleteRow(tableName, rowIndex, options = {}) {
  return queueTableMutation(tableName, async () => {
    const cached = options.original || cache.get(tableName)?.find((row) => row._rowIndex === rowIndex) || null
    const identity = String(options.identity || recordIdentity(tableName, cached) || '').trim()
    let targetRowIndex = rowIndex

    // A delete changes every following row index. Resolve the target by its
    // stable identity immediately before deleting, then rebuild the table
    // cache before the next queued mutation is allowed to begin.
    if (identity) {
      invalidate(tableName)
      const currentRows = await getSheetRows(tableName)
      const current = currentRows.find((row) => recordIdentity(tableName, row) === identity)
      // A retried delete after an ambiguous Graph response is successful when
      // the stable identity is already absent.
      if (!current) return { alreadyDeleted: true }
      targetRowIndex = current._rowIndex
    }

    // Microsoft Graph's delete API targets the table-row collection directly.
    // Deleting the itemAt() range can make Excel attempt to shift worksheet
    // cells through the table, which Excel rejects for permanent deletions.
    await graphFetch(`/tables/${tableName}/rows/${targetRowIndex}`, {
      method: 'DELETE',
    })
    invalidate(tableName)
    await getSheetRows(tableName)
  })
}

// ── Column header constants ────────────────────────────────────────────────
// These match the exact column headers in the real Pipeline sheet (40 columns)
export const PIPELINE_HEADERS = [
  'TAG Opportunity Phase',            // [0]  col A — Identified / Research / Qualified / Proposal / Pending Award / Contract Awarded / Cancelled
  'TAG Pipeline Activity Phase',      // [1]  col B — Submitted RFI / Pre RFP / etc.
  'Fiscal Year',                      // [2]  col C
  'Opportunity Outlook',              // [3]  col D — Expiring / Forecasted / New
  'Submission Date (Response Date)*', // [4]  col E
  'Response Phase',                   // [5]  col F
  'Contract Number / Notice ID',      // [6]  col G  ← foreign key used everywhere
  'Project Title / Description*',     // [7]  col H
  'Solicitation Number',              // [8]  col I
  'Contract Vehicle Number',          // [9]  col J
  'Contract Vehicle',                 // [10] col K
  'Contract Classification*',         // [11] col L
  'Set- Aside*',                      // [12] col M
  'Department*',                      // [13] col N
  'Agency*',                          // [14] col O
  'Office*',                          // [15] col P
  'Contract End Date*',               // [16] col Q
  'Contracting Officer / Specialist (POC)*', // [17] col R
  'NAICS Code*',                      // [18] col S
  'Total Contract Value ($)*',        // [19] col T
  'Incumbent (Company Name)',         // [20] col U
  'Incumbent (Company UEI)',          // [21] col V
  '8(a) Exit Date',                   // [22] col W
  'Base Year Value ($)*',             // [23] col X
  'GovWin Link*',                     // [24] col Y
  'Other Links*',                     // [25] col Z
  'Expiring Contract Number ',        // [26] col AA (note trailing space in source)
  'Questions Due',                    // [27] col AB
  'Bid / No Bid?',                    // [28] col AC
  'Partner',                          // [29] col AD
  'Prime or Sub?',                    // [30] col AE
  'Priority',                         // [31] col AF — Cold / Warm / Hot
  'Notes*',                           // [32] col AG
  'Anticipated year for Award (MM/DD/YYYY)*', // [33] col AH
  'Assigned To*',                     // [34] col AI
  'Last Modified*',                   // [35] col AJ
  'Link to Slide Deck',               // [36] col AK
  'Link to Folder',                   // [37] col AL
  'Identification PWIN',              // [38] col AM
  'Qualification PWIN',               // [39] col AN
  'RFI Notified',                     // [40] col AO — date notification was sent, blank = not yet sent
  'Notice Type',                      // RFI / MRAS / RFP / RFQ
  'Outcome',                          // Won / Lost / Withdrawn / Cancelled
  'Opportunity ID',                   // immutable internal identity used for safe updates
  'Archived',                         // Yes when removed from the active CRM
  'Archived At',
  'Archived By',
  'Archive Reason',
  'Flagged',                          // shared team flag
]

const PIPELINE_LIFECYCLE_COLUMNS = [
  'Opportunity ID', 'Outcome', 'Archived', 'Archived At', 'Archived By', 'Archive Reason', 'Flagged',
]
let pipelineSchemaPromise = null

async function ensurePipelineSchema() {
  if (!pipelineSchemaPromise) {
    pipelineSchemaPromise = (async () => {
      const schema = await ensureTableColumns('PipelineTable', PIPELINE_LIFECYCLE_COLUMNS)
      const rows = await getSheetRows('PipelineTable')
      if (!rows.some((row) => !String(row['Opportunity ID'] || '').trim())) return schema

      const values = rows.map((row) => [
        String(row['Opportunity ID'] || '').trim() || createStableId('O'),
      ])
      await graphFetch(`/tables/PipelineTable/columns/${encodeURIComponent('Opportunity ID')}/dataBodyRange`, {
        method: 'PATCH',
        body: JSON.stringify({ values }),
      })
      invalidate('PipelineTable')
      return schema
    })().catch((error) => {
      pipelineSchemaPromise = null
      throw error
    })
  }
  return pipelineSchemaPromise
}

export const TASKS_HEADERS = [
  'TaskID', 'ContractNumber', 'ContractTitle', 'OpportunityNotes',
  'Title', 'Description', 'AssignedTo', 'DueDate', 'Priority',
  'Status', 'CreatedBy', 'CreatedDate', 'UpdatedDate',
]
const TASK_LIFECYCLE_COLUMNS = ['ContractTitle']
let tasksSchemaPromise = null

async function ensureTasksSchema() {
  if (!tasksSchemaPromise) {
    tasksSchemaPromise = ensureTableColumns('TasksTable', TASK_LIFECYCLE_COLUMNS).catch((error) => {
      tasksSchemaPromise = null
      throw error
    })
  }
  return tasksSchemaPromise
}

export const CONTACTS_HEADERS = [
  'ContactID', 'Name', 'Title', 'Agency', 'Organization', 'Offices', 'Email', 'Phone', 'Notes', 'Type',
]

export const CONTACT_INTERACTION_HEADERS = [
  'InteractionID', 'ContactID', 'Interaction Date', 'Interaction Type', 'Notes', 'Follow-up Date', 'Logged By',
]

// Keep this schema aligned with the PartnersTable headers in the workbook.
// UEI Number is the unique partner identifier. Partner Name is display data.
export const PARTNER_HEADERS = [
  'Partner Name',
  'UEI Number',
  'Contact Information',
  'NAICS Codes',
  'Company Strengths',
  'Capabilities',
  'Agencies Worked with',
  'Contracts Vehicles',
  'Keywords',
  'Link to website',
  'Link to Partner Folder',
  'Notes',
]

export const LEGACY_PARTNER_FOLDER_HEADER = 'Link to onedrive folder'

export const NOTES_HEADERS = [
  'NoteID', 'ContractNumber', 'Date', 'Author', 'NoteText', 'Related Type', 'Related ID',
]

export const OPPORTUNITY_RELATIONSHIP_HEADERS = [
  'Relationship ID', 'Opportunity ID', 'Related Opportunity ID',
  'Relationship Type', 'Created By', 'Created At',
]
const OPPORTUNITY_RELATIONSHIPS_TABLE = 'OpportunityRelationshipsTable'
const OPPORTUNITY_RELATIONSHIPS_SHEET = 'Opportunity Relationships'
let opportunityRelationshipsSchemaPromise = null

async function ensureOpportunityRelationshipsSchema() {
  if (opportunityRelationshipsSchemaPromise) return opportunityRelationshipsSchemaPromise
  opportunityRelationshipsSchemaPromise = (async () => {
    try {
      return { headers: await getTableHeaders(OPPORTUNITY_RELATIONSHIPS_TABLE, { force: true }), created: false }
    } catch (error) {
      if (![400, 404].includes(Number(error?.status))) throw error
    }

    let worksheet
    try {
      worksheet = await graphFetch(`/worksheets/${encodeURIComponent(OPPORTUNITY_RELATIONSHIPS_SHEET)}`)
    } catch (error) {
      if (![400, 404].includes(Number(error?.status))) throw error
      try {
        worksheet = await graphFetch('/worksheets/add', {
          method: 'POST',
          body: JSON.stringify({ name: OPPORTUNITY_RELATIONSHIPS_SHEET }),
        })
      } catch (createError) {
        // Another browser can win the worksheet-creation race. Re-read it
        // before surfacing an error so first use remains safe for the team.
        worksheet = await graphFetch(`/worksheets/${encodeURIComponent(OPPORTUNITY_RELATIONSHIPS_SHEET)}`).catch(() => { throw createError })
      }
    }

    const worksheetKey = encodeURIComponent(worksheet?.id || OPPORTUNITY_RELATIONSHIPS_SHEET)
    const rangeAddress = `A1:${colIndexToLetter(OPPORTUNITY_RELATIONSHIP_HEADERS.length - 1)}2`
    await graphFetch(`/worksheets/${worksheetKey}/range(address='${rangeAddress}')`, {
      method: 'PATCH',
      body: JSON.stringify({ values: [OPPORTUNITY_RELATIONSHIP_HEADERS, OPPORTUNITY_RELATIONSHIP_HEADERS.map(() => '')] }),
    })

    let createdTable
    try {
      createdTable = await graphFetch(`/worksheets/${worksheetKey}/tables/add`, {
        method: 'POST',
        body: JSON.stringify({ address: rangeAddress, hasHeaders: true }),
      })
      await graphFetch(`/tables/${encodeURIComponent(createdTable.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: OPPORTUNITY_RELATIONSHIPS_TABLE }),
      })
      await graphFetch(`/tables/${OPPORTUNITY_RELATIONSHIPS_TABLE}/rows/0`, { method: 'DELETE' }).catch(() => {})
    } catch (error) {
      // Treat a duplicate-name/range race as success only when the canonical
      // table can now be read.
      await getTableHeaders(OPPORTUNITY_RELATIONSHIPS_TABLE, { force: true }).catch(() => { throw error })
    }
    headerCache.delete(OPPORTUNITY_RELATIONSHIPS_TABLE)
    invalidate(OPPORTUNITY_RELATIONSHIPS_TABLE)
    return { headers: await getTableHeaders(OPPORTUNITY_RELATIONSHIPS_TABLE, { force: true }), created: true }
  })().catch((error) => {
    opportunityRelationshipsSchemaPromise = null
    throw error
  })
  return opportunityRelationshipsSchemaPromise
}
let notesRelationshipSchemaPromise = null

function ensureNotesRelationshipSchema() {
  if (!notesRelationshipSchemaPromise) {
    notesRelationshipSchemaPromise = ensureTableColumns('NotesTable', ['Related Type', 'Related ID'])
      .catch((error) => {
        notesRelationshipSchemaPromise = null
        throw error
      })
  }
  return notesRelationshipSchemaPromise
}

export const EMAIL_FOLLOW_UP_TEMPLATE_HEADERS = [
  'Template ID',
  'Template Name',
  'Days After Submission',
  'Subject',
  'Body',
  'Active',
  'Created At',
  'Last Updated',
  'Updated By',
]

export const EMAIL_FOLLOW_UP_DRAFT_HEADERS = [
  'Draft ID',
  'Opportunity ID',
  'Template ID',
  'Template Name',
  'Milestone Days',
  'Due Date',
  'From',
  'To',
  'CC',
  'Subject',
  'Body',
  'Status',
  'Enrollment Date',
  'Enrollment Source',
  'Created At',
  'Updated At',
  'Updated By',
  'Teams Notified At',
  'Outlook Draft ID',
  'Outlook Web Link',
  'Sent At',
  'Sent By',
  'Last Error',
]

// ── Column name aliases — use these throughout the app ────────────────────
// Maps friendly names → exact Excel column header strings
export const COL = {
  phase:          'TAG Opportunity Phase',
  activityPhase:  'TAG Pipeline Activity Phase',
  fiscalYear:     'Fiscal Year',
  outlook:        'Opportunity Outlook',
  submissionDate: 'Submission Date (Response Date)*',
  responsePhase:  'Response Phase',
  contractNumber: 'Contract Number / Notice ID',
  title:          'Project Title / Description*',
  solicitationNum:'Solicitation Number',
  vehicleNumber:  'Contract Vehicle Number',
  vehicle:        'Contract Vehicle',
  classification: 'Contract Classification*',
  setAside:       'Set- Aside*',
  department:     'Department*',
  agency:         'Agency*',
  office:         'Office*',
  contractEndDate:'Contract End Date*',
  poc:            'Contracting Officer / Specialist (POC)*',
  naics:          'NAICS Code*',
  value:          'Total Contract Value ($)*',
  incumbent:      'Incumbent (Company Name)',
  incumbentUEI:   'Incumbent (Company UEI)',
  exitDate:       '8(a) Exit Date',
  baseYearValue:  'Base Year Value ($)*',
  govwinLink:     'GovWin Link*',
  otherLinks:     'Other Links*',
  expiringContract:'Expiring Contract Number ',
  questionsDue:   'Questions Due',
  bidNoBid:       'Bid / No Bid?',
  partner:        'Partner',
  primeOrSub:     'Prime or Sub?',
  priority:       'Priority',
  notes:          'Notes*',
  awardDate:      'Anticipated year for Award (MM/DD/YYYY)*',
  assignedTo:     'Assigned To*',
  lastModified:   'Last Modified*',
  slideDeck:      'Link to Slide Deck',
  folder:         'Link to Folder',
  idPWIN:         'Identification PWIN',
  qualPWIN:       'Qualification PWIN',
  rfiNotified:    'RFI Notified',
  noticeType:     'Notice Type',
  outcome:        'Outcome',
}

// ── Phase / enum constants from real data ─────────────────────────────────
// Matches the "TAG Opportunity Phase" column on the Data Validation sheet.
// Note: "Identified" was previously misspelled "Indentified" — fixed here.
export const OPPORTUNITY_PHASES = [
  'Identified',
  'Research',
  'Qualified',
  'Proposal',
  'Pending Award',
  'Contract Awarded',
  'Closed Lost',
  'Cancelled',
]
export const OPPORTUNITY_OUTLOOK = ['Expiring', 'Forecasted', 'New', 'Tracking']
export const ACTIVITY_PHASES = [
  'Pre-RFP', 'Submitted RFI', 'Submitted Market Research', 'Submitted RFP',
  'Submitted RFQ', 'RFP Released', 'Proposal Submitted', 'BAFO', 'Award Pending',
]
export const PRIORITY_VALUES = ['Cold', 'Warm', 'Hot']
export const SET_ASIDE_VALUES = ['-', '8A', '8AN', 'NONE', 'SBA', 'SDVOSBC', 'SDVOSBS']

// Contact type fallback — only used if the Data Validation sheet Types column
// is empty. The live list is always pulled from DataValidationTable first.
export const CONTACT_TYPES = ['Government', 'Private']

// ── Data Validation table ───────────────────────────────────────────────
// "Data Validation" sheet is set up as a Table named DataValidationTable.
// Each column header is a list name; non-empty cells below are the options.
const VALIDATION_TABLE = 'DataValidationTable'
const VALIDATION_SHEET = 'Data Validation'

/**
 * Read all Data Validation columns as { [header]: [non-empty values] }.
 * Cached like other sheet reads via the generic cache (keyed by table name).
 */
export async function getValidationLists() {
  const rows = await getSheetRows(VALIDATION_TABLE)
  const headers = await getTableHeaders(VALIDATION_TABLE)
  const lists = {}
  headers.forEach((h) => {
    lists[h] = rows
      .map((r) => r[h])
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
  })
  return lists
}

/**
 * Convert a 0-based column index to an Excel column letter (0 -> A, 25 -> Z, 26 -> AA...).
 */
function colIndexToLetter(index) {
  let letter = ''
  let n = index
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter
    n = Math.floor(n / 26) - 1
  }
  return letter
}

/**
 * Overwrite one Data Validation column's values (below the header).
 * Writes exactly `values.length` rows; any previously-longer column is
 * padded with blanks below that so removed options don't linger.
 */
export async function updateValidationColumn(header, values) {
  const headerData = await graphFetch(`/tables/${VALIDATION_TABLE}/columns`)
  const headers = headerData.value.map((c) => c.name)
  const colIndex = headers.indexOf(header)
  if (colIndex === -1) throw new Error(`Column "${header}" not found in ${VALIDATION_TABLE}`)

  // Existing row count, so we know how many trailing cells to blank out
  const existingRows = await getSheetRows(VALIDATION_TABLE)
  const totalRows = Math.max(existingRows.length, values.length)

  const colLetter = colIndexToLetter(colIndex)
  const startRow = 2 // row 1 is the header
  const endRow = startRow + totalRows - 1
  const address = `${colLetter}${startRow}:${colLetter}${endRow}`

  const cellValues = []
  for (let i = 0; i < totalRows; i++) {
    cellValues.push([i < values.length ? values[i] : ''])
  }

  await graphFetch(
    `/worksheets/${encodeURIComponent(VALIDATION_SHEET)}/range(address='${address}')`,
    {
      method: 'PATCH',
      body: JSON.stringify({ values: cellValues }),
    }
  )

  invalidate(VALIDATION_TABLE)
}

// Maps Settings page section keys -> Data Validation column headers
export const VALIDATION_KEY_MAP = {
  opportunityPhases: 'TAG Opportunity Phase',
  activityPhases:    'TAG Pipeline Activity Phase',
  outlooks:          'Opportunity Outlook',
  priorities:        'Priority',
  setAsides:         'Set-Aside',
  primeOrSub:        'Prime or Sub',
  bidNoBid:          'Bid / No Bid?',
  contactTypes:      'Types',
  assignees:         'Assignee',
}

// Fallback used only if the Data Validation sheet's "Assignee" column is
// empty or doesn't exist yet — the live list is always read from
// DataValidationTable first, same pattern as every other dropdown list.
export const ASSIGNEE_VALUES = ['Breanna', 'Ayomide', 'AO']


// ── Notification log (Key / LastSent columns on DataValidationTable) ───────
// Valid keys: 'overdue' | 'duesoon'

export async function getNotifLog() {
  try {
    const rows = await getSheetRows(VALIDATION_TABLE)
    const log = {}
    rows.forEach((r) => {
      if (r['Key']) log[String(r['Key']).trim()] = String(r['LastSent'] || '').trim()
    })
    return log          // e.g. { overdue: '2026-06-13', duesoon: '2026-06-12' }
  } catch {
    return {}           // graceful fallback if columns don't exist yet
  }
}

export async function setNotifLog(key, dateStr) {
  try {
    const headerData = await graphFetch(`/tables/${VALIDATION_TABLE}/columns`)
    const headers = headerData.value.map((c) => c.name)
    if (!headers.includes('Key') || !headers.includes('LastSent')) return false

    const rows = await getSheetRows(VALIDATION_TABLE)
    const existing = rows.find((row) => String(row['Key'] || '').trim() === key)
    if (existing) {
      await updateRow(VALIDATION_TABLE, existing._rowIndex, { Key: key, LastSent: dateStr }, headers)
    } else {
      // Reuse an empty table row if one exists. Otherwise append a row through
      // the Table API so the log remains visible to future app sessions.
      const blank = rows.find((row) => !String(row['Key'] || '').trim())
      if (blank) await updateRow(VALIDATION_TABLE, blank._rowIndex, { Key: key, LastSent: dateStr }, headers)
      else await appendRow(VALIDATION_TABLE, { Key: key, LastSent: dateStr }, headers)
    }
    invalidate(VALIDATION_TABLE)
    return true
  } catch (err) {
    console.warn('[NotifLog] Failed to write:', err.message)
    return false
  }
}

// ── POC / Contact linking helpers ─────────────────────────────────────────

const POC_COL = 'Contracting Officer / Specialist (POC)*'
const POC_SEP = ', '
const RELATED_OPPORTUNITY_PREFIX = '[TAG_RELATED_OPPORTUNITY]'

/** Add a contact name to an opportunity's POC column */
export async function addContactToPOC(rowIndex, currentPOC, contactName) {
  const names = parsePOCNames(currentPOC)
  if (names.includes(contactName)) return  // already linked
  const newValue = [...names, contactName].join(POC_SEP)
  return updateOpportunity(rowIndex, { [POC_COL]: newValue })
}

/** Remove a contact name from an opportunity's POC column */
export async function removeContactFromPOC(rowIndex, currentPOC, contactName) {
  const names = parsePOCNames(currentPOC).filter((n) => n !== contactName)
  return updateOpportunity(rowIndex, { [POC_COL]: names.join(POC_SEP) })
}

/**
 * Stores a reciprocal relationship in NotesTable. This keeps the relationship
 * durable without changing the shared PipelineTable schema, and lets either
 * opportunity render a direct link to the other one.
 */
export function parseRelatedOpportunityNote(text) {
  const value = String(text || '')
  if (!value.startsWith(RELATED_OPPORTUNITY_PREFIX)) return null
  try {
    const params = new URLSearchParams(value.slice(RELATED_OPPORTUNITY_PREFIX.length).trim())
    const contractNumber = params.get('contractNumber') || ''
    const title = params.get('title') || ''
    return contractNumber ? { contractNumber, title } : null
  } catch {
    return null
  }
}

function relatedOpportunityNote({ contractNumber, title }) {
  const params = new URLSearchParams({ contractNumber: contractNumber || '', title: title || '' })
  return `${RELATED_OPPORTUNITY_PREFIX} ${params}`
}

export async function linkRelatedOpportunities(first, second) {
  await ensureOpportunityRelationshipsSchema()
  const firstId = String(first.opportunityId || '').trim()
  const secondId = String(second.opportunityId || '').trim()
  if (!firstId || !secondId) throw new Error('Both opportunities need an Opportunity ID before they can be linked')
  if (firstId === secondId) throw new Error('An opportunity cannot be linked to itself')
  const rows = await getOpportunityRelationships()
  const exists = rows.some((row) => {
    const left = String(row['Opportunity ID'] || '').trim()
    const right = String(row['Related Opportunity ID'] || '').trim()
    return (left === firstId && right === secondId) || (left === secondId && right === firstId)
  })
  if (exists) return rows.find((row) => {
    const pair = new Set([String(row['Opportunity ID'] || '').trim(), String(row['Related Opportunity ID'] || '').trim()])
    return pair.has(firstId) && pair.has(secondId)
  })
  const record = {
    'Relationship ID': createStableId('OR'),
    'Opportunity ID': firstId,
    'Related Opportunity ID': secondId,
    'Relationship Type': String(first.relationshipType || second.relationshipType || 'Related only').trim(),
    'Created By': String(first.createdBy || second.createdBy || '').trim(),
    'Created At': new Date().toISOString().split('T')[0],
  }
  await appendRow(OPPORTUNITY_RELATIONSHIPS_TABLE, record, OPPORTUNITY_RELATIONSHIP_HEADERS)
  invalidate(OPPORTUNITY_RELATIONSHIPS_TABLE)
  return record
}

export async function getOpportunityRelationships() {
  await ensureOpportunityRelationshipsSchema()
  return getSheetRows(OPPORTUNITY_RELATIONSHIPS_TABLE)
}

export async function deleteOpportunityRelationship(rowIndex, original) {
  return deleteRow('OpportunityRelationshipsTable', rowIndex, {
    original,
    identity: String(original?.['Relationship ID'] || '').trim(),
  })
}

export async function updateOpportunityRelationshipType(rowIndex, original, relationshipType) {
  return updateRow('OpportunityRelationshipsTable', rowIndex, {
    'Relationship Type': String(relationshipType || 'Related only').trim(),
  }, original)
}

export async function migrateLegacyOpportunityRelationships(pipeline = [], createdBy = 'System migration') {
  const notes = await getNotes()
  const legacy = notes.map((note) => ({ note, related: parseRelatedOpportunityNote(note.NoteText) })).filter((item) => item.related)
  let migrated = 0
  for (const item of legacy) {
    const source = pipeline.find((opportunity) => normalizedValue(opportunity['Contract Number / Notice ID']) === normalizedValue(item.note.ContractNumber))
    const target = pipeline.find((opportunity) => normalizedValue(opportunity['Contract Number / Notice ID']) === normalizedValue(item.related.contractNumber))
    if (!source?.['Opportunity ID'] || !target?.['Opportunity ID']) continue
    await linkRelatedOpportunities(
      { opportunityId: source['Opportunity ID'], createdBy },
      { opportunityId: target['Opportunity ID'], createdBy },
    )
    await deleteNote(item.note._rowIndex, item.note)
    migrated += 1
  }
  return migrated
}

export async function getPipeline() {
  await ensurePipelineSchema()
  return getSheetRows('PipelineTable')
}

export async function getTasks() {
  await ensureTasksSchema()
  return getSheetRows('TasksTable')
}

export async function getNotes() {
  return getSheetRows('NotesTable')
}

export async function getContacts() {
  return getSheetRows('ContactsTable')
}

function normalizeTableHeader(value) {
  // Excel headers can contain non-breaking spaces, zero-width characters, or
  // line breaks that look identical in the workbook UI. Compare the semantic
  // header name so "Created At" and visually identical variants resolve to
  // the same column without weakening the required-column check.
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

export async function getPartners() {
  const rows = await getSheetRows('PartnersTable')
  // Excel table headers can carry invisible trailing spaces or different
  // capitalization after users edit a workbook. Map those harmless variants
  // back to the canonical headers that the UI uses, without changing the
  // underlying workbook or shifting any cell values.
  return rows.map((row) => {
    const normalizedKeys = new Map(Object.keys(row).map((key) => [normalizeTableHeader(key), key]))
    const canonical = Object.fromEntries(PARTNER_HEADERS.map((header) => {
      const sourceKey = normalizedKeys.get(normalizeTableHeader(header))
      if (sourceKey && row[sourceKey] !== '') return [header, row[sourceKey]]
      if (header === 'Link to Partner Folder') {
        const legacyKey = normalizedKeys.get(normalizeTableHeader(LEGACY_PARTNER_FOLDER_HEADER))
        return [header, legacyKey ? row[legacyKey] : '']
      }
      return [header, sourceKey ? row[sourceKey] : '']
    }))
    return { ...row, ...canonical }
  })
}

async function partnerSchema() {
  headerCache.delete('PartnersTable')
  const headers = await getTableHeaders('PartnersTable')
  const byNormalizedHeader = new Map(headers.map((header) => [normalizeTableHeader(header), header]))
  const missing = PARTNER_HEADERS.filter((header) => {
    if (byNormalizedHeader.has(normalizeTableHeader(header))) return false
    return header !== 'Link to Partner Folder' || !byNormalizedHeader.has(normalizeTableHeader(LEGACY_PARTNER_FOLDER_HEADER))
  })
  if (missing.length) throw new Error(`PartnersTable is missing: ${missing.join(', ')}`)
  return { headers, byNormalizedHeader }
}

function partnerValuesForWorkbook(values, schema) {
  const canonicalValues = new Map(Object.entries(values || {}).map(([key, value]) => [normalizeTableHeader(key), value]))
  return Object.fromEntries(schema.headers.map((header) => [
    header,
    canonicalValues.get(normalizeTableHeader(header)) ?? (
      normalizeTableHeader(header) === normalizeTableHeader(LEGACY_PARTNER_FOLDER_HEADER)
        ? canonicalValues.get(normalizeTableHeader('Link to Partner Folder')) ?? ''
        : ''
    ),
  ]))
}

/**
 * Bring existing workbooks forward without making the legacy partner-folder
 * column a breaking requirement. The old column is retained for compatibility;
 * its values are copied into the canonical SharePoint column once.
 */
export async function ensurePartnerWorkspaceSchema() {
  let partnerHeaders = await getTableHeaders('PartnersTable', { force: true })
  const hasCanonical = partnerHeaders.some((header) => normalizeTableHeader(header) === normalizeTableHeader('Link to Partner Folder'))
  const legacyHeader = partnerHeaders.find((header) => normalizeTableHeader(header) === normalizeTableHeader(LEGACY_PARTNER_FOLDER_HEADER))
  let renamedPartnerColumn = false
  if (!hasCanonical && legacyHeader) {
    try {
      await graphFetch(`/tables/PartnersTable/columns/${encodeURIComponent(legacyHeader)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Link to Partner Folder' }),
      })
      headerCache.delete('PartnersTable')
      invalidate('PartnersTable')
      partnerHeaders = await getTableHeaders('PartnersTable', { force: true })
      renamedPartnerColumn = true
    } catch {
      // Some workbook/Graph combinations do not permit a table-column rename.
      // The add-and-copy fallback below preserves the data and compatibility.
    }
  }
  const partnerColumns = await ensureTableColumns('PartnersTable', ['Link to Partner Folder'])
  const notesColumns = await ensureNotesRelationshipSchema()
  const rows = await getSheetRows('PartnersTable')
  const hasLegacy = partnerColumns.headers.some((header) => normalizeTableHeader(header) === normalizeTableHeader(LEGACY_PARTNER_FOLDER_HEADER))
  let migratedLinks = 0
  if (hasLegacy) {
    for (const row of rows) {
      const canonical = String(row['Link to Partner Folder'] || '').trim()
      const legacy = String(row[LEGACY_PARTNER_FOLDER_HEADER] || '').trim()
      if (canonical || !legacy) continue
      await updateRow('PartnersTable', row._rowIndex, { 'Link to Partner Folder': legacy }, partnerColumns.headers, { original: row })
      migratedLinks += 1
    }
  }
  return {
    addedPartnerColumns: partnerColumns.added,
    addedNoteColumns: notesColumns.added,
    renamedPartnerColumn,
    migratedLinks,
  }
}

export async function addPartner(data) {
  const schema = await partnerSchema()
  const record = partnerValuesForWorkbook(data, schema)
  const uei = String(record['UEI Number'] || '').trim().toUpperCase()
  if (!uei) throw new Error('UEI Number is required before creating a partner')
  return createWorkbookRecord({
    tableName: 'PartnersTable',
    operationKey: `partner:${uei}`,
    idColumn: 'UEI Number',
    idValue: uei,
    record: { ...record, 'UEI Number': uei },
    append: () => appendRow('PartnersTable', { ...record, 'UEI Number': uei }, schema.headers),
    readRows: async () => {
      invalidate('PartnersTable')
      return getPartners()
    },
    checkBeforeAppend: true,
  })
}

export async function updatePartner(rowIndex, patch, original) {
  const schema = await partnerSchema()
  return updateRow('PartnersTable', rowIndex, partnerValuesForWorkbook(patch, schema), schema.headers, { original })
}

export async function deletePartner(rowIndex, original) {
  return deleteRow('PartnersTable', rowIndex, { original })
}

const CONTACT_INTERACTIONS_TABLE = 'ContactInteractionsTable'
let contactInteractionsUnavailable = false

export async function getContactInteractions() {
  if (contactInteractionsUnavailable) return null
  try {
    return await getSheetRows(CONTACT_INTERACTIONS_TABLE)
  } catch (error) {
    const message = String(error?.message || '').toLowerCase()
    if (message.includes('404') || message.includes('not found')) {
      contactInteractionsUnavailable = true
      console.info('[Contacts] ContactInteractionsTable is not configured.')
      return null
    }
    throw error
  }
}

// Optional notification-recipient mapping. This keeps workbook assignee names
// separate from the Teams UPN or Entra object ID required for a real mention.
// Missing setup is non-fatal: notification cards still show the assignee name.
const NOTIFICATION_RECIPIENTS_TABLE = 'NotificationRecipientsTable'
export const NOTIFICATION_RECIPIENT_HEADERS = [
  'Pipeline Assignee',
  'Teams Display Name',
  'Teams UPN / Entra Object ID',
  'Mention Enabled',
]
let notificationRecipientsUnavailable = false

export async function getNotificationRecipients() {
  if (notificationRecipientsUnavailable) return []
  try {
    return await getSheetRows(NOTIFICATION_RECIPIENTS_TABLE)
  } catch (error) {
    notificationRecipientsUnavailable = true
    console.info('[Notifications] NotificationRecipientsTable is not configured; sending names without Teams mentions.')
    return []
  }
}

export async function addOpportunity(data) {
  const schema = await ensurePipelineSchema()
  const record = {
    ...data,
    'Opportunity ID': String(data?.['Opportunity ID'] || '').trim() || createStableId('O'),
    Archived: '',
    'Archived At': '',
    'Archived By': '',
    'Archive Reason': '',
    Flagged: data?.Flagged || '',
    'Last Modified*': new Date().toISOString().split('T')[0],
  }
  const identifier = String(record['Contract Number / Notice ID'] || '').trim()
  if (!identifier) throw new Error('Contract or notice ID is required before creating an opportunity')
  const headers = schema.headers
  return createWorkbookRecord({
    tableName: 'PipelineTable',
    operationKey: `opportunity:${identifier.toLowerCase()}`,
    idColumn: 'Contract Number / Notice ID',
    idValue: identifier,
    record,
    append: () => appendRow('PipelineTable', record, headers),
    readRows: async () => {
      invalidate('PipelineTable')
      return getPipeline()
    },
    checkBeforeAppend: true,
  })
}

export async function updateOpportunity(rowIndex, patch, original) {
  const schema = await ensurePipelineSchema()
  return updateRowWithReconciliation('PipelineTable', rowIndex, {
    ...patch,
    'Last Modified*': new Date().toISOString().split('T')[0],
  }, schema.headers, { original })
}

export async function deleteOpportunity(rowIndex, original) {
  return deleteRow('PipelineTable', rowIndex, { original })
}

export async function addNote(contractNumber, author, text, noteId = createStableId('N'), relationship = {}) {
  const { headers } = await ensureNotesRelationshipSchema()
  const relatedType = String(relationship.relatedType || (contractNumber ? 'Opportunity' : '')).trim()
  const relatedId = String(relationship.relatedId || contractNumber || '').trim()
  const record = {
    NoteID: noteId,
    ContractNumber: contractNumber,
    Date: new Date().toISOString().split('T')[0],
    Author: author,
    NoteText: text,
    'Related Type': relatedType,
    'Related ID': relatedId,
  }
  return createWorkbookRecord({
    tableName: 'NotesTable',
    operationKey: `note:${createFingerprint({ contractNumber, relatedType, relatedId, author, text })}`,
    idColumn: 'NoteID',
    idValue: noteId,
    record,
    append: () => appendRow('NotesTable', record, headers),
    readRows: async () => {
      invalidate('NotesTable')
      return getNotes()
    },
  })
}

export async function updateNote(rowIndex, patch, original) {
  const { headers } = await ensureNotesRelationshipSchema()
  return updateRow('NotesTable', rowIndex, patch, headers, { original })
}

export async function deleteNote(rowIndex, original) {
  return deleteRow('NotesTable', rowIndex, { original })
}

export async function addTask(data, createdBy, taskId = createStableId('T')) {
  await ensureTasksSchema()
  const record = {
    ...data,
    TaskID: taskId,
    Status: 'To Do',
    CreatedBy: createdBy,
    CreatedDate: new Date().toISOString().split('T')[0],
    UpdatedDate: new Date().toISOString().split('T')[0],
  }
  return createWorkbookRecord({
    tableName: 'TasksTable',
    operationKey: `task:${createFingerprint({ ...data, createdBy })}`,
    idColumn: 'TaskID',
    idValue: taskId,
    record,
    append: () => appendRow('TasksTable', record, TASKS_HEADERS),
    readRows: async () => {
      invalidate('TasksTable')
      return getTasks()
    },
  })
}

export async function updateTask(rowIndex, patch, original) {
  await ensureTasksSchema()
  return updateRow('TasksTable', rowIndex, {
    ...patch,
    UpdatedDate: new Date().toISOString().split('T')[0],
  }, TASKS_HEADERS, { original })
}

// ── Controlled opportunity identifier/title changes ──────────────────────
// Contract Number / Notice ID is the app's relationship key. Renaming it
// therefore needs to update only structured references, never free-text task
// descriptions or user-written notes. Excel/Graph has no transaction support,
// so dependent updates are applied first and rolled back on a later failure.
const OPPORTUNITY_ID_COL = 'Contract Number / Notice ID'
const OPPORTUNITY_TITLE_COL = 'Project Title / Description*'

function normalizedValue(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function updateWithRetry(fn) {
  return (async () => {
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await fn()
      } catch (error) {
        lastError = error
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
    throw lastError
  })()
}

function createOpportunityRenamePlan(current, nextForm, pipeline, tasks, notes, followUpOverrides = [], followUpDecisions = [], emailDrafts = []) {
  const oldId = String(current[OPPORTUNITY_ID_COL] ?? '').trim()
  const newId = String(nextForm[OPPORTUNITY_ID_COL] ?? '').trim()
  const oldTitle = String(current[OPPORTUNITY_TITLE_COL] ?? '').trim()
  const newTitle = String(nextForm[OPPORTUNITY_TITLE_COL] ?? '').trim()
  const identifierChanged = oldId !== newId
  const titleChanged = oldTitle !== newTitle

  if (!oldId) throw new Error('This opportunity has no contract or notice ID to update')
  if (!newId) throw new Error('Contract or notice ID is required')
  if (!newTitle) throw new Error('Opportunity title is required')

  const duplicate = identifierChanged && pipeline.find((opportunity) =>
    opportunity._rowIndex !== current._rowIndex &&
    normalizedValue(opportunity[OPPORTUNITY_ID_COL]) === normalizedValue(newId)
  )
  if (duplicate) {
    throw new Error(`Contract or notice ID "${newId}" is already used by another opportunity`)
  }

  const taskPatches = identifierChanged || titleChanged
    ? tasks
      .filter((task) => String(task.ContractNumber ?? '').trim() === oldId)
      .map((task) => ({
        rowIndex: task._rowIndex,
        patch: {
          ...(identifierChanged ? { ContractNumber: newId } : {}),
          ...(titleChanged ? { ContractTitle: newTitle } : {}),
        },
        rollback: {
          ...(identifierChanged ? { ContractNumber: task.ContractNumber } : {}),
          ...(titleChanged ? { ContractTitle: task.ContractTitle } : {}),
        },
      }))
    : []

  // Notes can be associated with the renamed record (ContractNumber) and can
  // also contain a system-managed reciprocal relationship that *points* to it.
  // A single row may need both updates, so merge them by row index.
  const notePatchMap = new Map()
  const relationshipRows = new Set()
  notes.forEach((note) => {
    const patch = {}
    const rollback = {}
    if (identifierChanged && String(note.ContractNumber ?? '').trim() === oldId) {
      patch.ContractNumber = newId
      rollback.ContractNumber = note.ContractNumber
      if (String(note['Related Type'] || '').trim().toLowerCase() === 'opportunity') {
        patch['Related ID'] = newId
        rollback['Related ID'] = note['Related ID']
      }
    }
    const related = parseRelatedOpportunityNote(note.NoteText)
    if (related && String(related.contractNumber ?? '').trim() === oldId && (identifierChanged || titleChanged)) {
      patch.NoteText = relatedOpportunityNote({ contractNumber: newId, title: newTitle })
      rollback.NoteText = note.NoteText
      relationshipRows.add(note._rowIndex)
    }
    if (Object.keys(patch).length > 0) {
      notePatchMap.set(note._rowIndex, { rowIndex: note._rowIndex, patch, rollback })
    }
  })

  const notePatches = [...notePatchMap.values()]
  const overridePatches = identifierChanged
    ? followUpOverrides
      .filter((row) => String(row['Opportunity ID'] ?? '').trim() === oldId)
      .map((row) => ({
        rowIndex: row._rowIndex,
        patch: { 'Opportunity ID': newId },
        rollback: { 'Opportunity ID': row['Opportunity ID'] },
      }))
    : []
  const followUpDecisionPatches = identifierChanged
    ? followUpDecisions
      .filter((row) => String(row['Opportunity ID'] ?? '').trim() === oldId)
      .map((row) => ({
        rowIndex: row._rowIndex,
        patch: { 'Opportunity ID': newId },
        rollback: { 'Opportunity ID': row['Opportunity ID'] },
      }))
    : []
  const emailDraftPatches = identifierChanged
    ? emailDrafts
      .filter((row) => String(row['Opportunity ID'] ?? '').trim() === oldId)
      .map((row) => ({
        rowIndex: row._rowIndex,
        patch: {
          'Opportunity ID': newId,
          'Draft ID': deterministicDraftId(newId, row['Template ID']),
        },
        rollback: {
          'Opportunity ID': row['Opportunity ID'],
          'Draft ID': row['Draft ID'],
        },
      }))
    : []
  return {
    oldId,
    newId,
    oldTitle,
    newTitle,
    identifierChanged,
    titleChanged,
    taskPatches,
    notePatches,
    overridePatches,
    followUpDecisionPatches,
    emailDraftPatches,
    preview: {
      identifierChanged,
      titleChanged,
      taskCount: taskPatches.length,
      noteCount: notePatches.length,
      relationshipCount: relationshipRows.size,
      followUpOverrideCount: overridePatches.length,
      followUpDecisionCount: followUpDecisionPatches.length,
      emailDraftCount: emailDraftPatches.length,
      totalLinkedRecords: taskPatches.length + notePatches.length + overridePatches.length + followUpDecisionPatches.length + emailDraftPatches.length,
    },
  }
}

/**
 * Read current workbook data and return the impact of a proposed title and/or
 * identifier change. The UI uses this before asking for confirmation.
 */
export async function previewOpportunityRename(rowIndex, nextForm) {
  // Do not base a destructive identifier check on a potentially 30-second-old
  // cache. Header metadata remains cached, while these rows are read fresh.
  invalidate('PipelineTable')
  invalidate('TasksTable')
  invalidate('NotesTable')
  invalidate('RFIFollowUpOverridesTable')
  invalidate('RFIFollowUpDecisionsTable')
  invalidate('EmailFollowUpDraftsTable')
  const [pipeline, tasks, notes, followUpOverrides, followUpDecisions, emailDrafts] = await Promise.all([
    getPipeline(), getTasks(), getNotes(), getRFIFollowUpOverrides(), getRFIFollowUpDecisions(), getEmailFollowUpDrafts(),
  ])
  const current = pipeline.find((opportunity) => opportunity._rowIndex === rowIndex)
  if (!current) throw new Error('Opportunity no longer exists in the pipeline')
  return createOpportunityRenamePlan(current, nextForm, pipeline, tasks, notes, followUpOverrides, followUpDecisions, emailDrafts || []).preview
}

/**
 * Save a renamed opportunity and cascade only structured references. If any
 * write fails, completed dependent writes are best-effort rolled back and the
 * caller receives an error that can be shown to the user.
 */
export async function renameOpportunityWithReferences(rowIndex, nextForm, onProgress = () => {}) {
  // Re-read immediately after confirmation to catch direct workbook edits that
  // happened while the confirmation dialog was open.
  invalidate('PipelineTable')
  invalidate('TasksTable')
  invalidate('NotesTable')
  invalidate('RFIFollowUpOverridesTable')
  invalidate('RFIFollowUpDecisionsTable')
  invalidate('EmailFollowUpDraftsTable')
  const [pipeline, tasks, notes, followUpOverrides, followUpDecisions, emailDrafts] = await Promise.all([
    getPipeline(), getTasks(), getNotes(), getRFIFollowUpOverrides(), getRFIFollowUpDecisions(), getEmailFollowUpDrafts(),
  ])
  const current = pipeline.find((opportunity) => opportunity._rowIndex === rowIndex)
  if (!current) throw new Error('Opportunity no longer exists in the pipeline')
  const plan = createOpportunityRenamePlan(current, nextForm, pipeline, tasks, notes, followUpOverrides, followUpDecisions, emailDrafts || [])

  const operations = [
    ...plan.taskPatches.map((item) => ({
      label: 'linked task',
      apply: () => updateWithRetry(() => updateTask(item.rowIndex, item.patch)),
      rollback: () => updateWithRetry(() => updateTask(item.rowIndex, item.rollback)),
    })),
    ...plan.notePatches.map((item) => ({
      label: 'linked note',
      apply: () => updateWithRetry(() => updateNote(item.rowIndex, item.patch)),
      rollback: () => updateWithRetry(() => updateNote(item.rowIndex, item.rollback)),
    })),
    ...plan.overridePatches.map((item) => ({
      label: 'RFI follow-on override',
      apply: () => updateWithRetry(() => updateRow('RFIFollowUpOverridesTable', item.rowIndex, item.patch, RFI_FOLLOW_UP_OVERRIDE_HEADERS)),
      rollback: () => updateWithRetry(() => updateRow('RFIFollowUpOverridesTable', item.rowIndex, item.rollback, RFI_FOLLOW_UP_OVERRIDE_HEADERS)),
    })),
    ...plan.followUpDecisionPatches.map((item) => ({
      label: 'RFI follow-on decision',
      apply: () => updateWithRetry(() => updateRow('RFIFollowUpDecisionsTable', item.rowIndex, item.patch, RFI_FOLLOW_UP_DECISION_HEADERS)),
      rollback: () => updateWithRetry(() => updateRow('RFIFollowUpDecisionsTable', item.rowIndex, item.rollback, RFI_FOLLOW_UP_DECISION_HEADERS)),
    })),
    ...plan.emailDraftPatches.map((item) => ({
      label: 'follow-up email draft',
      apply: () => updateWithRetry(() => updateEmailFollowUpDraft(item.rowIndex, item.patch, 'Opportunity rename')),
      rollback: () => updateWithRetry(() => updateEmailFollowUpDraft(item.rowIndex, item.rollback, 'Opportunity rename rollback')),
    })),
    {
      label: 'opportunity',
      apply: () => updateWithRetry(() => updateOpportunity(rowIndex, nextForm)),
      // The opportunity is always last, so there is no later operation that
      // would require rolling it back after a successful save.
      rollback: null,
    },
  ]

  const completed = []
  try {
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]
      onProgress({ completed: index, total: operations.length, label: operation.label })
      await operation.apply()
      completed.push(operation)
    }
    onProgress({ completed: operations.length, total: operations.length, label: 'complete' })
    return plan.preview
  } catch (error) {
    const rollbackFailures = []
    for (const operation of completed.reverse()) {
      if (!operation.rollback) continue
      try {
        await operation.rollback()
      } catch {
        rollbackFailures.push(operation.label)
      }
    }
    const recovery = rollbackFailures.length
      ? ` Some linked ${[...new Set(rollbackFailures)].join(' and ')} changes could not be rolled back; refresh the page and review them before trying again.`
      : ' Linked record changes were rolled back.'
    throw new Error(`Could not save the renamed opportunity: ${error.message}.${recovery}`)
  }
}

export async function deleteTask(rowIndex, original) {
  return deleteRow('TasksTable', rowIndex, { original })
}

export async function addContact(data, contactId = createStableId('C')) {
  // ContactsTable can gain the optional Offices column while the app is open.
  // Refresh only this schema before a write so column order stays correct.
  headerCache.delete('ContactsTable')
  const headers = await getTableHeaders('ContactsTable')
  if (String(data.Offices || '').trim() && !headers.includes('Offices')) {
    throw new Error('Add an "Offices" column to ContactsTable before saving office assignments')
  }
  const record = { ...data, ContactID: contactId }
  return createWorkbookRecord({
    tableName: 'ContactsTable',
    operationKey: `contact:${createFingerprint({
      email: data.Email,
      name: data.Name,
      organization: data.Agency || data.Organization,
    })}`,
    idColumn: 'ContactID',
    idValue: contactId,
    record,
    append: () => appendRow('ContactsTable', record, headers),
    readRows: async () => {
      invalidate('ContactsTable')
      return getContacts()
    },
  })
}

export async function addContactInteraction(data, interactionId = createStableId('CI')) {
  const contactId = String(data.ContactID || '').trim()
  if (!contactId) throw new Error('Contact ID is required')
  // This table is often created by hand. Read its live schema before writing
  // so a harmless column reordering cannot make a log entry fail silently.
  headerCache.delete(CONTACT_INTERACTIONS_TABLE)
  const headers = await getTableHeaders(CONTACT_INTERACTIONS_TABLE)
  const missing = CONTACT_INTERACTION_HEADERS.filter((header) => !headers.includes(header))
  if (missing.length) {
    throw new Error(`ContactInteractionsTable is missing: ${missing.join(', ')}`)
  }
  const interaction = { ...data, InteractionID: interactionId }
  return createWorkbookRecord({
    tableName: CONTACT_INTERACTIONS_TABLE,
    operationKey: `interaction:${createFingerprint(data)}`,
    idColumn: 'InteractionID',
    idValue: interactionId,
    record: interaction,
    append: () => appendRow(CONTACT_INTERACTIONS_TABLE, interaction, headers),
    readRows: async () => {
      invalidate(CONTACT_INTERACTIONS_TABLE)
      return (await getContactInteractions()) || []
    },
  })
}

export async function updateContact(rowIndex, patch, original) {
  headerCache.delete('ContactsTable')
  const headers = await getTableHeaders('ContactsTable')
  if (String(patch.Offices || '').trim() && !headers.includes('Offices')) {
    throw new Error('Add an "Offices" column to ContactsTable before saving office assignments')
  }
  return updateRow('ContactsTable', rowIndex, patch, headers, { original })
}

export async function deleteContact(rowIndex, original) {
  return deleteRow('ContactsTable', rowIndex, { original })
}

/**
 * Get concatenated notes for a contract number (used when creating tasks).
 * n.Date is already an ISO string after getSheetRows normalisation.
 */
export async function getNotesForContract(contractNumber) {
  const notes = await getNotes()
  return notes
    .filter((n) => n.ContractNumber === contractNumber)
    .sort((a, b) => new Date(a.Date + 'T00:00:00') - new Date(b.Date + 'T00:00:00'))
    .map((n) => {
      // Guard: if Date somehow came through as a serial, convert it
      const dateStr = typeof n.Date === 'number' ? excelDateToISO(n.Date) : (n.Date || '')
      return `[${dateStr} - ${n.Author}] ${n.NoteText}`
    })
    .join('\n')
}
// ── NewOpportunities table ────────────────────────────────────────────────

export const NEW_OPP_HEADERS = [
  'Notice ID',
  'Solicitation Number',
  'Title',
  'Set-Aside Type',
  'Department',
  'Agency',
  'Office',
  'Response Date',
  'Point of Contact',
  'NAICS Code',
  'Posted Date',
  'SAM.gov URL',
  'Date Added',
  'Status',
  'Notice Type',
  'Flagged',
]

export async function getSAMOpportunities() {
  return getSheetRows('NewOpportunitiesTable')
}

export async function addSAMOpportunity(data) {
  const headers = await getTableHeaders('NewOpportunitiesTable')
  const idColumn = String(data['Notice ID'] || '').trim() ? 'Notice ID' : 'Solicitation Number'
  const idValue = String(data[idColumn] || '').trim()
  return createWorkbookRecord({
    tableName: 'NewOpportunitiesTable',
    operationKey: `sam-opportunity:${idValue.toLowerCase()}`,
    idColumn,
    idValue,
    record: data,
    append: () => appendRow('NewOpportunitiesTable', data, headers),
    readRows: async () => {
      invalidate('NewOpportunitiesTable')
      return getSAMOpportunities()
    },
    checkBeforeAppend: true,
  })
}

export async function updateSAMOpportunity(rowIndex, patch, original) {
  const headers = await getTableHeaders('NewOpportunitiesTable')
  return updateRow('NewOpportunitiesTable', rowIndex, patch, headers, { original })
}

export async function updateSAMOpportunityFlag(rowIndex, flagged, original) {
  const { headers } = await ensureTableColumns('NewOpportunitiesTable', ['Flagged'])
  const normalizedOriginal = original
    ? { ...original, Flagged: original.Flagged ?? '' }
    : original
  return updateRow(
    'NewOpportunitiesTable',
    rowIndex,
    { Flagged: flagged ? 'Yes' : '' },
    headers,
    { original: normalizedOriginal },
  )
}

export async function deleteSAMOpportunity(rowIndex, original) {
  return deleteRow('NewOpportunitiesTable', rowIndex, { original })
}

// ── SAMConfig tables ──────────────────────────────────────────────────────

export const SAM_NAICS_HEADERS = ['NAICS Code']

export const SAM_SETTINGS_HEADERS = ['Setting', 'Value']

export const RFI_FOLLOW_UP_OVERRIDE_HEADERS = [
  'Opportunity ID', 'Monitoring Enabled', 'Use Global Criteria',
  'Department Rule', 'Department Override',
  'Agency Rule', 'Agency Override',
  'POC Rule', 'POC Email Override',
  'Title Overlap %', 'Notice Types',
  'Submission Window Days', 'No-Submission Lookback Days',
  'No-Submission Lookahead Days', 'Updated At',
]

export const RFI_FOLLOW_UP_DECISION_HEADERS = [
  'Opportunity ID', 'Follow-up Notice ID', 'Follow-up Solicitation Number',
  'Decision', 'Decided At', 'Candidate Title',
]

const RFI_FOLLOW_UP_SETTING_DEFAULTS = {
  monitoringEnabled: true,
  departmentRule: 'Exact',
  agencyRule: 'Exact',
  pocRule: 'Exact',
  titleOverlapPercent: 40,
  noticeTypes: 'RFP, RFQ',
  submissionWindowDays: 364,
  noSubmissionLookbackDays: 150,
  noSubmissionLookaheadDays: 150,
}

function settingBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  return ['true', 'yes', 'enabled', '1'].includes(String(value).trim().toLowerCase())
}

function settingNumber(value, fallback, min = 0, max = 364) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

function rfiFollowUpSettingsFromRows(rows) {
  const values = {}
  rows.forEach((row) => {
    const key = String(row.Setting || '').trim()
    if (key) values[key] = row.Value
  })
  return {
    monitoringEnabled: settingBoolean(values['RFI Follow-up Monitoring'], RFI_FOLLOW_UP_SETTING_DEFAULTS.monitoringEnabled),
    departmentRule: ['Exact', 'Ignore'].includes(String(values['RFI Follow-up Department Rule'] || '')) ? String(values['RFI Follow-up Department Rule']) : RFI_FOLLOW_UP_SETTING_DEFAULTS.departmentRule,
    agencyRule: ['Exact', 'Ignore'].includes(String(values['RFI Follow-up Agency Rule'] || '')) ? String(values['RFI Follow-up Agency Rule']) : RFI_FOLLOW_UP_SETTING_DEFAULTS.agencyRule,
    pocRule: ['Exact', 'Ignore'].includes(String(values['RFI Follow-up POC Rule'] || '')) ? String(values['RFI Follow-up POC Rule']) : RFI_FOLLOW_UP_SETTING_DEFAULTS.pocRule,
    titleOverlapPercent: settingNumber(values['RFI Follow-up Title Overlap %'], RFI_FOLLOW_UP_SETTING_DEFAULTS.titleOverlapPercent, 1, 100),
    noticeTypes: 'RFP, RFQ',
    submissionWindowDays: settingNumber(values['RFI Follow-up Submission Window Days'], RFI_FOLLOW_UP_SETTING_DEFAULTS.submissionWindowDays, 1, 364),
    noSubmissionLookbackDays: settingNumber(values['RFI Follow-up No-Submission Lookback Days'], RFI_FOLLOW_UP_SETTING_DEFAULTS.noSubmissionLookbackDays, 0, 364),
    noSubmissionLookaheadDays: settingNumber(values['RFI Follow-up No-Submission Lookahead Days'], RFI_FOLLOW_UP_SETTING_DEFAULTS.noSubmissionLookaheadDays, 0, 364),
  }
}

export async function getSAMNAICS() {
  const rows = await getSheetRows('SAMNAICSTable')
  return rows.map((r) => String(r['NAICS Code'] || '').trim()).filter(Boolean)
}

export async function updateSAMNAICS(codes) {
  // Read current row count so we can blank out any removed rows
  const existing = await getSheetRows('SAMNAICSTable')
  const totalRows = Math.max(existing.length, codes.length)
  // Write via range PATCH on the worksheet so we can zero-fill removed rows
  const headerData = await graphFetch('/tables/SAMNAICSTable/columns')
  const headers = headerData.value.map((c) => c.name)
  const colIdx = headers.indexOf('NAICS Code')
  const colLetter = colIndexToLetter(colIdx)
  const startRow = 2
  const endRow = startRow + totalRows - 1
  const address = `${colLetter}${startRow}:${colLetter}${endRow}`
  const cellValues = []
  for (let i = 0; i < totalRows; i++) {
    cellValues.push([i < codes.length ? codes[i] : ''])
  }
  await graphFetch(
    `/worksheets/${encodeURIComponent('SAMConfig')}/range(address='${address}')`,
    { method: 'PATCH', body: JSON.stringify({ values: cellValues }) }
  )
  invalidate('SAMNAICSTable')
}

export async function getSAMSettings() {
  const rows = await getSheetRows('SAMSettingsTable')
  const settings = {}
  rows.forEach((r) => {
    const key = String(r['Setting'] || '').trim()
    const val = r['Value']
    if (key) settings[key] = val
  })
  return {
    skipDays:   Number(settings['Skip Days']   ?? 3),
    windowDays: Number(settings['Window Days'] ?? 90),
    rfiFollowUp: rfiFollowUpSettingsFromRows(rows),
  }
}

export async function updateSAMSettings(skipDays, windowDays, rfiFollowUp = null) {
  const rows = await getSheetRows('SAMSettingsTable')
  const values = {
    'Skip Days': skipDays,
    'Window Days': windowDays,
    ...(rfiFollowUp ? {
      'RFI Follow-up Monitoring': rfiFollowUp.monitoringEnabled ? 'Enabled' : 'Disabled',
      'RFI Follow-up Department Rule': rfiFollowUp.departmentRule,
      'RFI Follow-up Agency Rule': rfiFollowUp.agencyRule,
      'RFI Follow-up POC Rule': rfiFollowUp.pocRule,
      'RFI Follow-up Title Overlap %': rfiFollowUp.titleOverlapPercent,
      'RFI Follow-up Notice Types': 'RFP, RFQ',
      'RFI Follow-up Submission Window Days': rfiFollowUp.submissionWindowDays,
      'RFI Follow-up No-Submission Lookback Days': rfiFollowUp.noSubmissionLookbackDays,
      'RFI Follow-up No-Submission Lookahead Days': rfiFollowUp.noSubmissionLookaheadDays,
    } : {}),
  }
  for (const [setting, value] of Object.entries(values)) {
    const row = rows.find((item) => String(item.Setting || '').trim() === setting)
    if (row) await updateRow('SAMSettingsTable', row._rowIndex, { Setting: setting, Value: value }, SAM_SETTINGS_HEADERS)
    else await appendRow('SAMSettingsTable', { Setting: setting, Value: value }, SAM_SETTINGS_HEADERS)
  }
}

export async function getRFIFollowUpOverrides() {
  try { return await getSheetRows('RFIFollowUpOverridesTable') } catch (error) {
    if (/not found|does not exist|itemNotFound|Graph API error: 404/i.test(error.message)) return []
    throw error
  }
}

export async function saveRFIFollowUpOverride(opportunityId, values) {
  const rows = await getRFIFollowUpOverrides()
  const existing = rows.find((row) => normalizedValue(row['Opportunity ID']) === normalizedValue(opportunityId))
  const payload = {
    ...values,
    'Opportunity ID': opportunityId,
    'Updated At': new Date().toISOString(),
  }
  if (existing) return updateRow('RFIFollowUpOverridesTable', existing._rowIndex, payload, RFI_FOLLOW_UP_OVERRIDE_HEADERS)
  return appendRow('RFIFollowUpOverridesTable', payload, RFI_FOLLOW_UP_OVERRIDE_HEADERS)
}

export async function getRFIFollowUpDecisions() {
  try { return await getSheetRows('RFIFollowUpDecisionsTable') } catch (error) {
    if (/not found|does not exist|itemNotFound|Graph API error: 404/i.test(error.message)) return []
    throw error
  }
}

export async function saveRFIFollowUpDecision(values) {
  const rows = await getRFIFollowUpDecisions()
  const sameDecision = rows.find((row) =>
    normalizedValue(row['Opportunity ID']) === normalizedValue(values['Opportunity ID']) &&
    normalizedValue(row['Follow-up Notice ID']) === normalizedValue(values['Follow-up Notice ID']) &&
    normalizedValue(row['Follow-up Solicitation Number']) === normalizedValue(values['Follow-up Solicitation Number'])
  )
  const payload = { ...values, 'Decided At': new Date().toISOString() }
  if (sameDecision) return updateRow('RFIFollowUpDecisionsTable', sameDecision._rowIndex, payload, RFI_FOLLOW_UP_DECISION_HEADERS)
  return appendRow('RFIFollowUpDecisionsTable', payload, RFI_FOLLOW_UP_DECISION_HEADERS)
}

function isMissingWorkbookTable(error) {
  return /not found|does not exist|itemNotFound|Graph API error: 404/i.test(String(error?.message || ''))
}

async function emailTableSchema(tableName, requiredHeaders, { force = false } = {}) {
  const headers = await getTableHeaders(tableName, { force })
  const byNormalizedHeader = new Map(headers.map((header) => [normalizeTableHeader(header), header]))
  const missing = requiredHeaders.filter((header) => !byNormalizedHeader.has(normalizeTableHeader(header)))
  if (missing.length) {
    const detected = headers.length ? headers.map((header) => `"${header}"`).join(', ') : 'none'
    throw new Error(
      `${tableName} is missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. ` +
      `Microsoft Graph currently reports these table columns: ${detected}. ` +
      'If the header is visible in Excel, confirm that the column is inside the named table range.',
    )
  }
  return { headers, byNormalizedHeader }
}

function canonicalEmailRows(rows, requiredHeaders) {
  return rows.map((row) => {
    const byNormalizedHeader = new Map(Object.keys(row).map((header) => [normalizeTableHeader(header), header]))
    const canonical = Object.fromEntries(requiredHeaders.map((header) => {
      const source = byNormalizedHeader.get(normalizeTableHeader(header))
      return [header, source ? row[source] : '']
    }))
    return { ...row, ...canonical }
  })
}

function emailRecordForWorkbook(values, schema) {
  const byNormalizedValue = new Map(
    Object.entries(values || {}).map(([header, value]) => [normalizeTableHeader(header), value])
  )
  return Object.fromEntries(schema.headers.map((header) => [
    header,
    byNormalizedValue.get(normalizeTableHeader(header)) ?? '',
  ]))
}

function emailPatchForWorkbook(patch, schema) {
  return Object.fromEntries(Object.entries(patch || {}).map(([header, value]) => {
    const workbookHeader = schema.byNormalizedHeader.get(normalizeTableHeader(header))
    return [workbookHeader || header, value]
  }))
}

export async function getEmailFollowUpTemplates({ force = false } = {}) {
  try {
    await emailTableSchema(
      'EmailFollowUpTemplatesTable',
      EMAIL_FOLLOW_UP_TEMPLATE_HEADERS,
      { force },
    )
    if (force) invalidate('EmailFollowUpTemplatesTable')
    const rows = await getSheetRows('EmailFollowUpTemplatesTable')
    return canonicalEmailRows(rows, EMAIL_FOLLOW_UP_TEMPLATE_HEADERS)
  } catch (error) {
    if (isMissingWorkbookTable(error)) return null
    throw error
  }
}

export async function addEmailFollowUpTemplate(values, updatedBy, templateId = createStableId('FUT')) {
  const schema = await emailTableSchema(
    'EmailFollowUpTemplatesTable',
    EMAIL_FOLLOW_UP_TEMPLATE_HEADERS,
    { force: false },
  )
  const now = new Date().toISOString()
  const record = {
    ...values,
    'Template ID': templateId,
    'Created At': values['Created At'] || now,
    'Last Updated': now,
    'Updated By': updatedBy || '',
  }
  return createWorkbookRecord({
    tableName: 'EmailFollowUpTemplatesTable',
    operationKey: `follow-up-template:${templateId}`,
    idColumn: 'Template ID',
    idValue: templateId,
    record,
    append: () => appendRow(
      'EmailFollowUpTemplatesTable',
      emailRecordForWorkbook(record, schema),
      schema.headers,
    ),
    readRows: async () => {
      invalidate('EmailFollowUpTemplatesTable')
      return (await getEmailFollowUpTemplates({ force: true })) || []
    },
  })
}

export async function updateEmailFollowUpTemplate(rowIndex, patch, updatedBy, templateId = '') {
  const schema = await emailTableSchema(
    'EmailFollowUpTemplatesTable',
    EMAIL_FOLLOW_UP_TEMPLATE_HEADERS,
    { force: false },
  )
  let targetRowIndex = rowIndex
  const stableId = String(templateId || patch?.['Template ID'] || '').trim().toLowerCase()
  if (stableId) {
    const rows = await getEmailFollowUpTemplates({ force: true })
    const current = rows?.find((row) => String(row?.['Template ID'] || '').trim().toLowerCase() === stableId)
    if (!current) throw new Error('This template could not be found in the workbook. Refresh the template list and try again.')
    targetRowIndex = current._rowIndex
  }
  const nextPatch = {
    ...patch,
    'Last Updated': new Date().toISOString(),
    'Updated By': updatedBy || '',
  }
  return updateRow(
    'EmailFollowUpTemplatesTable',
    targetRowIndex,
    emailPatchForWorkbook(nextPatch, schema),
    schema.headers,
  )
}

export async function deleteEmailFollowUpTemplate(rowIndex) {
  return deleteRow('EmailFollowUpTemplatesTable', rowIndex)
}

export async function getEmailFollowUpDrafts({ force = false } = {}) {
  try {
    await emailTableSchema(
      'EmailFollowUpDraftsTable',
      EMAIL_FOLLOW_UP_DRAFT_HEADERS,
      { force },
    )
    if (force) invalidate('EmailFollowUpDraftsTable')
    const rows = await getSheetRows('EmailFollowUpDraftsTable')
    return canonicalEmailRows(rows, EMAIL_FOLLOW_UP_DRAFT_HEADERS)
  } catch (error) {
    if (isMissingWorkbookTable(error)) return null
    throw error
  }
}

export async function addEmailFollowUpDraft(record) {
  const draftId = String(record?.['Draft ID'] || '').trim()
  if (!draftId) throw new Error('Draft ID is required')
  const schema = await emailTableSchema(
    'EmailFollowUpDraftsTable',
    EMAIL_FOLLOW_UP_DRAFT_HEADERS,
    { force: false },
  )
  return createWorkbookRecord({
    tableName: 'EmailFollowUpDraftsTable',
    operationKey: `follow-up-draft:${draftId}`,
    idColumn: 'Draft ID',
    idValue: draftId,
    record,
    append: () => appendRow(
      'EmailFollowUpDraftsTable',
      emailRecordForWorkbook(record, schema),
      schema.headers,
    ),
    readRows: async () => {
      invalidate('EmailFollowUpDraftsTable')
      return (await getEmailFollowUpDrafts({ force: true })) || []
    },
    checkBeforeAppend: true,
  })
}

export async function updateEmailFollowUpDraft(rowIndex, patch, updatedBy) {
  const schema = await emailTableSchema(
    'EmailFollowUpDraftsTable',
    EMAIL_FOLLOW_UP_DRAFT_HEADERS,
    { force: false },
  )
  const nextPatch = {
    ...patch,
    'Updated At': new Date().toISOString(),
    'Updated By': updatedBy || '',
  }
  return updateRow(
    'EmailFollowUpDraftsTable',
    rowIndex,
    emailPatchForWorkbook(nextPatch, schema),
    schema.headers,
  )
}
