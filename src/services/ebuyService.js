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
  query.set('all', 'true')
  return workerJson(`/ebuy/opportunities?${query.toString()}`, { cache: 'no-store' })
}

export async function getEbuyOpportunity(requestId) {
  return workerJson(`/ebuy/opportunities/${encodeURIComponent(requestId)}`, { cache: 'no-store' })
}

export async function analyzeEbuyOpportunityDocuments(requestId) {
  return workerJson(`/ebuy/opportunities/${encodeURIComponent(requestId)}/analysis`, { method: 'POST' })
}

export async function getEbuyOpportunityDocumentAnalysis(requestId) {
  return workerJson(`/ebuy/opportunities/${encodeURIComponent(requestId)}/analysis`, { cache: 'no-store' })
}

export async function reviewEbuyOpportunityDocumentFinding(requestId, review) {
  return workerJson(`/ebuy/opportunities/${encodeURIComponent(requestId)}/analysis/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(review),
  })
}

export async function updateEbuyOpportunityState(requestId, reviewState, pipelineContractId = null) {
  return workerJson(`/ebuy/opportunities/${encodeURIComponent(requestId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewState, pipelineContractId }),
  })
}

export async function connectEbuyAccount(credentials) {
  return workerJson('/ebuy/connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  })
}

export async function testEbuyConnection() {
  return workerJson('/ebuy/connection/test', { method: 'POST' })
}

export async function disconnectEbuyAccount() {
  return workerJson('/ebuy/connection', { method: 'DELETE' })
}

export async function startEbuyLiveSync() {
  return workerJson('/ebuy/sync', { method: 'POST' })
}

export async function reconcileEbuyPipeline(pipeline = []) {
  return workerJson('/ebuy/pipeline/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipeline }),
  })
}

export async function unlinkEbuyPipelineOpportunity(pipelineContractId) {
  return workerJson('/ebuy/pipeline/unlink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipelineContractId }),
  })
}
