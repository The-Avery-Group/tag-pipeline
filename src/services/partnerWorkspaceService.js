import { workerJson } from '@/services/workerClient'

export function scanPartnerWorkspaceFolders() {
  return workerJson('/partner-workspaces/migration/scan', { method: 'POST' })
}

export function applyPartnerWorkspaceLinks(mappings) {
  return workerJson('/partner-workspaces/migration/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mappings }),
  })
}

export function listPartnerWorkspaceFiles(uei, parentId = '') {
  const query = parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''
  return workerJson(`/partner-workspaces/${encodeURIComponent(uei)}/files${query}`)
}

export function createPartnerReferenceUpload(uei, file) {
  return workerJson(`/partner-workspaces/${encodeURIComponent(uei)}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      contentType: file.type || 'application/octet-stream',
    }),
  })
}

export function removePartnerReferenceUploads(uei, itemIds) {
  return workerJson(`/partner-workspaces/${encodeURIComponent(uei)}/uploads/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds }),
  })
}
