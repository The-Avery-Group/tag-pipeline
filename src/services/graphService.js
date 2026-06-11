import { msalInstance, loginRequest } from '@/auth/msalConfig'

const SHARING_URL = import.meta.env.VITE_ONEDRIVE_FILE_ID

// Encode the OneDrive sharing URL into the Graph shares format.
// VITE_ONEDRIVE_FILE_ID should now be set to the full sharing URL, e.g.:
//   https://theaverygroupllc1-my.sharepoint.com/:x:/g/personal/...
// If it is still a raw file ID (no "http"), the old me/drive path is used
// as a fallback so nothing breaks for users with a working file ID.
function buildSharingTokenBase(sharingUrl) {
  const encoded = btoa(sharingUrl)
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `https://graph.microsoft.com/v1.0/shares/u!${encoded}/driveItem`
}

// Resolved once per session: { driveId, itemId }
let _resolvedBase = null

async function resolveWorkbookBase(token) {
  if (_resolvedBase) return _resolvedBase

  const isUrl = SHARING_URL && SHARING_URL.startsWith('http')

  if (isUrl) {
    const driveItemUrl = buildSharingTokenBase(SHARING_URL)
    const res = await fetch(driveItemUrl, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message || `Could not resolve sharing URL: ${res.status}`)
    }
    const item = await res.json()
    _resolvedBase = `https://graph.microsoft.com/v1.0/drives/${item.parentReference.driveId}/items/${item.id}/workbook`
  } else {
    // Legacy: VITE_ONEDRIVE_FILE_ID is a raw file ID
    _resolvedBase = `https://graph.microsoft.com/v1.0/me/drive/items/${SHARING_URL}/workbook`
  }

  return _resolvedBase
}

// ── In-memory cache ────────────────────────────────────────────────────────
const cache = new Map()

function invalidate(sheet) {
  cache.delete(sheet)
}

/** Clear the entire cache — called by dataCache before a full re-fetch. */
export function invalidateAll() {
  cache.clear()
  _resolvedBase = null  // also re-resolve drive path in case file moved
}

// ── Token helper ───────────────────────────────────────────────────────────
async function getToken() {
  const account = msalInstance.getAllAccounts()[0]
  if (!account) throw new Error('No authenticated account')
  const response = await msalInstance.acquireTokenSilent({
    ...loginRequest,
    account,
  })
  return response.accessToken
}

async function graphFetch(path, options = {}) {
  const token = await getToken()
  const base = await resolveWorkbookBase(token)
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `Graph API error: ${res.status}`)
  }
  // 204 No Content
  if (res.status === 204) return null
  return res.json()
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
  const data = await graphFetch(`/tables/${tableName}/rows`)
  const headerData = await graphFetch(`/tables/${tableName}/columns`)
  const headers = headerData.value.map((c) => c.name)
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
  await graphFetch(`/tables/${tableName}/rows/add`, {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  })
  invalidate(tableName)
}

/**
 * Update a row in a named table by row index.
 * patch: object with only the fields to update.
 */
export async function updateRow(tableName, rowIndex, patch, headers) {
  const existing = (await getSheetRows(tableName)).find(
    (r) => r._rowIndex === rowIndex
  )
  if (!existing) throw new Error(`Row ${rowIndex} not found in ${tableName}`)
  const merged = { ...existing, ...patch }
  const row = headers.map((h) => {
    const val = merged[h] ?? ''
    return DATE_COLUMNS.has(h) ? isoToExcelSerial(val) : val
  })
  await graphFetch(`/tables/${tableName}/rows/itemAt(index=${rowIndex})`, {
    method: 'PATCH',
    body: JSON.stringify({ values: [row] }),
  })
  invalidate(tableName)
}

/**
 * Delete a row from a named table by row index.
 */
export async function deleteRow(tableName, rowIndex) {
  await graphFetch(`/tables/${tableName}/rows/itemAt(index=${rowIndex})`, {
    method: 'DELETE',
  })
  invalidate(tableName)
}

// ── Column header constants ────────────────────────────────────────────────
// These match the exact column headers in the real Pipeline sheet (40 columns)
export const PIPELINE_HEADERS = [
  'TAG Opportunity Phase',            // [0]  col A — Research / Indentified / Contract Awarded
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
]

export const TASKS_HEADERS = [
  'TaskID', 'ContractNumber', 'ContractTitle', 'OpportunityNotes',
  'Title', 'Description', 'AssignedTo', 'DueDate', 'Priority',
  'Status', 'CreatedBy', 'CreatedDate', 'UpdatedDate',
]

export const CONTACTS_HEADERS = [
  'ContactID', 'Name', 'Title', 'Agency', 'Organization', 'Email', 'Phone', 'Notes',
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
}

// ── Phase / enum constants from real data ─────────────────────────────────
export const OPPORTUNITY_PHASES = ['Research', 'Indentified', 'Contract Awarded']
export const OPPORTUNITY_OUTLOOK = ['Expiring', 'Forecasted', 'New']
export const PRIORITY_VALUES = ['Cold', 'Warm', 'Hot']
export const SET_ASIDE_VALUES = ['-', '8A', '8AN', 'NONE', 'SBA', 'SDVOSBC', 'SDVOSBS']

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

export async function addOpportunity(data) {
  return appendRow('PipelineTable', {
    ...data,
    'Last Modified*': new Date().toISOString().split('T')[0],
  }, PIPELINE_HEADERS)
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

export async function addNote(contractNumber, author, text) {
  const id = `N-${Date.now()}`
  return appendRow('NotesTable', {
    NoteID: id,
    ContractNumber: contractNumber,
    Date: new Date().toISOString().split('T')[0],
    Author: author,
    NoteText: text,
  }, NOTES_HEADERS)
}

export async function addTask(data, createdBy) {
  const id = `T-${Date.now()}`
  return appendRow('TasksTable', {
    ...data,
    TaskID: id,
    Status: 'To Do',
    CreatedBy: createdBy,
    CreatedDate: new Date().toISOString().split('T')[0],
    UpdatedDate: new Date().toISOString().split('T')[0],
  }, TASKS_HEADERS)
}

export async function updateTask(rowIndex, patch) {
  return updateRow('TasksTable', rowIndex, {
    ...patch,
    UpdatedDate: new Date().toISOString().split('T')[0],
  }, TASKS_HEADERS)
}

export async function deleteTask(rowIndex) {
  return deleteRow('TasksTable', rowIndex)
}

export async function addContact(data) {
  const id = `C-${Date.now()}`
  return appendRow('ContactsTable', { ...data, ContactID: id }, CONTACTS_HEADERS)
}

export async function updateContact(rowIndex, patch) {
  return updateRow('ContactsTable', rowIndex, patch, CONTACTS_HEADERS)
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