import { getAppOnlyGraphToken, graphWorkbookFetch, readWorkbookTable } from './graph.js'
import {
  DEFAULT_WORKSPACE_DRIVE_ID,
  describeExistingWorkspaceFolder,
  WORKSPACE_ROOT_NAME,
} from './opportunityWorkspaceSharePoint.js'
import {
  ensureWorkspaceRequest,
  getWorkspace,
  resetWorkspaceForRebuild,
  updateWorkspace,
} from './opportunityWorkspaceRepository.js'

const SCAN_CALLS_PER_BATCH = 8
const APPLY_BATCH_LIMIT = 8
const HIDDEN_SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

function clean(value) { return String(value || '').trim() }
function normalized(value) { return clean(value).toLowerCase() }

function driveIdFor(env) {
  return env.OPPORTUNITY_WORKSPACE_DRIVE_ID || DEFAULT_WORKSPACE_DRIVE_ID
}

async function graphJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Microsoft Graph request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return body
}

async function driveItem(token, driveId, itemId) {
  return graphJson(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}?$select=id,name,webUrl,parentReference,folder`,
    token,
  )
}

async function childByName(token, driveId, parentId, name) {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}?$select=id,name,webUrl,parentReference,folder`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (response.status === 404) return null
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message || `Could not locate ${name} in SharePoint (${response.status})`)
  return body
}

async function resolveMigrationRoot(env, token, driveId) {
  if (!env.WORKBOOK_ID) throw new Error('WORKBOOK_ID is not configured')
  const workbook = await driveItem(token, driveId, env.WORKBOOK_ID)
  const workbookParentId = workbook?.parentReference?.id
  if (!workbookParentId) throw new Error('Could not resolve the workbook SharePoint folder')
  const root = await childByName(token, driveId, workbookParentId, WORKSPACE_ROOT_NAME)
  if (!root?.folder) throw Object.assign(new Error(`SharePoint folder is missing: ${WORKSPACE_ROOT_NAME}`), { status: 404 })
  return root
}

function base64UrlEncode(bytes) {
  let binary = ''
  for (const value of bytes) binary += String.fromCharCode(value)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function signingKey(env) {
  if (!env.MS_CLIENT_SECRET) throw new Error('Microsoft Graph app credentials are not configured')
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.MS_CLIENT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

async function encodeCursor(env, state) {
  const payload = new TextEncoder().encode(JSON.stringify(state))
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), payload))
  return `${base64UrlEncode(payload)}.${base64UrlEncode(signature)}`
}

async function decodeCursor(env, cursor) {
  const [payloadPart, signaturePart] = clean(cursor).split('.')
  if (!payloadPart || !signaturePart) throw Object.assign(new Error('The migration scan cursor is invalid'), { status: 400 })
  const payload = base64UrlDecode(payloadPart)
  const signature = base64UrlDecode(signaturePart)
  const valid = await crypto.subtle.verify('HMAC', await signingKey(env), signature, payload)
  if (!valid) throw Object.assign(new Error('The migration scan cursor is invalid'), { status: 400 })
  const state = JSON.parse(new TextDecoder().decode(payload))
  if (!Array.isArray(state?.queue) || !state.rootId || !state.driveId) {
    throw Object.assign(new Error('The migration scan cursor is incomplete'), { status: 400 })
  }
  if (Date.now() - Number(state.createdAt || 0) > 30 * 60 * 1000) {
    throw Object.assign(new Error('The migration scan expired. Start a new scan.'), { status: 410 })
  }
  return state
}

function childrenUrl(driveId, node) {
  const params = new URLSearchParams({
    '$select': 'id,name,webUrl,parentReference,folder,file',
    '$top': '200',
    '$orderby': 'name',
  })
  if (node.skipToken) params.set('$skiptoken', node.skipToken)
  return `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${node.id}/children?${params}`
}

function nextSkipToken(nextLink) {
  if (!nextLink) return ''
  try { return new URL(nextLink).searchParams.get('$skiptoken') || '' } catch { return '' }
}

function scanChildren(state, node, items) {
  const folders = []
  for (const item of items) {
    if (!item.folder || HIDDEN_SYSTEM_FILES.has(normalized(item.name))) continue
    const name = clean(item.name)
    if (node.depth === 0) {
      if (!/^FY\s+\d{4}$/i.test(name)) continue
      state.queue.push({ id: item.id, depth: 1, year: name, department: '', agency: '' })
    } else if (node.depth === 1) {
      if (normalized(name) === '_templates') continue
      state.queue.push({ id: item.id, depth: 2, year: node.year, department: name, agency: '' })
    } else if (node.depth === 2) {
      state.queue.push({ id: item.id, depth: 3, year: node.year, department: node.department, agency: name })
    } else if (node.depth === 3) {
      folders.push({
        id: item.id,
        name,
        webUrl: item.webUrl || '',
        year: node.year,
        department: node.department,
        agency: node.agency,
        path: [node.year, node.department, node.agency, name].filter(Boolean).join(' / '),
      })
    }
  }
  return folders
}

export async function scanLegacyOpportunityFolders(env, cursor = '') {
  const token = await getAppOnlyGraphToken(env)
  let state
  if (cursor) {
    state = await decodeCursor(env, cursor)
    if (state.driveId !== driveIdFor(env)) throw Object.assign(new Error('The migration destination changed. Start a new scan.'), { status: 409 })
  } else {
    const driveId = driveIdFor(env)
    const root = await resolveMigrationRoot(env, token, driveId)
    state = {
      version: 1,
      createdAt: Date.now(),
      driveId,
      rootId: root.id,
      rootWebUrl: root.webUrl || '',
      inspected: 0,
      queue: [{ id: root.id, depth: 0, year: '', department: '', agency: '' }],
    }
  }

  const folders = []
  let calls = 0
  while (state.queue.length && calls < SCAN_CALLS_PER_BATCH) {
    const node = state.queue.shift()
    const body = await graphJson(childrenUrl(state.driveId, node), token)
    calls += 1
    state.inspected += 1
    folders.push(...scanChildren(state, node, body?.value || []))
    const skipToken = nextSkipToken(body?.['@odata.nextLink'])
    if (skipToken) state.queue.unshift({ ...node, skipToken })
  }

  const complete = state.queue.length === 0
  return {
    complete,
    cursor: complete ? null : await encodeCursor(env, state),
    folders,
    inspected: state.inspected,
    remainingLocations: state.queue.length,
    rootWebUrl: state.rootWebUrl,
  }
}

function fullItemPath(item) {
  const parentPath = clean(item?.parentReference?.path).replace(/\/$/, '')
  return `${parentPath}/${clean(item?.name)}`
}

async function canonicalMigrationFolder(env, token, driveId, root, folderId) {
  const folder = await driveItem(token, driveId, folderId)
  if (!folder?.folder) throw Object.assign(new Error('The selected SharePoint item is not a folder'), { status: 400 })
  const rootPath = fullItemPath(root)
  const folderPath = fullItemPath(folder)
  const relativeParts = folderPath.slice(rootPath.length + 1).split('/').filter(Boolean)
  if (!folderPath.startsWith(`${rootPath}/`) || relativeParts.length !== 4 || relativeParts.some((part) => normalized(part) === '_templates')) {
    throw Object.assign(new Error('The selected folder is outside the opportunity archive'), { status: 403 })
  }
  return folder
}

function sameLink(left, right) {
  return clean(left).replace(/\/$/, '').toLowerCase() === clean(right).replace(/\/$/, '').toLowerCase()
}

async function connectMigratedWorkspace(env, row, contractNumber, driveId, folder) {
  if (!env.EBUY_DB) return
  const existing = await getWorkspace(env.EBUY_DB, contractNumber)
  if (existing?.sharePointDriveId === driveId && existing?.rootFolderId === folder.id) {
    await updateWorkspace(env.EBUY_DB, existing.opportunityKey, {
      webUrl: folder.webUrl,
      progressPhase: existing.progressPhase || 'Existing SharePoint workspace connected',
    })
    return
  }
  const year = String(folder?.parentReference?.path || '').match(/\/FY\s+(20\d{2})(?:\/|$)/i)?.[1]
  let workspace = await ensureWorkspaceRequest(env.EBUY_DB, {
    opportunityKey: contractNumber,
    pipelineId: contractNumber,
    solicitationNumber: row['Solicitation Number'],
    title: row['Project Title / Description*'],
    department: row['Department*'],
    agency: row['Agency*'],
    noticeType: row['Notice Type'],
    calendarYear: year || new Date().getFullYear(),
  })
  workspace = await resetWorkspaceForRebuild(env.EBUY_DB, workspace.opportunityKey)
  const reference = await describeExistingWorkspaceFolder(env, driveId, folder.id)
  await updateWorkspace(env.EBUY_DB, workspace.opportunityKey, {
    status: 'ready',
    progressPhase: 'Existing SharePoint workspace connected',
    sharePointDriveId: reference.driveId,
    rootFolderId: reference.rootFolderId,
    samFolderId: reference.samFolderId,
    webUrl: reference.webUrl,
    attachmentTotal: 0,
    archivedCount: 0,
    failedCount: 0,
    errorMessage: null,
    completedAt: new Date().toISOString(),
  })
}

export async function applyLegacyFolderLinks(env, requestedLinks) {
  const links = Array.isArray(requestedLinks) ? requestedLinks.slice(0, APPLY_BATCH_LIMIT) : []
  if (!links.length) throw Object.assign(new Error('Select at least one folder link to apply'), { status: 400 })
  if (Array.isArray(requestedLinks) && requestedLinks.length > APPLY_BATCH_LIMIT) throw Object.assign(new Error(`Apply no more than ${APPLY_BATCH_LIMIT} links per request`), { status: 400 })

  const driveId = driveIdFor(env)
  const token = await getAppOnlyGraphToken(env)
  const [root, rows, columns] = await Promise.all([
    resolveMigrationRoot(env, token, driveId),
    readWorkbookTable(env, driveId, token, 'PipelineTable'),
    graphWorkbookFetch(env, driveId, token, '/tables/PipelineTable/columns'),
  ])
  const headers = (columns.value || []).map((column) => column.name)
  const linkIndex = headers.indexOf('Link to Folder')
  if (linkIndex < 0) throw new Error('PipelineTable is missing Link to Folder')

  const results = []
  for (const request of links) {
    const contractNumber = clean(request.contractNumber)
    const row = rows.find((candidate) => normalized(candidate['Contract Number / Notice ID']) === normalized(contractNumber))
    if (!row) {
      results.push({ contractNumber, status: 'skipped', reason: 'Opportunity no longer exists in PipelineTable' })
      continue
    }
    const currentLink = clean(row['Link to Folder'])
    if (!sameLink(currentLink, request.expectedCurrentLink || '')) {
      results.push({ contractNumber, status: 'skipped', previousLink: currentLink, reason: 'Folder link changed after the scan' })
      continue
    }

    let folder
    try {
      folder = await canonicalMigrationFolder(env, token, driveId, root, clean(request.folderId))
    } catch (error) {
      results.push({ contractNumber, status: 'skipped', previousLink: currentLink, reason: error.message })
      continue
    }
    if (sameLink(currentLink, folder.webUrl)) {
      await connectMigratedWorkspace(env, row, contractNumber, driveId, folder)
      results.push({ contractNumber, status: 'already_linked', previousLink: currentLink, webUrl: folder.webUrl, folderName: folder.name })
      continue
    }

    await connectMigratedWorkspace(env, row, contractNumber, driveId, folder)
    const values = [...row._values]
    while (values.length < headers.length) values.push('')
    values[linkIndex] = folder.webUrl
    await graphWorkbookFetch(env, driveId, token, `/tables/PipelineTable/rows/itemAt(index=${row._rowIndex})`, {
      method: 'PATCH',
      body: JSON.stringify({ values: [values] }),
    })
    row['Link to Folder'] = folder.webUrl
    row._values = values
    results.push({
      contractNumber,
      status: 'updated',
      previousLink: currentLink,
      webUrl: folder.webUrl,
      folderName: folder.name,
    })
  }

  return {
    results,
    updated: results.filter((result) => result.status === 'updated').length,
    alreadyLinked: results.filter((result) => result.status === 'already_linked').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
  }
}
