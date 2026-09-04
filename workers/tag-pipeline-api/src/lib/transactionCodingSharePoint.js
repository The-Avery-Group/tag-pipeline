const DEFAULT_DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'
const WORKSPACE_NAME = 'Transaction Coding'
const WORKBOOK_NAME = 'Transaction Coding.xlsx'
const EXPORTS_NAME = 'Exports'
const RULE_TABLE_NAME = 'TransactionMappingsTable'
const SETTINGS_TABLE_NAME = 'TransactionCodingSettingsTable'

export const RULE_HEADERS = [
  'Rule ID', 'Active', 'Priority', 'Match Type', 'Match Pattern', 'Vendor', 'Vendor ID',
  'Project', 'Account', 'Organization', 'Context', 'Notes', 'Last Updated', 'Updated By',
]

async function graphJson(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.error?.message || `SharePoint request failed (${response.status})`)
    error.status = response.status
    error.code = body?.error?.code || ''
    error.retryAfter = response.headers.get('Retry-After')
    throw error
  }
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

export async function ensureTransactionCodingWorkspace(env, delegatedToken = '') {
  const driveId = env.TRANSACTION_CODING_DRIVE_ID || env.DRIVE_ID || env.OPPORTUNITY_WORKSPACE_DRIVE_ID || DEFAULT_DRIVE_ID
  const token = String(delegatedToken || '').trim()
  if (!token) {
    const error = new Error('Your signed-in Microsoft session is required for Transaction Coding files')
    error.status = 401
    error.code = 'delegated_token_required'
    throw error
  }
  const workbook = await graphJson(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${env.WORKBOOK_ID}?$select=id,name,parentReference`, token)
  const parentId = workbook?.parentReference?.id
  if (!parentId) throw new Error('Could not determine the CRM workbook SharePoint location')
  const folder = await ensureFolder(driveId, parentId, WORKSPACE_NAME, token)
  const exportsFolder = await ensureFolder(driveId, folder.id, EXPORTS_NAME, token)
  const codingWorkbook = await childByName(driveId, folder.id, WORKBOOK_NAME, token)
  if (!codingWorkbook) {
    throw new Error('Transaction Coding.xlsx was not found in the Transaction Coding folder. Create the workbook and its required Excel tables before using Transaction Coding.')
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
  const { retryNotFound = true, ...requestOptions } = options
  const retryableStatuses = new Set([404, 409, 423, 429, 500, 502, 503, 504])
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await graphJson(`https://graph.microsoft.com/v1.0/drives/${workspace.driveId}/items/${workspace.workbookItemId}/workbook${path}`, workspace.token, {
        ...requestOptions,
        headers: { 'Content-Type': 'application/json', ...(requestOptions.headers || {}) },
      })
    } catch (error) {
      if (attempt === 2 || !retryableStatuses.has(error.status) || (error.status === 404 && !retryNotFound)) throw error
      const retryAfterMs = Math.min(2000, Math.max(250, Number(error.retryAfter || 0) * 1000 || (attempt + 1) * 350))
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs))
    }
  }
  throw new Error('SharePoint workbook request did not complete')
}

function workbookTablePath(tableKey, suffix = '') {
  return `/tables/${encodeURIComponent(tableKey)}${suffix}`
}

async function resolveTransactionRuleTable(workspace) {
  try {
    const table = await workbookJson(workspace, workbookTablePath(RULE_TABLE_NAME), { retryNotFound: false })
    return table?.id || table?.name || RULE_TABLE_NAME
  } catch (error) {
    if (error.status === 404) {
      throw new Error('TransactionMappingsTable was not found in Transaction Coding.xlsx. Create the Rules table with the required columns before using Transaction Coding.')
    }
    throw error
  }
}

async function readTransactionRuleTable(workspace) {
  const tableKey = await resolveTransactionRuleTable(workspace)
  const [columns, rows] = await Promise.all([
    workbookJson(workspace, workbookTablePath(tableKey, '/columns')),
    workbookJson(workspace, workbookTablePath(tableKey, '/rows?$top=1000')),
  ])
  const headers = (columns?.value || []).map((column) => column.name)
  const missingHeaders = RULE_HEADERS.filter((header) => !headers.includes(header))
  if (missingHeaders.length) {
    throw new Error(`TransactionMappingsTable is missing required columns: ${missingHeaders.join(', ')}`)
  }
  return {
    tableKey,
    headers,
    rows: (rows?.value || []).map((row) => ({
      _rowIndex: row.index,
      ...Object.fromEntries(headers.map((header, index) => [header, row.values?.[0]?.[index] ?? ''])),
    })),
  }
}

export async function readTransactionRules(workspace) {
  return (await readTransactionRuleTable(workspace)).rows
}

export async function readTransactionCodingSettings(workspace) {
  let tableKey
  try {
    const table = await workbookJson(workspace, workbookTablePath(SETTINGS_TABLE_NAME), { retryNotFound: false })
    tableKey = table?.id || table?.name || SETTINGS_TABLE_NAME
  } catch (error) {
    if (error.status === 404) {
      throw new Error('TransactionCodingSettingsTable was not found in Transaction Coding.xlsx.')
    }
    throw error
  }
  const [columns, rows] = await Promise.all([
    workbookJson(workspace, workbookTablePath(tableKey, '/columns')),
    workbookJson(workspace, workbookTablePath(tableKey, '/rows?$top=100')),
  ])
  const headers = (columns?.value || []).map((column) => column.name)
  const settingIndex = headers.findIndex((header) => String(header).trim().toLowerCase() === 'setting')
  const valueIndex = headers.findIndex((header) => String(header).trim().toLowerCase() === 'value')
  if (settingIndex < 0 || valueIndex < 0) {
    throw new Error('TransactionCodingSettingsTable must contain Setting and Value columns.')
  }
  const values = Object.fromEntries((rows?.value || []).map((row) => {
    const cells = row.values?.[0] || []
    return [String(cells[settingIndex] || '').trim().toLowerCase(), cells[valueIndex]]
  }).filter(([setting]) => setting))
  return { retentionDays: values['retention days'] }
}

export function alignTransactionRuleValues(headers, values) {
  const valuesByHeader = Object.fromEntries(RULE_HEADERS.map((header, index) => [header, values[index] ?? '']))
  return headers.map((header) => valuesByHeader[header] ?? '')
}

export async function saveTransactionRuleToWorkbook(workspace, values) {
  const { tableKey, headers, rows } = await readTransactionRuleTable(workspace)
  const compatibleValues = alignTransactionRuleValues(headers, values)
  const existing = rows.find((row) => String(row['Rule ID'] || '').trim() === String(values[0] || '').trim())
  if (existing) {
    await workbookJson(workspace, workbookTablePath(tableKey, `/rows/itemAt(index=${existing._rowIndex})/range`), {
      method: 'PATCH', body: JSON.stringify({ values: [compatibleValues] }),
    })
  } else {
    await workbookJson(workspace, workbookTablePath(tableKey, '/rows/add'), {
      method: 'POST', body: JSON.stringify({ index: null, values: [compatibleValues] }),
    })
  }
}

export async function deleteTransactionRuleFromWorkbook(workspace, ruleId) {
  const { tableKey, rows } = await readTransactionRuleTable(workspace)
  const existing = rows.find((row) => String(row['Rule ID'] || '').trim() === String(ruleId || '').trim())
  if (!existing) return false
  await workbookJson(workspace, workbookTablePath(tableKey, `/rows/itemAt(index=${existing._rowIndex})`), {
    method: 'DELETE',
  })
  return true
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
