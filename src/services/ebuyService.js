import { workerJson } from '@/services/workerClient'
export { ebuyToPipelineRecord } from '@/utils/ebuyHelpers'

export async function getEbuyStatus() {
  return workerJson('/ebuy/status', { cache: 'no-store' })
}

export async function listEbuyOpportunities(options = {}) {
  const query = new URLSearchParams()
  if (options.search) query.set('q', options.search)
  if (options.type && options.type !== 'all') query.set('type', options.type)
  if (options.state && options.state !== 'all') query.set('state', options.state)
  if (options.lifecycle && options.lifecycle !== 'all') query.set('lifecycle', options.lifecycle)
  if (options.includeDismissed) query.set('includeDismissed', 'true')
  query.set('page', String(options.page || 1))
  query.set('limit', String(options.limit || 25))
  return workerJson(`/ebuy/opportunities?${query.toString()}`, { cache: 'no-store' })
}

export async function getEbuyOpportunity(requestId) {
  return workerJson(`/ebuy/opportunities/${encodeURIComponent(requestId)}`, { cache: 'no-store' })
}

export async function updateEbuyOpportunityState(requestId, reviewState, pipelineContractId = null) {
  return workerJson(`/ebuy/opportunities/${encodeURIComponent(requestId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewState, pipelineContractId }),
  })
}

export async function startEbuyFixtureSync() {
  return workerJson('/ebuy/sync/fixture', { method: 'POST' })
}

export async function archiveEbuyTestAttachment() {
  return workerJson('/ebuy/archive/test-attachment', { method: 'POST' })
}

export async function startManualEbuySync(credentials) {
  return workerJson('/ebuy/sync/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  })
}
