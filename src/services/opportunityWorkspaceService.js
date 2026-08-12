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

export function getOpportunityWorkspace(opportunityKey) {
  return workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}`)
}

export function retryOpportunityWorkspace(opportunityKey) {
  return workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}/retry`, { method: 'POST' })
}

export function listOpportunityWorkspaceFiles(opportunityKey, parentId = '') {
  const query = parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''
  return workerJson(`/opportunity-workspaces/${encodeURIComponent(opportunityKey)}/files${query}`)
}
