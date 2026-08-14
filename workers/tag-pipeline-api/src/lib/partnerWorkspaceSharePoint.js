import { getAppOnlyGraphToken, graphWorkbookFetch, readWorkbookTable } from './graph.js'
import {
  childByName,
  driveIdFor,
  fullItemPath,
  getItem,
  graphResponse,
  opportunityUploadValidation,
} from './opportunityWorkspaceSharePoint.js'

export const PARTNERS_ROOT_NAME = 'Partners'
export const PARTNER_FOLDER_HEADER = 'Link to Partner Folder'
export const LEGACY_PARTNER_FOLDER_HEADER = 'Link to onedrive folder'
const HIDDEN_SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

function normalizedHeader(value) {
  return String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function normalizePartnerFolderName(value) {
  const words = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
  const suffixes = new Set(['llc', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'lp', 'llp', 'pllc'])
  while (words.length > 1 && suffixes.has(words.at(-1))) words.pop()
  return words.join(' ')
}

function encodedSharingUrl(value) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `u!${btoa(binary).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`
}

async function workbookContext(env) {
  if (!env.WORKBOOK_ID) throw new Error('WORKBOOK_ID is not configured')
  const token = await getAppOnlyGraphToken(env)
  const driveId = driveIdFor(env)
  const workbook = await getItem(env, token, driveId, env.WORKBOOK_ID)
  if (!workbook?.parentReference?.id) throw new Error('Could not resolve the workbook SharePoint folder')
  const root = await childByName(env, token, driveId, workbook.parentReference.id, PARTNERS_ROOT_NAME)
  if (!root?.folder) throw Object.assign(new Error(`SharePoint folder is missing: ${PARTNERS_ROOT_NAME}`), { status: 404 })
  return { token, driveId, workbookParentId: workbook.parentReference.id, root }
}

async function tableHeaders(env, driveId, token, tableName) {
  const columns = await graphWorkbookFetch(env, driveId, token, `/tables/${tableName}/columns`)
  return (columns.value || []).map((column) => column.name)
}

async function ensureColumn(env, driveId, token, tableName, name) {
  let headers = await tableHeaders(env, driveId, token, tableName)
  if (headers.some((header) => normalizedHeader(header) === normalizedHeader(name))) return headers
  await graphWorkbookFetch(env, driveId, token, `/tables/${tableName}/columns`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  return tableHeaders(env, driveId, token, tableName)
}

export async function migratePartnerWorkspaceSchema(env) {
  const { token, driveId } = await workbookContext(env)
  let partnerHeaders = await tableHeaders(env, driveId, token, 'PartnersTable')
  const hasCanonical = partnerHeaders.some((header) => normalizedHeader(header) === normalizedHeader(PARTNER_FOLDER_HEADER))
  const legacyHeader = partnerHeaders.find((header) => normalizedHeader(header) === normalizedHeader(LEGACY_PARTNER_FOLDER_HEADER))
  let renamedPartnerColumn = false
  if (!hasCanonical && legacyHeader) {
    try {
      await graphWorkbookFetch(env, driveId, token, `/tables/PartnersTable/columns/${encodeURIComponent(legacyHeader)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: PARTNER_FOLDER_HEADER }),
      })
      partnerHeaders = await tableHeaders(env, driveId, token, 'PartnersTable')
      renamedPartnerColumn = true
    } catch {
      // Fall back to adding and copying when Graph refuses a table-column rename.
    }
  }
  partnerHeaders = await ensureColumn(env, driveId, token, 'PartnersTable', PARTNER_FOLDER_HEADER)
  await ensureColumn(env, driveId, token, 'NotesTable', 'Related Type')
  await ensureColumn(env, driveId, token, 'NotesTable', 'Related ID')
  const canonicalIndex = partnerHeaders.findIndex((header) => normalizedHeader(header) === normalizedHeader(PARTNER_FOLDER_HEADER))
  const legacyIndex = partnerHeaders.findIndex((header) => normalizedHeader(header) === normalizedHeader(LEGACY_PARTNER_FOLDER_HEADER))
  let migratedLinks = 0
  if (legacyIndex >= 0) {
    const rows = await readWorkbookTable(env, driveId, token, 'PartnersTable')
    for (const row of rows) {
      const values = [...row._values]
      while (values.length < partnerHeaders.length) values.push('')
      if (String(values[canonicalIndex] || '').trim() || !String(values[legacyIndex] || '').trim()) continue
      values[canonicalIndex] = values[legacyIndex]
      await graphWorkbookFetch(env, driveId, token, `/tables/PartnersTable/rows/itemAt(index=${row._rowIndex})`, {
        method: 'PATCH',
        body: JSON.stringify({ values: [values] }),
      })
      migratedLinks += 1
    }
  }
  return { migratedLinks, renamedPartnerColumn }
}

async function listChildren(token, driveId, parentId) {
  let nextUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}/children?$select=id,name,webUrl,folder,file,size,lastModifiedDateTime&$orderby=name`
  const items = []
  while (nextUrl) {
    const { body } = await graphResponse(nextUrl, token)
    items.push(...(body.value || []))
    nextUrl = body['@odata.nextLink'] || ''
  }
  return items.filter((item) => !HIDDEN_SYSTEM_FILES.has(String(item.name || '').toLowerCase()))
}

export async function scanPartnerFolders(env) {
  const migration = await migratePartnerWorkspaceSchema(env)
  const { token, driveId, root } = await workbookContext(env)
  const [partners, children] = await Promise.all([
    readWorkbookTable(env, driveId, token, 'PartnersTable'),
    listChildren(token, driveId, root.id),
  ])
  const folders = children.filter((item) => item.folder).map((folder) => ({
    id: folder.id,
    name: folder.name,
    webUrl: folder.webUrl || '',
    normalizedName: normalizePartnerFolderName(folder.name),
  }))
  const partnerRows = partners.map((partner) => {
    const name = String(partner['Partner Name'] || '').trim()
    const currentLink = String(partner[PARTNER_FOLDER_HEADER] || partner[LEGACY_PARTNER_FOLDER_HEADER] || '').trim()
    const normalizedCurrentLink = currentLink.replace(/\/$/, '').toLowerCase()
    const linkedFolder = folders.find((folder) => folder.webUrl.replace(/\/$/, '').toLowerCase() === normalizedCurrentLink)
    const matches = folders.filter((folder) => folder.normalizedName === normalizePartnerFolderName(name))
    return {
      uei: String(partner['UEI Number'] || '').trim().toUpperCase(),
      partnerName: name,
      currentLink,
      status: linkedFolder ? 'linked' : matches.length === 1 ? 'matched' : matches.length > 1 ? 'ambiguous' : 'unmatched',
      suggestedFolderId: linkedFolder?.id || (matches.length === 1 ? matches[0].id : ''),
      linkedFolderId: linkedFolder?.id || '',
      candidates: matches,
    }
  })
  return { root: { id: root.id, name: root.name, webUrl: root.webUrl || '' }, folders, partners: partnerRows, migration }
}

export async function applyPartnerFolderLinks(env, mappings) {
  const { token, driveId, root } = await workbookContext(env)
  const [headers, rows, children] = await Promise.all([
    tableHeaders(env, driveId, token, 'PartnersTable'),
    readWorkbookTable(env, driveId, token, 'PartnersTable'),
    listChildren(token, driveId, root.id),
  ])
  const linkIndex = headers.findIndex((header) => normalizedHeader(header) === normalizedHeader(PARTNER_FOLDER_HEADER))
  if (linkIndex < 0) throw new Error(`PartnersTable is missing ${PARTNER_FOLDER_HEADER}`)
  const folderById = new Map(children.filter((item) => item.folder).map((item) => [item.id, item]))
  let updated = 0
  let skipped = 0
  const results = []
  for (const mapping of mappings || []) {
    const uei = String(mapping?.uei || '').trim().toUpperCase()
    const folder = folderById.get(String(mapping?.folderId || '').trim())
    const row = rows.find((candidate) => String(candidate['UEI Number'] || '').trim().toUpperCase() === uei)
    if (!uei || !folder || !row) {
      skipped += 1
      results.push({ uei, status: 'skipped', reason: !row ? 'Partner no longer exists' : 'Selected SharePoint folder is unavailable' })
      continue
    }
    const currentLink = String(row[PARTNER_FOLDER_HEADER] || row[LEGACY_PARTNER_FOLDER_HEADER] || '').trim()
    const expectedCurrentLink = String(mapping?.expectedCurrentLink || '').trim()
    if (currentLink.replace(/\/$/, '').toLowerCase() === String(folder.webUrl || '').replace(/\/$/, '').toLowerCase()) {
      results.push({ uei, status: 'already_linked', webUrl: folder.webUrl || currentLink })
      continue
    }
    if (currentLink !== expectedCurrentLink) {
      skipped += 1
      results.push({ uei, status: 'skipped', reason: 'The partner folder link changed in the workbook during review' })
      continue
    }
    const values = [...row._values]
    while (values.length < headers.length) values.push('')
    values[linkIndex] = folder.webUrl || ''
    await graphWorkbookFetch(env, driveId, token, `/tables/PartnersTable/rows/itemAt(index=${row._rowIndex})`, {
      method: 'PATCH',
      body: JSON.stringify({ values: [values] }),
    })
    updated += 1
    results.push({ uei, status: 'updated', webUrl: folder.webUrl || '' })
  }
  return { updated, skipped, results }
}

async function partnerFolder(env, uei) {
  const { token, driveId, root } = await workbookContext(env)
  const partners = await readWorkbookTable(env, driveId, token, 'PartnersTable')
  const partner = partners.find((candidate) => String(candidate['UEI Number'] || '').trim().toUpperCase() === String(uei || '').trim().toUpperCase())
  if (!partner) throw Object.assign(new Error('Partner was not found in PartnersTable'), { status: 404 })
  const link = String(partner[PARTNER_FOLDER_HEADER] || partner[LEGACY_PARTNER_FOLDER_HEADER] || '').trim()
  if (!link) throw Object.assign(new Error('Link this partner to its SharePoint folder before uploading files'), { status: 409 })
  const { body: folder } = await graphResponse(
    `https://graph.microsoft.com/v1.0/shares/${encodedSharingUrl(link)}/driveItem?$select=id,name,webUrl,parentReference,folder`,
    token,
    { headers: { Prefer: 'redeemSharingLinkIfNecessary' } },
  )
  if (!folder?.folder || folder.parentReference?.driveId !== driveId) {
    throw Object.assign(new Error('The partner folder link does not point to the configured SharePoint library'), { status: 403 })
  }
  const rootPath = fullItemPath(root)
  const folderPath = fullItemPath(folder)
  if (folder.parentReference?.id !== root.id || !folderPath.startsWith(`${rootPath}/`)) {
    throw Object.assign(new Error(`The partner folder must be a direct child of ${PARTNERS_ROOT_NAME}`), { status: 403 })
  }
  return { token, driveId, root, folder, partner }
}

export async function listPartnerWorkspaceChildren(env, uei, parentId = '') {
  const context = await partnerFolder(env, uei)
  const requested = parentId ? await getItem(env, context.token, context.driveId, parentId) : context.folder
  const rootPath = fullItemPath(context.folder)
  const requestedPath = fullItemPath(requested)
  if (requestedPath !== rootPath && !requestedPath.startsWith(`${rootPath}/`)) {
    throw Object.assign(new Error('The requested folder is outside this partner workspace'), { status: 403 })
  }
  if (!requested.folder) throw Object.assign(new Error('The requested SharePoint item is not a folder'), { status: 400 })
  const items = await listChildren(context.token, context.driveId, requested.id)
  return {
    parent: { id: requested.id, name: requested.name, webUrl: requested.webUrl || '' },
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      webUrl: item.webUrl || '',
      type: item.folder ? 'folder' : 'file',
      childCount: Number(item.folder?.childCount || 0),
      size: Number(item.size || 0),
      mimeType: item.file?.mimeType || '',
      lastModifiedDateTime: item.lastModifiedDateTime || '',
    })),
  }
}

export async function createPartnerUploadSession(env, uei, file) {
  const validation = opportunityUploadValidation(file?.fileName, file?.fileSize)
  if (!validation.valid) throw Object.assign(new Error(validation.error), { status: 400 })
  const context = await partnerFolder(env, uei)
  const { body } = await graphResponse(
    `https://graph.microsoft.com/v1.0/drives/${context.driveId}/items/${context.folder.id}:/${encodeURIComponent(validation.name)}:/createUploadSession`,
    context.token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: validation.name } }),
    },
  )
  if (!body?.uploadUrl) throw new Error(`SharePoint did not create an upload session for ${validation.name}`)
  return {
    uploadUrl: body.uploadUrl,
    expirationDateTime: body.expirationDateTime || '',
    fileName: validation.name,
    folder: { id: context.folder.id, name: context.folder.name, webUrl: context.folder.webUrl || '' },
  }
}

export async function removePartnerUploads(env, uei, itemIds) {
  const context = await partnerFolder(env, uei)
  const ids = [...new Set((itemIds || []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 20)
  let removed = 0
  for (const itemId of ids) {
    try {
      const item = await getItem(env, context.token, context.driveId, itemId)
      if (item?.parentReference?.id !== context.folder.id || item?.folder) continue
      await graphResponse(`https://graph.microsoft.com/v1.0/drives/${context.driveId}/items/${encodeURIComponent(itemId)}`, context.token, { method: 'DELETE' })
      removed += 1
    } catch (error) {
      console.warn(JSON.stringify({ event: 'partner_upload_cleanup_failed', uei, itemId, message: error.message }))
    }
  }
  return { removed }
}
