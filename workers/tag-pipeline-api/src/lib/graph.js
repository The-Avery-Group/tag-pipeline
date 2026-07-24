/** Shared Microsoft Graph helpers for Worker jobs. */
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
  if (!response.ok) throw new Error(body?.error?.message || `Microsoft Graph error ${response.status}`)
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
