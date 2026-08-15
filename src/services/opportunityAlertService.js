import { workerJson } from '@/services/workerClient'

export function getOpportunityAlerts(opportunityKey = '') {
  const query = opportunityKey ? `?opportunityKey=${encodeURIComponent(opportunityKey)}` : ''
  return workerJson(`/opportunity-alerts${query}`)
}

export function acknowledgeOpportunityAlert(opportunityKey, type, fingerprint = '') {
  return workerJson(`/opportunity-alerts/${encodeURIComponent(opportunityKey)}/${encodeURIComponent(type)}/acknowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fingerprint }),
  })
}
