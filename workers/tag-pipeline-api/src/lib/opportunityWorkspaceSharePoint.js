import { getAppOnlyGraphToken, graphWorkbookFetch, readWorkbookTable } from './graph.js'
import { safeSharePointSegment } from './opportunityWorkspaceDomain.js'

export const DEFAULT_WORKSPACE_DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'
export const WORKSPACE_ROOT_NAME = 'RFI Pipeline and Responses'
export const WORKSPACE_TEMPLATE_PATH = [WORKSPACE_ROOT_NAME, '_Templates', 'Copy Me For RFI']
export const SAM_DOCUMENTS_FOLDER_NAME = '2. RFI Documents'

function driveIdFor(env) {
  // DRIVE_ID may point at a separate capabilities-document library. Keep the
  // opportunity archive anchored to the workbook library unless its own
  // explicit override is configured.
  return env.OPPORTUNITY_WORKSPACE_DRIVE_ID || DEFAULT_WORKSPACE_DRIVE_ID
}

async function graphResponse(url, token, options = {}) {
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

async function getItem(env, token, driveId, itemId) {
  const { body } = await graphResponse(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}?$select=id,name,webUrl,parentReference,folder,file,size,lastModifiedDateTime`,
    token,
  )
  return body
}

async function childByName(env, token, driveId, parentId, name) {
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
  const department = await ensureFolder(env, token, driveId, year.id, workspace.department || 'Unassigned Department')
  const agency = await ensureFolder(env, token, driveId, department.id, workspace.agency || 'Unassigned Agency')
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
    return { completed: true, folder: destination.existingFolder, monitorUrl: null }
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
  const monitorUrl = response.headers.get('Location')
  if (!monitorUrl) throw new Error('SharePoint did not return a template-copy monitor URL')
  return { completed: false, monitorUrl }
}

export async function pollWorkspaceTemplateCopy(env, monitorUrl) {
  const token = await getAppOnlyGraphToken(env)
  const response = await fetch(monitorUrl, { headers: { Authorization: `Bearer ${token}` } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error?.message || `SharePoint template copy failed (${response.status})`)
  const status = String(body.status || '').toLowerCase()
  if (status === 'failed') throw new Error(body.error?.message || 'SharePoint could not copy the opportunity template')
  return { complete: ['completed', 'succeeded'].includes(status), status: status || 'inProgress' }
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

function fullItemPath(item) {
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
    items: (body.value || []).map((item) => ({
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
