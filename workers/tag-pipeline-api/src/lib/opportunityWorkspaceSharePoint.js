import { getAppOnlyGraphToken, graphWorkbookFetch, readWorkbookTable } from './graph.js'
import { organizationFolderKey, safeSharePointSegment } from './opportunityWorkspaceDomain.js'

export const DEFAULT_WORKSPACE_DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'
export const WORKSPACE_ROOT_NAME = 'RFI Pipeline and Responses'
export const WORKSPACE_TEMPLATE_PATH = [WORKSPACE_ROOT_NAME, '_Templates', 'Copy Me For RFI']
export const SAM_DOCUMENTS_FOLDER_NAME = '2. RFI Documents'
export const REFERENCE_MATERIALS_FOLDER_NAME = '7. Reference Materials'
const HIDDEN_SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  'app', 'bat', 'cmd', 'com', 'cpl', 'dll', 'exe', 'gadget', 'hta', 'inf', 'ins',
  'isp', 'jar', 'js', 'jse', 'lnk', 'mjs', 'msc', 'msi', 'msp', 'mst', 'pif',
  'ps1', 'reg', 'scr', 'sct', 'shb', 'sys', 'vb', 'vbe', 'vbs', 'ws', 'wsc',
  'wsf', 'wsh',
])

export function driveIdFor(env) {
  // DRIVE_ID may point at a separate capabilities-document library. Keep the
  // opportunity archive anchored to the workbook library unless its own
  // explicit override is configured.
  return env.OPPORTUNITY_WORKSPACE_DRIVE_ID || DEFAULT_WORKSPACE_DRIVE_ID
}

function encodedSharingUrl(value) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `u!${btoa(binary).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`
}

export async function graphResponse(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  })
  const raw = response.status === 204 ? '' : await response.text()
  let body = null
  if (raw) {
    try { body = JSON.parse(raw) } catch { body = raw }
  }
  if (!response.ok) {
    const message = typeof body === 'object' ? body?.error?.message : String(body || '')
    const error = new Error(message || `Microsoft Graph request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return { response, body }
}

export async function getItem(env, token, driveId, itemId) {
  const { body } = await graphResponse(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}?$select=id,name,webUrl,parentReference,folder,file,size,lastModifiedDateTime`,
    token,
  )
  return body
}

export function opportunityUploadValidation(fileName, fileSize) {
  const name = String(fileName || '').trim()
  const size = Number(fileSize)
  if (!name) return { valid: false, error: 'Choose a file with a valid name' }
  if (!Number.isFinite(size) || size <= 0) return { valid: false, error: `${name} is empty or has an invalid size` }
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  if (BLOCKED_UPLOAD_EXTENSIONS.has(extension)) {
    return { valid: false, error: `${name} is an executable or script file and cannot be uploaded` }
  }
  return { valid: true, name: safeSharePointSegment(name, 'Reference material', 180), size }
}

export async function createReferenceMaterialUploadSession(env, workspace, file) {
  if (!workspace?.sharePointDriveId || !workspace?.rootFolderId) {
    throw Object.assign(new Error('Set up the SharePoint workspace before attaching files to a note'), { status: 409 })
  }
  const validation = opportunityUploadValidation(file?.fileName, file?.fileSize)
  if (!validation.valid) throw Object.assign(new Error(validation.error), { status: 400 })

  const token = await getAppOnlyGraphToken(env)
  const root = await getItem(env, token, workspace.sharePointDriveId, workspace.rootFolderId)
  if (!root?.folder) {
    throw Object.assign(new Error('The opportunity SharePoint workspace is unavailable'), { status: 409 })
  }
  const referenceFolder = await childByName(
    env,
    token,
    workspace.sharePointDriveId,
    root.id,
    REFERENCE_MATERIALS_FOLDER_NAME,
  )
  if (!referenceFolder?.folder) {
    throw Object.assign(new Error(`The SharePoint workspace is missing ${REFERENCE_MATERIALS_FOLDER_NAME}`), { status: 409 })
  }

  const { body } = await graphResponse(
    `https://graph.microsoft.com/v1.0/drives/${workspace.sharePointDriveId}/items/${referenceFolder.id}:/${encodeURIComponent(validation.name)}:/createUploadSession`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item: {
          '@microsoft.graph.conflictBehavior': 'rename',
          name: validation.name,
        },
      }),
    },
  )
  if (!body?.uploadUrl) throw new Error(`SharePoint did not create an upload session for ${validation.name}`)
  return {
    uploadUrl: body.uploadUrl,
    expirationDateTime: body.expirationDateTime || '',
    fileName: validation.name,
    folder: {
      id: referenceFolder.id,
      name: referenceFolder.name,
      webUrl: referenceFolder.webUrl || '',
    },
  }
}

export async function removeReferenceMaterialUploads(env, workspace, itemIds) {
  if (!workspace?.sharePointDriveId || !workspace?.rootFolderId) return { removed: 0 }
  const ids = [...new Set((itemIds || []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 20)
  if (!ids.length) return { removed: 0 }
  const token = await getAppOnlyGraphToken(env)
  const referenceFolder = await childByName(
    env,
    token,
    workspace.sharePointDriveId,
    workspace.rootFolderId,
    REFERENCE_MATERIALS_FOLDER_NAME,
  )
  if (!referenceFolder?.folder) return { removed: 0 }

  let removed = 0
  for (const itemId of ids) {
    try {
      const item = await getItem(env, token, workspace.sharePointDriveId, itemId)
      if (item?.parentReference?.id !== referenceFolder.id || item?.folder) continue
      await graphResponse(
        `https://graph.microsoft.com/v1.0/drives/${workspace.sharePointDriveId}/items/${encodeURIComponent(itemId)}`,
        token,
        { method: 'DELETE' },
      )
      removed += 1
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'opportunity_reference_upload_cleanup_failed',
        opportunityKey: workspace.opportunityKey,
        itemId,
        message: error.message,
      }))
    }
  }
  return { removed }
}

export async function inspectWorkspaceRoot(env, workspace) {
  if (!workspace?.sharePointDriveId || !workspace?.rootFolderId) {
    return { exists: false, reason: 'Workspace location is not recorded' }
  }
  const token = await getAppOnlyGraphToken(env)
  try {
    const folder = await getItem(env, token, workspace.sharePointDriveId, workspace.rootFolderId)
    return folder?.folder
      ? { exists: true, folder }
      : { exists: false, reason: 'Recorded workspace item is not a folder' }
  } catch (error) {
    if (error.status === 404) return { exists: false, reason: 'Recorded SharePoint folder no longer exists' }
    throw error
  }
}

export async function describeExistingWorkspaceFolder(env, driveId, folderId) {
  const token = await getAppOnlyGraphToken(env)
  const folder = await getItem(env, token, driveId, folderId)
  if (!folder?.folder) throw Object.assign(new Error('The selected SharePoint item is not a folder'), { status: 400 })
  const samFolder = await childByName(env, token, driveId, folder.id, SAM_DOCUMENTS_FOLDER_NAME)
  return {
    driveId,
    rootFolderId: folder.id,
    samFolderId: samFolder?.id || null,
    webUrl: folder.webUrl || '',
  }
}

export async function resolveWorkspaceFolderLink(env, webUrl) {
  let parsed
  try { parsed = new URL(String(webUrl || '').trim()) } catch {
    throw Object.assign(new Error('The opportunity folder link is not a valid URL'), { status: 400 })
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.toLowerCase().endsWith('.sharepoint.com')) {
    throw Object.assign(new Error('The opportunity folder link must be a SharePoint URL'), { status: 400 })
  }

  const driveId = driveIdFor(env)
  const token = await getAppOnlyGraphToken(env)
  const { body: folder } = await graphResponse(
    `https://graph.microsoft.com/v1.0/shares/${encodedSharingUrl(parsed.href)}/driveItem?$select=id,name,webUrl,parentReference,folder`,
    token,
    { headers: { Prefer: 'redeemSharingLinkIfNecessary' } },
  )
  if (!folder?.folder || folder?.parentReference?.driveId !== driveId) {
    throw Object.assign(new Error('The folder link is not in the configured SharePoint document library'), { status: 403 })
  }

  if (!env.WORKBOOK_ID) throw new Error('WORKBOOK_ID is not configured')
  const workbook = await getItem(env, token, driveId, env.WORKBOOK_ID)
  const workbookParentId = workbook?.parentReference?.id
  if (!workbookParentId) throw new Error('Could not resolve the workbook SharePoint folder')
  const archiveRoot = await childByName(env, token, driveId, workbookParentId, WORKSPACE_ROOT_NAME)
  if (!archiveRoot?.folder) throw Object.assign(new Error(`SharePoint folder is missing: ${WORKSPACE_ROOT_NAME}`), { status: 404 })
  const rootPath = fullItemPath(archiveRoot)
  const folderPath = fullItemPath(folder)
  const relativePath = folderPath.slice(rootPath.length + 1)
  if (!folderPath.startsWith(`${rootPath}/`) || relativePath.split('/').some((part) => part.toLowerCase() === '_templates')) {
    throw Object.assign(new Error('The selected folder is outside the opportunity archive'), { status: 403 })
  }
  return describeExistingWorkspaceFolder(env, driveId, folder.id)
}

export async function finishRecordedWorkspaceFolders(env, workspace) {
  const inspection = await inspectWorkspaceRoot(env, workspace)
  if (!inspection.exists) return null
  const token = await getAppOnlyGraphToken(env)
  const samFolder = await ensureFolder(
    env,
    token,
    workspace.sharePointDriveId,
    workspace.rootFolderId,
    SAM_DOCUMENTS_FOLDER_NAME,
  )
  return {
    driveId: workspace.sharePointDriveId,
    rootFolderId: inspection.folder.id,
    samFolderId: samFolder.id,
    webUrl: inspection.folder.webUrl,
  }
}

export async function childByName(env, token, driveId, parentId, name) {
  const encoded = encodeURIComponent(name)
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}:/${encoded}?$select=id,name,webUrl,parentReference,folder,file,size,lastModifiedDateTime`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (response.status === 404) return null
  const raw = await response.text()
  let body = null
  try { body = raw ? JSON.parse(raw) : null } catch { body = null }
  if (!response.ok) throw new Error(body?.error?.message || `Could not inspect SharePoint folder (${response.status})`)
  return body
}

async function ensureFolder(env, token, driveId, parentId, name) {
  const safeName = safeSharePointSegment(name, 'Folder')
  const existing = await childByName(env, token, driveId, parentId, safeName)
  if (existing) return existing
  const { body } = await graphResponse(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}/children`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: safeName, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    },
  )
  return body
}

async function listChildFolders(token, driveId, parentId) {
  const folders = []
  let nextUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}/children?$select=id,name,webUrl,parentReference,folder&$top=200`
  while (nextUrl) {
    const { body } = await graphResponse(nextUrl, token)
    folders.push(...(body.value || []).filter((item) => item.folder))
    nextUrl = body['@odata.nextLink'] || ''
  }
  return folders
}

async function ensureOrganizationFolder(env, token, driveId, parentId, name) {
  const safeName = safeSharePointSegment(name, 'Unassigned Organization')
  const exact = await childByName(env, token, driveId, parentId, safeName)
  if (exact) return exact

  const requestedKey = organizationFolderKey(safeName)
  if (requestedKey) {
    const matches = (await listChildFolders(token, driveId, parentId))
      .filter((folder) => organizationFolderKey(folder.name) === requestedKey)
    if (matches.length === 1) {
      console.info(JSON.stringify({
        event: 'opportunity_workspace_organization_folder_reused',
        requestedName: safeName,
        existingName: matches[0].name,
      }))
      return matches[0]
    }
    if (matches.length > 1) {
      throw Object.assign(new Error(`Multiple SharePoint folders match ${safeName}: ${matches.map((folder) => folder.name).join(', ')}`), {
        status: 409,
        code: 'ambiguous_organization_folder',
      })
    }
  }
  return ensureFolder(env, token, driveId, parentId, safeName)
}

export async function resolveWorkspaceDestination(env, workspace, folderName) {
  if (!env.WORKBOOK_ID) throw new Error('WORKBOOK_ID is not configured')
  const driveId = driveIdFor(env)
  const token = await getAppOnlyGraphToken(env)
  const workbook = await getItem(env, token, driveId, env.WORKBOOK_ID)
  const workbookParentId = workbook?.parentReference?.id
  if (!workbookParentId) throw new Error('Could not resolve the workbook SharePoint folder')

  let template = { id: workbookParentId }
  for (const segment of WORKSPACE_TEMPLATE_PATH) {
    template = await childByName(env, token, driveId, template.id, segment)
    if (!template) throw new Error(`SharePoint template folder is missing: ${WORKSPACE_TEMPLATE_PATH.join('/')}`)
  }

  const root = await ensureFolder(env, token, driveId, workbookParentId, WORKSPACE_ROOT_NAME)
  const year = await ensureFolder(env, token, driveId, root.id, `FY ${workspace.calendarYear}`)
  const department = await ensureOrganizationFolder(env, token, driveId, year.id, workspace.department || 'Unassigned Department')
  const agency = await ensureOrganizationFolder(env, token, driveId, department.id, workspace.agency || 'Unassigned Agency')
  const existing = await childByName(env, token, driveId, agency.id, folderName)
  return {
    driveId,
    templateId: template.id,
    destinationParentId: agency.id,
    existingFolder: existing,
    folderName,
  }
}

export async function beginWorkspaceTemplateCopy(env, destination) {
  if (destination.existingFolder) {
    return { completed: true, folder: destination.existingFolder }
  }
  const token = await getAppOnlyGraphToken(env)
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${destination.driveId}/items/${destination.templateId}/copy`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentReference: { driveId: destination.driveId, id: destination.destinationParentId },
        name: destination.folderName,
      }),
    },
  )
  if (response.status !== 202) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error?.message || `Could not copy the SharePoint template (${response.status})`)
  }
  return { completed: false }
}

export async function findCopiedWorkspaceFolder(env, destination) {
  const token = await getAppOnlyGraphToken(env)
  const folder = await childByName(
    env,
    token,
    destination.driveId,
    destination.destinationParentId,
    destination.folderName,
  )
  return folder
    ? { complete: true, folder: { id: folder.id, name: folder.name, webUrl: folder.webUrl } }
    : { complete: false, folder: null }
}

export async function finishWorkspaceFolders(env, workspace, folderName) {
  const destination = await resolveWorkspaceDestination(env, workspace, folderName)
  const folder = destination.existingFolder
  if (!folder) throw new Error('The copied opportunity folder could not be found in SharePoint')
  const token = await getAppOnlyGraphToken(env)
  const samFolder = await ensureFolder(env, token, destination.driveId, folder.id, SAM_DOCUMENTS_FOLDER_NAME)
  return {
    driveId: destination.driveId,
    rootFolderId: folder.id,
    samFolderId: samFolder.id,
    webUrl: folder.webUrl,
  }
}

export async function uploadSAMAttachment(env, { driveId, folderId, fileName, contentType, body }) {
  const token = await getAppOnlyGraphToken(env)
  const safeName = safeSharePointSegment(fileName, 'SAM attachment', 180)
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}:/${encodeURIComponent(safeName)}:/content`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType || 'application/octet-stream' },
      body,
    },
  )
  const item = await response.json().catch(() => null)
  if (!response.ok) throw new Error(item?.error?.message || `Could not save ${safeName} to SharePoint (${response.status})`)
  return { itemId: item.id, name: item.name, size: item.size, webUrl: item.webUrl }
}

export async function updatePipelineFolderLink(env, workspace, webUrl) {
  if (!webUrl || !env.WORKBOOK_ID) return { updated: false }
  const driveId = driveIdFor(env)
  const token = await getAppOnlyGraphToken(env)
  const rows = await readWorkbookTable(env, driveId, token, 'PipelineTable')
  const identifiers = new Set([
    workspace.pipelineId,
    workspace.noticeId,
    workspace.solicitationNumber,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))
  const row = rows.find((candidate) => identifiers.has(String(candidate['Contract Number / Notice ID'] || '').trim().toLowerCase()))
  if (!row) return { updated: false }
  const columns = await graphWorkbookFetch(env, driveId, token, '/tables/PipelineTable/columns')
  const headers = (columns.value || []).map((column) => column.name)
  const folderIndex = headers.indexOf('Link to Folder')
  if (folderIndex < 0) throw new Error('PipelineTable is missing Link to Folder')
  const values = [...row._values]
  while (values.length < headers.length) values.push('')
  values[folderIndex] = webUrl
  await graphWorkbookFetch(env, driveId, token, `/tables/PipelineTable/rows/itemAt(index=${row._rowIndex})`, {
    method: 'PATCH',
    body: JSON.stringify({ values: [values] }),
  })
  return { updated: true }
}

export function fullItemPath(item) {
  const parentPath = String(item?.parentReference?.path || '').replace(/\/$/, '')
  return `${parentPath}/${item?.name || ''}`
}

export async function listWorkspaceChildren(env, workspace, parentId = '') {
  if (!workspace?.sharePointDriveId || !workspace?.rootFolderId) throw Object.assign(new Error('The SharePoint workspace is not ready'), { status: 409 })
  const driveId = workspace.sharePointDriveId
  const token = await getAppOnlyGraphToken(env)
  const root = await getItem(env, token, driveId, workspace.rootFolderId)
  const requestedId = parentId || root.id
  const requested = requestedId === root.id ? root : await getItem(env, token, driveId, requestedId)
  const rootPath = fullItemPath(root)
  const requestedPath = fullItemPath(requested)
  if (requestedPath !== rootPath && !requestedPath.startsWith(`${rootPath}/`)) {
    throw Object.assign(new Error('The requested folder is outside this opportunity workspace'), { status: 403 })
  }
  if (!requested.folder) throw Object.assign(new Error('The requested SharePoint item is not a folder'), { status: 400 })
  const { body } = await graphResponse(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${requested.id}/children?$select=id,name,webUrl,folder,file,size,lastModifiedDateTime&$orderby=name`,
    token,
  )
  return {
    parent: { id: requested.id, name: requested.name, webUrl: requested.webUrl },
    items: (body.value || []).filter((item) => !HIDDEN_SYSTEM_FILES.has(String(item.name || '').toLowerCase())).map((item) => ({
      id: item.id,
      name: item.name,
      webUrl: item.webUrl,
      type: item.folder ? 'folder' : 'file',
      childCount: Number(item.folder?.childCount || 0),
      size: Number(item.size || 0),
      mimeType: item.file?.mimeType || '',
      lastModifiedDateTime: item.lastModifiedDateTime || '',
    })),
  }
}

function dossierSource(path) {
  const first = String(path || '').split('/').filter(Boolean)[0] || ''
  if (first === SAM_DOCUMENTS_FOLDER_NAME) return 'Source documents'
  if (first === REFERENCE_MATERIALS_FOLDER_NAME) return 'Reference material'
  return 'Workspace'
}

export async function listWorkspaceFlatFiles(env, workspace) {
  if (!workspace?.sharePointDriveId || !workspace?.rootFolderId) {
    throw Object.assign(new Error('The SharePoint workspace is not ready'), { status: 409 })
  }
  const driveId = workspace.sharePointDriveId
  const token = await getAppOnlyGraphToken(env)
  const root = await getItem(env, token, driveId, workspace.rootFolderId)
  if (!root?.folder) throw Object.assign(new Error('The opportunity SharePoint workspace is unavailable'), { status: 409 })

  const folders = [{ id: root.id, path: '' }]
  const files = []
  let folderIndex = 0
  let requestCount = 0
  let partial = false
  // Free Workers allow a bounded number of external subrequests. Opportunity
  // templates are small, but stop cleanly instead of failing the entire
  // dossier if an unusually deep workspace exceeds that budget.
  while (folderIndex < folders.length && requestCount < 45 && files.length < 5000) {
    const folder = folders[folderIndex++]
    let nextUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folder.id}/children?$select=id,name,webUrl,folder,file,size,lastModifiedDateTime&$top=200`
    do {
      requestCount += 1
      const { body } = await graphResponse(nextUrl, token)
      for (const item of body.value || []) {
        if (HIDDEN_SYSTEM_FILES.has(String(item.name || '').toLowerCase())) continue
        const path = [folder.path, item.name].filter(Boolean).join('/')
        if (item.folder) folders.push({ id: item.id, path })
        else files.push({
          id: item.id,
          name: item.name,
          path,
          folderPath: folder.path,
          source: dossierSource(path),
          webUrl: item.webUrl || '',
          size: Number(item.size || 0),
          mimeType: item.file?.mimeType || '',
          lastModifiedDateTime: item.lastModifiedDateTime || '',
        })
      }
      nextUrl = body['@odata.nextLink'] || ''
    } while (nextUrl && requestCount < 45 && files.length < 5000)
  }
  if (folderIndex < folders.length || files.length >= 5000) partial = true
  return {
    workspace: { webUrl: root.webUrl || workspace.webUrl || '', name: root.name || workspace.title },
    files: files.sort((left, right) => String(right.lastModifiedDateTime).localeCompare(String(left.lastModifiedDateTime))),
    count: files.length,
    partial,
    indexedAt: new Date().toISOString(),
  }
}
