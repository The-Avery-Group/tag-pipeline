import { getAppOnlyGraphToken } from './graph.js'

const DEFAULT_DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'

function safeSegment(value) {
  return String(value || 'file').replace(/["*:<>?/\\|#%]/g, '_').trim().slice(0, 120) || 'file'
}

async function graphJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  })
  const payload = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error?.message || `SharePoint archive request failed (${response.status})`)
  return payload
}

async function ensureFolder(driveId, token, parentId, folderName) {
  const encoded = encodeURIComponent(folderName)
  const lookup = parentId === 'root'
    ? `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encoded}`
    : `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}:/${encoded}`
  const existing = await fetch(lookup, { headers: { Authorization: `Bearer ${token}` } })
  if (existing.ok) return existing.json()
  if (existing.status !== 404) throw new Error(`Could not inspect SharePoint archive folder (${existing.status})`)
  const createUrl = parentId === 'root'
    ? `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children`
    : `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}/children`
  return graphJson(createUrl, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
  })
}

export async function ensureEbuyArchiveFolder(env, requestId) {
  const driveId = env.EBUY_ARCHIVE_DRIVE_ID || env.DRIVE_ID || DEFAULT_DRIVE_ID
  const token = await getAppOnlyGraphToken(env)
  const root = await ensureFolder(driveId, token, 'root', 'TAG CRM')
  const archive = await ensureFolder(driveId, token, root.id, 'eBuy Archive')
  const opportunity = await ensureFolder(driveId, token, archive.id, safeSegment(requestId))
  return { driveId, folderId: opportunity.id, webUrl: opportunity.webUrl, token }
}

export async function archiveEbuyFile(env, { requestId, fileName, contentType, body }) {
  const { driveId, folderId, token } = await ensureEbuyArchiveFolder(env, requestId)
  const encodedName = encodeURIComponent(safeSegment(fileName))
  const response = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}:/${encodedName}:/content`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType || 'application/octet-stream' },
    body,
  })
  const item = await response.json().catch(() => null)
  if (!response.ok) throw new Error(item?.error?.message || `Could not archive ${fileName} (${response.status})`)
  return { driveId, itemId: item.id, webUrl: item.webUrl, name: item.name, size: item.size }
}

export async function deleteArchivedEbuyFile(env, driveId, itemId) {
  if (!driveId || !itemId) return
  const token = await getAppOnlyGraphToken(env)
  const response = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok && response.status !== 404) throw new Error(`Could not delete archived eBuy file (${response.status})`)
}
