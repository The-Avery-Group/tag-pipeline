/** Shared Microsoft Graph helpers for Worker jobs. */
import { recordIdentity, externallyChangedPatchedFields } from '../../../../src/utils/recordConflict.js'
let cachedAppToken = { value: '', expiresAt: 0 }

export async function getAppOnlyGraphToken(env) {
  if (!env.MS_TENANT_ID || !env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) {
    throw new Error('Microsoft Graph app credentials are not configured')
  }
  if (cachedAppToken.value && cachedAppToken.expiresAt > Date.now() + 60_000) {
    return cachedAppToken.value
  }
  const response = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }),
  })
  if (!response.ok) throw new Error(`Could not obtain app-only Graph token (${response.status})`)
  const payload = await response.json()
  if (!payload.access_token) throw new Error('Microsoft Graph returned no app-only access token')
  cachedAppToken = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(60, Number(payload.expires_in || 3600) - 60) * 1000,
  }
  return cachedAppToken.value
}

export function workbookBase(env, driveId) {
  return `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${env.WORKBOOK_ID}/workbook`
}

export async function graphWorkbookFetch(env, driveId, token, path, options = {}) {
  const response = await fetch(`${workbookBase(env, driveId)}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  if (response.status === 204) return null
  const raw = await response.text()
  let body = null
  if (raw) {
    try { body = JSON.parse(raw) } catch {
      throw new Error(response.ok ? 'Microsoft Graph returned invalid JSON' : `Microsoft Graph error ${response.status}: ${raw.slice(0, 160)}`)
    }
  }
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Microsoft Graph error ${response.status}`)
    error.status = response.status
    throw error
  }
  return body
}

export async function readWorkbookTable(env, driveId, token, tableName, { pageSize = 250 } = {}) {
  const [columns, firstPage] = await Promise.all([
    graphWorkbookFetch(env, driveId, token, `/tables/${tableName}/columns`),
    graphWorkbookFetch(env, driveId, token, `/tables/${tableName}/rows?$top=${pageSize}`),
  ])
  const headers = (columns.value || []).map((column) => column.name)
  const rows = [...(firstPage.value || [])]
  let pageSizeRead = firstPage.value?.length || 0
  for (let skip = rows.length; pageSizeRead === pageSize; skip += pageSize) {
    const page = await graphWorkbookFetch(env, driveId, token, `/tables/${tableName}/rows?$top=${pageSize}&$skip=${skip}`)
    const values = page.value || []
    rows.push(...values)
    pageSizeRead = values.length
  }
  return rows.map((row) => ({
    _rowIndex: row.index,
    _values: [...(row.values?.[0] || [])],
    ...Object.fromEntries(headers.map((header, index) => [header, row.values?.[0]?.[index] ?? ''])),
  }))
}

// Background jobs carry record identity across awaits, never an authoritative
// row number. Re-read the hint and relocate only when the record has moved.
export async function mutateWorkbookRecord(env, driveId, token, tableName, original, patch, { headers, remove = false, guard } = {}) {
  const identity = recordIdentity(tableName, original)
  if (!identity) throw new Error(`A stable record ID is required for ${tableName}`)
  if (!headers) headers = (await graphWorkbookFetch(env, driveId, token, `/tables/${tableName}/columns`)).value.map(column => column.name)
  let current = null
  if (Number.isInteger(original._rowIndex) && original._rowIndex >= 0) {
    try {
      const response = await graphWorkbookFetch(env, driveId, token, `/tables/${tableName}/rows/itemAt(index=${original._rowIndex})`)
      const values = response?.values?.[0]
      if (values?.length === headers.length) current = { _rowIndex: original._rowIndex, ...Object.fromEntries(headers.map((header, i) => [header, values[i]])) }
    } catch (error) { if (error.status !== 404) throw error }
  }
  if (!current || recordIdentity(tableName, current) !== identity) {
    const rows = await readWorkbookTable(env, driveId, token, tableName)
    const matches = rows.filter(row => recordIdentity(tableName, row) === identity)
    if (matches.length > 1) throw new Error(`Duplicate record ID in ${tableName}`)
    current = matches[0]
    if (!current && remove) return { alreadyDeleted: true }
    if (!current) throw new Error(`Record no longer exists in ${tableName}`)
  }
  if (guard && !guard(current)) throw new Error('Record changed since this operation was requested. No changes made.')
  if (remove) {
    await graphWorkbookFetch(env, driveId, token, `/tables/${tableName}/rows/$/itemAt(index=${current._rowIndex})`, { method: 'DELETE' })
    return { deleted: true }
  }
  const conflicts = externallyChangedPatchedFields(original, current, patch)
  if (conflicts.length) throw new Error(`Workbook record changed (${conflicts.join(', ')}). Retry with current information.`)
  if (Object.entries(patch).every(([key, value]) => String(current[key] ?? '') === String(value ?? ''))) return { unchanged: true }
  const merged = { ...current, ...patch }
  await graphWorkbookFetch(env, driveId, token, `/tables/${tableName}/rows/itemAt(index=${current._rowIndex})`, {
    method: 'PATCH', body: JSON.stringify({ values: [headers.map(header => merged[header] ?? '')] }),
  })
  return { updated: true }
}
