import { msalInstance, loginRequest } from '@/auth/msalConfig'

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

function invalidate(sheet) {
  cache.delete(sheet)
}

/** Clear the entire cache — called by dataCache before a full re-fetch. */
export function invalidateAll() {
  cache.clear()
  _resolvedBase = null  // also re-resolve drive path in case file moved
}

// ── Token helper ───────────────────────────────────────────────────────────
export async function getToken() {
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
  const base = await resolveWorkbookBase()
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
  'ContactID', 'Name', 'Title', 'Agency', 'Organization', 'Email', 'Phone', 'Notes', 'Type',
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
  const headerData = await graphFetch(`/tables/${VALIDATION_TABLE}/columns`)
  const headers = headerData.value.map((c) => c.name)
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
    const keyColIdx     = headers.indexOf('Key')
    const lastSentColIdx = headers.indexOf('LastSent')
    if (keyColIdx === -1 || lastSentColIdx === -1) return  // columns not set up yet

    const rows = await getSheetRows(VALIDATION_TABLE)
    const rowIdx = rows.findIndex((r) => String(r['Key'] || '').trim() === key)
    if (rowIdx === -1) {
      // Key row doesn't exist yet — find first blank Key cell and write there
      const blankIdx = rows.findIndex((r) => !r['Key'] || String(r['Key']).trim() === '')
      const targetRow = (blankIdx !== -1 ? blankIdx : rows.length) + 2  // +2: 1-based + header
      const keyLetter      = colIndexToLetter(keyColIdx)
      const lastSentLetter = colIndexToLetter(lastSentColIdx)
      await graphFetch(
        `/worksheets/${encodeURIComponent(VALIDATION_SHEET)}/range(address='${keyLetter}${targetRow}:${lastSentLetter}${targetRow}')`,
        { method: 'PATCH', body: JSON.stringify({ values: [[key, dateStr]] }) }
      )
    } else {
      // Update the existing LastSent cell for this key
      const targetRow = rowIdx + 2
      const lastSentLetter = colIndexToLetter(lastSentColIdx)
      await graphFetch(
        `/worksheets/${encodeURIComponent(VALIDATION_SHEET)}/range(address='${lastSentLetter}${targetRow}')`,
        { method: 'PATCH', body: JSON.stringify({ values: [[dateStr]] }) }
      )
    }
    invalidate(VALIDATION_TABLE)
  } catch (err) {
    console.warn('[NotifLog] Failed to write:', err.message)
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

export async function deleteNote(rowIndex) {
  return deleteRow('NotesTable', rowIndex)
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
]

export async function getSAMOpportunities() {
  return getSheetRows('NewOpportunitiesTable')
}

export async function addSAMOpportunity(data) {
  return appendRow('NewOpportunitiesTable', data, NEW_OPP_HEADERS)
}

export async function updateSAMOpportunity(rowIndex, patch) {
  return updateRow('NewOpportunitiesTable', rowIndex, patch, NEW_OPP_HEADERS)
}

export async function deleteSAMOpportunity(rowIndex) {
  return deleteRow('NewOpportunitiesTable', rowIndex)
}

// ── SAMConfig tables ──────────────────────────────────────────────────────

export const SAM_NAICS_HEADERS = ['NAICS Code']

export const SAM_SETTINGS_HEADERS = ['Setting', 'Value']

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
  }
}

export async function updateSAMSettings(skipDays, windowDays) {
  const rows = await getSheetRows('SAMSettingsTable')
  const skipRow   = rows.find((r) => String(r['Setting'] || '').trim() === 'Skip Days')
  const windowRow = rows.find((r) => String(r['Setting'] || '').trim() === 'Window Days')
  if (skipRow)   await updateRow('SAMSettingsTable', skipRow._rowIndex,   { Setting: 'Skip Days',   Value: skipDays },   SAM_SETTINGS_HEADERS)
  if (windowRow) await updateRow('SAMSettingsTable', windowRow._rowIndex, { Setting: 'Window Days', Value: windowDays }, SAM_SETTINGS_HEADERS)
}
