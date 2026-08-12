import { workerJson } from '@/services/workerClient'

export function scanLegacyFolderBatch(cursor = '') {
  return workerJson('/opportunity-workspaces/migration/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor: cursor || null }),
  })
}

export function applyLegacyFolderLinkBatch(links) {
  return workerJson('/opportunity-workspaces/migration/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links }),
  })
}

