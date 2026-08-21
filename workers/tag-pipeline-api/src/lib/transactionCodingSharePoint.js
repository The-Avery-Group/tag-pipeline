import { strToU8, zipSync } from 'fflate'
import { getAppOnlyGraphToken } from './graph.js'

const DEFAULT_DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'
const WORKSPACE_NAME = 'Transaction Coding'
const WORKBOOK_NAME = 'Transaction Coding.xlsx'
const EXPORTS_NAME = 'Exports'

export const RULE_HEADERS = [
  'Rule ID', 'Active', 'Priority', 'Match Type', 'Match Pattern', 'Merchant', 'Vendor', 'Vendor ID',
  'Project', 'Account', 'Organization', 'Context', 'Notes', 'Last Updated', 'Updated By',
]

const EXPORT_HEADERS = [
  'Export ID', 'Batch ID', 'File Name', 'Rows', 'Total Amount', 'SharePoint Link',
  'Created By', 'Created At', 'Expires At',
]

const SETTINGS_HEADERS = ['Setting', 'Value', 'Description']

function xml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function columnName(index) {
  let value = index + 1
  let result = ''
  while (value) {
    value--
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

function sheetXml(rows, tableRelId) {
  const body = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
    const ref = `${columnName(columnIndex)}${rowIndex + 1}`
    if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`
  }).join('')}</row>`).join('')
  const maxColumn = columnName(Math.max(0, rows[0].length - 1))
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${maxColumn}${rows.length}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>${body}</sheetData>
  <autoFilter ref="A1:${maxColumn}${rows.length}"/>
  <tableParts count="1"><tablePart r:id="${tableRelId}"/></tableParts>
</worksheet>`
}

function tableXml(id, name, headers, rowCount) {
  const lastColumn = columnName(headers.length - 1)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${id}" name="${name}" displayName="${name}" ref="A1:${lastColumn}${rowCount}" totalsRowShown="0">
  <autoFilter ref="A1:${lastColumn}${rowCount}"/>
  <tableColumns count="${headers.length}">${headers.map((header, index) => `<tableColumn id="${index + 1}" name="${xml(header)}"/>`).join('')}</tableColumns>
  <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>`
}

export function buildTransactionCodingWorkbook() {
  const sheets = [
    { name: 'Rules', table: 'TransactionMappingsTable', headers: RULE_HEADERS, rows: [RULE_HEADERS, ['', 'Yes', 100, 'contains', '', '', '', '', '', '', '', '', '', '', '']] },
    { name: 'Exports', table: 'TransactionCodingExportsTable', headers: EXPORT_HEADERS, rows: [EXPORT_HEADERS, ['', '', '', 0, 0, '', '', '', '']] },
    { name: 'Settings', table: 'TransactionCodingSettingsTable', headers: SETTINGS_HEADERS, rows: [SETTINGS_HEADERS, ['Retention Days', 60, 'Transaction rows and in-app export history are retained for 60 days'], ['Archive Exports', 'Yes', 'Save generated CSV files to SharePoint by default']] },
  ]
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/tables/table${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Aptos"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
  }
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheetXml(sheet.rows, 'rId1'))
    files[`xl/worksheets/_rels/sheet${index + 1}.xml.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${index + 1}.xml"/></Relationships>`)
    files[`xl/tables/table${index + 1}.xml`] = strToU8(tableXml(index + 1, sheet.table, sheet.headers, sheet.rows.length))
  })
  return zipSync(files, { level: 6 })
}

async function graphJson(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message || `SharePoint request failed (${response.status})`)
  return body
}

async function childByName(driveId, parentId, name, token) {
  const response = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${token}` } })
  if (response.status === 404) return null
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message || `Could not inspect ${name} (${response.status})`)
  return body
}

async function ensureFolder(driveId, parentId, name, token) {
  const existing = await childByName(driveId, parentId, name, token)
  if (existing) return existing
  return graphJson(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}/children`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  })
}

export async function ensureTransactionCodingWorkspace(env) {
  const driveId = env.TRANSACTION_CODING_DRIVE_ID || env.DRIVE_ID || env.OPPORTUNITY_WORKSPACE_DRIVE_ID || DEFAULT_DRIVE_ID
  const token = await getAppOnlyGraphToken(env)
  const workbook = await graphJson(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${env.WORKBOOK_ID}?$select=id,name,parentReference`, token)
  const parentId = workbook?.parentReference?.id
  if (!parentId) throw new Error('Could not determine the CRM workbook SharePoint location')
  const folder = await ensureFolder(driveId, parentId, WORKSPACE_NAME, token)
  const exportsFolder = await ensureFolder(driveId, folder.id, EXPORTS_NAME, token)
  let codingWorkbook = await childByName(driveId, folder.id, WORKBOOK_NAME, token)
  if (!codingWorkbook) {
    const response = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folder.id}:/${encodeURIComponent(WORKBOOK_NAME)}:/content`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      body: buildTransactionCodingWorkbook(),
    })
    codingWorkbook = await response.json().catch(() => null)
    if (!response.ok) throw new Error(codingWorkbook?.error?.message || `Could not create the Transaction Coding workbook (${response.status})`)
  }
  return {
    driveId,
    folderId: folder.id,
    folderUrl: folder.webUrl,
    workbookItemId: codingWorkbook.id,
    workbookUrl: codingWorkbook.webUrl,
    exportsFolderId: exportsFolder.id,
    token,
  }
}

async function workbookJson(workspace, path, options = {}) {
  return graphJson(`https://graph.microsoft.com/v1.0/drives/${workspace.driveId}/items/${workspace.workbookItemId}/workbook${path}`, workspace.token, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
}

export async function readTransactionRules(workspace) {
  const [columns, rows] = await Promise.all([
    workbookJson(workspace, '/tables/TransactionMappingsTable/columns'),
    workbookJson(workspace, '/tables/TransactionMappingsTable/rows?$top=1000'),
  ])
  const headers = (columns?.value || []).map((column) => column.name)
  return (rows?.value || []).map((row) => ({
    _rowIndex: row.index,
    ...Object.fromEntries(headers.map((header, index) => [header, row.values?.[0]?.[index] ?? ''])),
  }))
}

export async function saveTransactionRuleToWorkbook(workspace, values) {
  const rows = await readTransactionRules(workspace)
  const existing = rows.find((row) => String(row['Rule ID'] || '').trim() === String(values[0] || '').trim())
  if (existing) {
    await workbookJson(workspace, `/tables/TransactionMappingsTable/rows/itemAt(index=${existing._rowIndex})/range`, {
      method: 'PATCH', body: JSON.stringify({ values: [values] }),
    })
  } else {
    await workbookJson(workspace, '/tables/TransactionMappingsTable/rows/add', {
      method: 'POST', body: JSON.stringify({ index: null, values: [values] }),
    })
  }
}

export async function saveExportToSharePoint(workspace, fileName, csvText) {
  const response = await fetch(`https://graph.microsoft.com/v1.0/drives/${workspace.driveId}/items/${workspace.exportsFolderId}:/${encodeURIComponent(fileName)}:/content`, {
    method: 'PUT', headers: { Authorization: `Bearer ${workspace.token}`, 'Content-Type': 'text/csv; charset=utf-8' }, body: csvText,
  })
  const item = await response.json().catch(() => null)
  if (!response.ok) throw new Error(item?.error?.message || `Could not save ${fileName} to SharePoint (${response.status})`)
  return item
}

export async function appendTransactionExportHistory(workspace, values) {
  await workbookJson(workspace, '/tables/TransactionCodingExportsTable/rows/add', {
    method: 'POST', body: JSON.stringify({ index: null, values: [values] }),
  })
}
