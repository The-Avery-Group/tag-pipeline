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

export async function ensureEbuyArchiveFolder(env, requestId, { fastLookup = false } = {}) {
  const driveId = env.EBUY_ARCHIVE_DRIVE_ID || env.DRIVE_ID || DEFAULT_DRIVE_ID
  const token = await getAppOnlyGraphToken(env)
  if (fastLookup) {
    const path = ['TAG CRM', 'eBuy Archive', safeSegment(requestId)].map(encodeURIComponent).join('/')
    const existing = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (existing.ok) {
      const opportunity = await existing.json()
      return { driveId, folderId: opportunity.id, webUrl: opportunity.webUrl, token }
    }
    if (existing.status !== 404) throw new Error(`Could not inspect SharePoint archive folder (${existing.status})`)
  }
  const root = await ensureFolder(driveId, token, 'root', 'TAG CRM')
  const archive = await ensureFolder(driveId, token, root.id, 'eBuy Archive')
  const opportunity = await ensureFolder(driveId, token, archive.id, safeSegment(requestId))
  return { driveId, folderId: opportunity.id, webUrl: opportunity.webUrl, token }
}

export async function archiveEbuyFile(env, { requestId, fileName, contentType, body, archiveLocation = null }) {
  const { driveId, folderId, token } = archiveLocation || await ensureEbuyArchiveFolder(env, requestId)
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

export async function moveArchivedEbuyFile(env, {
  sourceDriveId,
  itemId,
  targetDriveId,
  targetFolderId,
  fileName,
}) {
  if (!sourceDriveId || !itemId || !targetDriveId || !targetFolderId) {
    throw new Error('The archived eBuy file does not have a complete SharePoint location')
  }
  if (sourceDriveId !== targetDriveId) {
    throw new Error('The eBuy archive and opportunity workspace must use the same SharePoint document library')
  }
  const token = await getAppOnlyGraphToken(env)
  const safeName = safeSegment(fileName)
  const move = async (name) => {
    const response = await fetch(`https://graph.microsoft.com/v1.0/drives/${sourceDriveId}/items/${itemId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentReference: { id: targetFolderId }, name }),
    })
    const body = await response.json().catch(() => null)
    return { response, body }
  }

  let result = await move(safeName)
  if (result.response.status === 409) {
    const dot = safeName.lastIndexOf('.')
    const base = dot > 0 ? safeName.slice(0, dot) : safeName
    const extension = dot > 0 ? safeName.slice(dot) : ''
    result = await move(`${base} (eBuy)${extension}`)
  }
  if (!result.response.ok) {
    throw new Error(result.body?.error?.message || `Could not move ${safeName} into the opportunity workspace (${result.response.status})`)
  }
  return {
    driveId: targetDriveId,
    itemId: result.body.id,
    webUrl: result.body.webUrl,
    name: result.body.name || safeName,
    size: result.body.size || null,
  }
}

export async function deleteEmptyEbuyArchiveFolder(env, driveId, requestId) {
  if (!driveId || !requestId) return { deleted: false, reason: 'location_missing' }
  const token = await getAppOnlyGraphToken(env)
  const path = ['TAG CRM', 'eBuy Archive', safeSegment(requestId)].map(encodeURIComponent).join('/')
  const lookup = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${path}?$select=id,name,folder`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (lookup.status === 404) return { deleted: true, alreadyMissing: true }
  const folder = await lookup.json().catch(() => null)
  if (!lookup.ok) throw new Error(folder?.error?.message || `Could not inspect the eBuy opportunity archive (${lookup.status})`)

  const children = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folder.id}/children?$select=id&$top=1`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const childBody = await children.json().catch(() => null)
  if (!children.ok) throw new Error(childBody?.error?.message || `Could not verify the eBuy opportunity archive (${children.status})`)
  if (childBody?.value?.length) return { deleted: false, reason: 'not_empty' }

  const removal = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folder.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  })
  if (!removal.ok && removal.status !== 404) throw new Error(`Could not delete the empty eBuy opportunity archive (${removal.status})`)
  return { deleted: true }
}
