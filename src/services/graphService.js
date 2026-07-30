import { InteractionRequiredAuthError } from '@azure/msal-browser'
import { msalInstance, loginRequest } from '@/auth/msalConfig'
import { externallyChangedPatchedFields, recordIdentity } from '@/utils/recordConflict'
import {
  appendWithReconciliation,
  createFingerprint,
  createStableId,
} from '@/services/workbookMutations'

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
  const previousRows = cache.get(tableName)
  const saved = await appendWithReconciliation({ idColumn, idValue, ...options })
  const baseRows = cache.get(tableName) || previousRows
  if (baseRows) {
    const identity = String(idValue || '').trim().toLowerCase()
    const withoutDuplicate = baseRows.filter((row) =>
      String(row?.[idColumn] || '').trim().toLowerCase() !== identity
    )
    cache.set(tableName, [...withoutDuplicate, saved])
  }
  return saved
}

async function getTableHeaders(tableName, { force = false } = {}) {
  if (!force && headerCache.has(tableName)) return headerCache.get(tableName)
  const headerData = await graphFetch(`/tables/${tableName}/columns`)
  const headers = headerData.value.map((column) => column.name)
  headerCache.set(tableName, headers)
  return headers
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
    const response = await msalInstance.acquireTokenSilent({
      ...loginRequest,
      account,
    })
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
    throw new Error(err?.error?.message || fallback)
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
])

/**
 * Convert an Excel date serial → 'YYYY-MM-DD'.
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
  // Use UTC components to avoid timezone shifting the date
  const yyyy = d.getUTCFullYear()
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd   = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
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
export async function updateRow(tableName, rowIndex, patch, headers) {
  // Never rebuild an Excel row from a stale browser cache. A direct workbook
  // edit can happen while this app is open; read the current row immediately
  // before writing so unrelated changes are retained.
  const cached = cache.get(tableName)?.find((row) => row._rowIndex === rowIndex) || null
  let targetRowIndex = rowIndex
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
  const identity = recordIdentity(tableName, cached)
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

/**
 * Delete a row from a named table by row index.
 */
export async function deleteRow(tableName, rowIndex) {
  await graphFetch(`/tables/${tableName}/rows/itemAt(index=${rowIndex})`, {
    method: 'DELETE',
  })
  const cachedRows = cache.get(tableName)
  if (cachedRows) {
    cache.set(tableName, cachedRows.filter((row) => row._rowIndex !== rowIndex))
  }
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
]

export const TASKS_HEADERS = [
  'TaskID', 'ContractNumber', 'ContractTitle', 'OpportunityNotes',
  'Title', 'Description', 'AssignedTo', 'DueDate', 'Priority',
  'Status', 'CreatedBy', 'CreatedDate', 'UpdatedDate',
]

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
  'Link to onedrive folder',
  'Notes',
]

export const NOTES_HEADERS = [
  'NoteID', 'ContractNumber', 'Date', 'Author', 'NoteText',
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
  'Cancelled',
]
export const OPPORTUNITY_OUTLOOK = ['Expiring', 'Forecasted', 'New', 'Tracking']
export const ACTIVITY_PHASES = ['Pre-RFP', 'Submitted RFI', 'RFP Released', 'Proposal Submitted', 'BAFO', 'Award Pending']
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

/** Parse POC column into array of trimmed names */
export function parsePOCNames(pocValue) {
  if (!pocValue) return []
  return String(pocValue).split(',').map((s) => s.trim()).filter(Boolean)
}

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
  await Promise.all([
    addNote(first.contractNumber, 'System', relatedOpportunityNote(second)),
    addNote(second.contractNumber, 'System', relatedOpportunityNote(first)),
  ])
}

export async function getPipeline() {
  return getSheetRows('PipelineTable')
}

export async function getTasks() {
  return getSheetRows('TasksTable')
}

export async function getNotes() {
  return getSheetRows('NotesTable')
}

export async function getContacts() {
  return getSheetRows('ContactsTable')
}

function normalizeTableHeader(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()
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
      return [header, sourceKey ? row[sourceKey] : '']
    }))
    return { ...row, ...canonical }
  })
}

async function partnerSchema() {
  headerCache.delete('PartnersTable')
  const headers = await getTableHeaders('PartnersTable')
  const byNormalizedHeader = new Map(headers.map((header) => [normalizeTableHeader(header), header]))
  const missing = PARTNER_HEADERS.filter((header) => !byNormalizedHeader.has(normalizeTableHeader(header)))
  if (missing.length) throw new Error(`PartnersTable is missing: ${missing.join(', ')}`)
  return { headers, byNormalizedHeader }
}

function partnerValuesForWorkbook(values, schema) {
  const canonicalValues = new Map(Object.entries(values || {}).map(([key, value]) => [normalizeTableHeader(key), value]))
  return Object.fromEntries(schema.headers.map((header) => [
    header,
    canonicalValues.get(normalizeTableHeader(header)) ?? '',
  ]))
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

export async function updatePartner(rowIndex, patch) {
  const schema = await partnerSchema()
  return updateRow('PartnersTable', rowIndex, partnerValuesForWorkbook(patch, schema), schema.headers)
}

export async function deletePartner(rowIndex) {
  return deleteRow('PartnersTable', rowIndex)
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
  const record = {
    ...data,
    'Last Modified*': new Date().toISOString().split('T')[0],
  }
  const identifier = String(record['Contract Number / Notice ID'] || '').trim()
  if (!identifier) throw new Error('Contract Number / Notice ID is required before creating an opportunity')
  return createWorkbookRecord({
    tableName: 'PipelineTable',
    operationKey: `opportunity:${identifier.toLowerCase()}`,
    idColumn: 'Contract Number / Notice ID',
    idValue: identifier,
    record,
    append: () => appendRow('PipelineTable', record, PIPELINE_HEADERS),
    readRows: async () => {
      invalidate('PipelineTable')
      return getPipeline()
    },
    checkBeforeAppend: true,
  })
}

export async function updateOpportunity(rowIndex, patch) {
  return updateRow('PipelineTable', rowIndex, {
    ...patch,
    'Last Modified*': new Date().toISOString().split('T')[0],
  }, PIPELINE_HEADERS)
}

export async function deleteOpportunity(rowIndex) {
  return deleteRow('PipelineTable', rowIndex)
}

export async function addNote(contractNumber, author, text, noteId = createStableId('N')) {
  const record = {
    NoteID: noteId,
    ContractNumber: contractNumber,
    Date: new Date().toISOString().split('T')[0],
    Author: author,
    NoteText: text,
  }
  return createWorkbookRecord({
    tableName: 'NotesTable',
    operationKey: `note:${createFingerprint({ contractNumber, author, text })}`,
    idColumn: 'NoteID',
    idValue: noteId,
    record,
    append: () => appendRow('NotesTable', record, NOTES_HEADERS),
    readRows: async () => {
      invalidate('NotesTable')
      return getNotes()
    },
  })
}

export async function updateNote(rowIndex, patch) {
  return updateRow('NotesTable', rowIndex, patch, NOTES_HEADERS)
}

export async function deleteNote(rowIndex) {
  return deleteRow('NotesTable', rowIndex)
}

export async function addTask(data, createdBy, taskId = createStableId('T')) {
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

export async function updateTask(rowIndex, patch) {
  return updateRow('TasksTable', rowIndex, {
    ...patch,
    UpdatedDate: new Date().toISOString().split('T')[0],
  }, TASKS_HEADERS)
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

function createOpportunityRenamePlan(current, nextForm, pipeline, tasks, notes, followUpOverrides = [], followUpDecisions = []) {
  const oldId = String(current[OPPORTUNITY_ID_COL] ?? '').trim()
  const newId = String(nextForm[OPPORTUNITY_ID_COL] ?? '').trim()
  const oldTitle = String(current[OPPORTUNITY_TITLE_COL] ?? '').trim()
  const newTitle = String(nextForm[OPPORTUNITY_TITLE_COL] ?? '').trim()
  const identifierChanged = oldId !== newId
  const titleChanged = oldTitle !== newTitle

  if (!oldId) throw new Error('This opportunity has no Contract Number / Notice ID to update')
  if (!newId) throw new Error('Contract Number / Notice ID is required')
  if (!newTitle) throw new Error('Opportunity title is required')

  const duplicate = identifierChanged && pipeline.find((opportunity) =>
    opportunity._rowIndex !== current._rowIndex &&
    normalizedValue(opportunity[OPPORTUNITY_ID_COL]) === normalizedValue(newId)
  )
  if (duplicate) {
    throw new Error(`Contract Number / Notice ID "${newId}" is already used by another opportunity`)
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
    preview: {
      identifierChanged,
      titleChanged,
      taskCount: taskPatches.length,
      noteCount: notePatches.length,
      relationshipCount: relationshipRows.size,
      followUpOverrideCount: overridePatches.length,
      followUpDecisionCount: followUpDecisionPatches.length,
      totalLinkedRecords: taskPatches.length + notePatches.length + overridePatches.length + followUpDecisionPatches.length,
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
  const [pipeline, tasks, notes, followUpOverrides, followUpDecisions] = await Promise.all([
    getPipeline(), getTasks(), getNotes(), getRFIFollowUpOverrides(), getRFIFollowUpDecisions(),
  ])
  const current = pipeline.find((opportunity) => opportunity._rowIndex === rowIndex)
  if (!current) throw new Error('Opportunity no longer exists in the pipeline')
  return createOpportunityRenamePlan(current, nextForm, pipeline, tasks, notes, followUpOverrides, followUpDecisions).preview
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
  const [pipeline, tasks, notes, followUpOverrides, followUpDecisions] = await Promise.all([
    getPipeline(), getTasks(), getNotes(), getRFIFollowUpOverrides(), getRFIFollowUpDecisions(),
  ])
  const current = pipeline.find((opportunity) => opportunity._rowIndex === rowIndex)
  if (!current) throw new Error('Opportunity no longer exists in the pipeline')
  const plan = createOpportunityRenamePlan(current, nextForm, pipeline, tasks, notes, followUpOverrides, followUpDecisions)

  const operations = [
    ...plan.taskPatches.map((item) => ({
      label: 'linked task',
      apply: () => updateWithRetry(() => updateTask(item.rowIndex, item.patch)),
      rollback: () => updateWithRetry(() => updateTask(item.rowIndex, item.rollback)),
    })),
    ...plan.notePatches.map((item) => ({
      label: 'linked note',
      apply: () => updateWithRetry(() => updateRow('NotesTable', item.rowIndex, item.patch, NOTES_HEADERS)),
      rollback: () => updateWithRetry(() => updateRow('NotesTable', item.rowIndex, item.rollback, NOTES_HEADERS)),
    })),
    ...plan.overridePatches.map((item) => ({
      label: 'RFI follow-up override',
      apply: () => updateWithRetry(() => updateRow('RFIFollowUpOverridesTable', item.rowIndex, item.patch, RFI_FOLLOW_UP_OVERRIDE_HEADERS)),
      rollback: () => updateWithRetry(() => updateRow('RFIFollowUpOverridesTable', item.rowIndex, item.rollback, RFI_FOLLOW_UP_OVERRIDE_HEADERS)),
    })),
    ...plan.followUpDecisionPatches.map((item) => ({
      label: 'RFI follow-up decision',
      apply: () => updateWithRetry(() => updateRow('RFIFollowUpDecisionsTable', item.rowIndex, item.patch, RFI_FOLLOW_UP_DECISION_HEADERS)),
      rollback: () => updateWithRetry(() => updateRow('RFIFollowUpDecisionsTable', item.rowIndex, item.rollback, RFI_FOLLOW_UP_DECISION_HEADERS)),
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

export async function deleteTask(rowIndex) {
  return deleteRow('TasksTable', rowIndex)
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

export async function updateContact(rowIndex, patch) {
  headerCache.delete('ContactsTable')
  const headers = await getTableHeaders('ContactsTable')
  if (String(patch.Offices || '').trim() && !headers.includes('Offices')) {
    throw new Error('Add an "Offices" column to ContactsTable before saving office assignments')
  }
  return updateRow('ContactsTable', rowIndex, patch, headers)
}

export async function deleteContact(rowIndex) {
  return deleteRow('ContactsTable', rowIndex)
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

export async function updateSAMOpportunity(rowIndex, patch) {
  const headers = await getTableHeaders('NewOpportunitiesTable')
  return updateRow('NewOpportunitiesTable', rowIndex, patch, headers)
}

export async function deleteSAMOpportunity(rowIndex) {
  return deleteRow('NewOpportunitiesTable', rowIndex)
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
    noticeTypes: String(values['RFI Follow-up Notice Types'] || RFI_FOLLOW_UP_SETTING_DEFAULTS.noticeTypes),
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
      'RFI Follow-up Notice Types': rfiFollowUp.noticeTypes,
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
