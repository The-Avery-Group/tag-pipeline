import { workerJson } from '@/services/workerClient'

function queryFor(input = {}) {
  const query = new URLSearchParams()
  if (input.noticeId) query.set('noticeId', input.noticeId)
  if (input.solicitationNumber) query.set('solicitationNumber', input.solicitationNumber)
  return query
}

export function getSAMOpportunityDetail(input) {
  return workerJson(`/sam/opportunity?${queryFor(input).toString()}`, { cache: 'no-store' })
}

export function startSAMOpportunityArchive(input, { force = false } = {}) {
  return workerJson('/sam/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, force }),
  })
}

export function getSAMOpportunityArchiveStatus(opportunityKey) {
  return workerJson(`/sam/archive/status?key=${encodeURIComponent(opportunityKey)}`, { cache: 'no-store' })
}

export function updateSAMOpportunityArchiveReview(input, reviewState) {
  return workerJson('/sam/archive/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, reviewState }),
  })
}

