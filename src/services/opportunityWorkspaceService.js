import { workerJson } from '@/services/workerClient'

function opportunityPayload(opportunity, overrides = {}) {
  const pipelineId = String(opportunity?.['Contract Number / Notice ID'] || overrides.pipelineId || '').trim()
  return {
    opportunityKey: pipelineId,
    pipelineId,
    noticeId: overrides.noticeId || opportunity?._workspaceNoticeId || '',
    solicitationNumber: overrides.solicitationNumber || opportunity?.['Solicitation Number'] || '',
    title: opportunity?.['Project Title / Description*'] || '',
    department: opportunity?.['Department*'] || '',
    agency: opportunity?.['Agency*'] || '',
    noticeType: opportunity?.['Notice Type'] || '',
    folderLink: opportunity?.['Link to Folder'] || '',
    calendarYear: new Date().getFullYear(),
  }
}

export function requestOpportunityWorkspace(opportunity, overrides = {}) {
  return workerJson('/opportunity-workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opportunityPayload(opportunity, overrides)),
  })
}

export function connectOpportunityWorkspaceFolder(opportunity) {
  return workerJson('/opportunity-workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...opportunityPayload(opportunity), adoptFolderLink: true }),
  })
}

export function getOpportunityWorkspace(opportunityKey) {
  return workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}`)
}

export function shareRelatedOpportunityWorkspace(leftOpportunityKey, rightOpportunityKey, relationshipType) {
  return workerJson('/opportunity-workspaces/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leftOpportunityKey, rightOpportunityKey, relationshipType }),
  })
}

export function deleteOpportunityWorkspace(opportunityKey, { deleteSharePoint = false } = {}) {
  return workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleteSharePoint }),
  })
}

export function retryOpportunityWorkspace(opportunityKey, opportunity = null) {
  return workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opportunity ? opportunityPayload(opportunity) : {}),
  })
}

export function listOpportunityWorkspaceFiles(opportunityKey, parentId = '') {
  const query = parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''
  return workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}/files${query}`)
}

function dossierFileSource(path) {
  const topLevelFolder = String(path || '').split('/').filter(Boolean)[0] || ''
  if (topLevelFolder === '2. RFI Documents') return 'Source documents'
  if (topLevelFolder === '7. Reference Materials') return 'Reference material'
  return 'Workspace'
}

async function buildFlatFileIndexFromFolderListings(opportunityKey) {
  const { workspace } = await getOpportunityWorkspace(opportunityKey)
  const folders = [{ id: '', path: '' }]
  const files = []
  let folderIndex = 0
  let rootListing = null

  // Compatibility path for a frontend deployed before the Worker's dedicated
  // file-index route. Keep the same bounds as the Worker-side index so an
  // unusually large workspace cannot cause unbounded browser requests.
  while (folderIndex < folders.length && folderIndex < 45 && files.length < 5000) {
    const folder = folders[folderIndex]
    folderIndex += 1
    let listing
    try {
      listing = await listOpportunityWorkspaceFiles(opportunityKey, folder.id)
    } catch (error) {
      if (error.status === 404) {
        const missing = new Error('The SharePoint workspace folder could not be found. Open Opportunity files and repair the workspace.')
        missing.status = 404
        missing.code = 'workspace_folder_missing'
        throw missing
      }
      throw error
    }
    if (!rootListing) rootListing = listing
    for (const item of listing.items || []) {
      const path = [folder.path, item.name].filter(Boolean).join('/')
      if (item.type === 'folder') {
        folders.push({ id: item.id, path })
        continue
      }
      files.push({
        ...item,
        path,
        folderPath: folder.path,
        source: dossierFileSource(path),
      })
    }
  }

  return {
    workspace: {
      webUrl: rootListing?.parent?.webUrl || workspace?.webUrl || '',
      name: rootListing?.parent?.name || workspace?.title || '',
    },
    files: files.sort((left, right) => String(right.lastModifiedDateTime || '').localeCompare(String(left.lastModifiedDateTime || ''))),
    count: files.length,
    partial: folderIndex < folders.length || files.length >= 5000,
    indexedAt: new Date().toISOString(),
    compatibilityMode: true,
  }
}

export async function listOpportunityWorkspaceFlatFiles(opportunityKey) {
  try {
    return await workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}/file-index`)
  } catch (error) {
    if (error.status !== 404) throw error
    return buildFlatFileIndexFromFolderListings(opportunityKey)
  }
}

export function createOpportunityReferenceUpload(opportunityKey, file) {
  return workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      contentType: file.type || 'application/octet-stream',
    }),
  })
}

export function removeOpportunityReferenceUploads(opportunityKey, itemIds) {
  return workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}/uploads/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds }),
  })
}

export function analyzeOpportunityDocuments(opportunityKey) {
  return workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}/analysis`, { method: 'POST' })
}

export function getOpportunityDocumentAnalysis(opportunityKey) {
  return workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}/analysis`)
}
