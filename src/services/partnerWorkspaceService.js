import { workerJson } from '@/services/workerClient'
import { getPartnerResearch, savePartnerResearch, getSheetRows, invalidateTables } from '@/services/graphService'
import { publishCacheUpdate } from '@/services/dataCache'
import { fetchPartnerAwardEvidence } from './usaSpendingService.js'
import { partnerRefreshDue, partnerRefreshEnabled } from '../utils/partnerGroups.js'
import { mergeContractVehicleRules, resolveContractVehicle } from '../../workers/tag-pipeline-api/src/lib/contractVehicleResolver.js'

const refreshes = new Map()
const autoAttempts = new Map()

export async function getPartnerEnrichment(uei) {
  const result = await getPartnerResearch(uei)
  return { ...result, uei }
}

export function refreshPartnerEnrichment(uei, { automatic = false, onProgress = () => {} } = {}) {
  if (refreshes.has(uei)) return refreshes.get(uei)
  const run = async () => {
    const saved = await getPartnerEnrichment(uei)
    if (!partnerRefreshEnabled(saved.partner)) return saved
    if (automatic && (!partnerRefreshDue(saved.partner) || Date.now() - (autoAttempts.get(uei) || 0) < 3600_000)) return saved
    autoAttempts.set(uei, Date.now())
    onProgress('Reading USAspending…')
    const evidence = await fetchPartnerAwardEvidence(uei, { onProgress })
    invalidateTables(['ContractVehicleRulesTable'])
    let workbookRules
    try { workbookRules = await getSheetRows('ContractVehicleRulesTable') }
    catch (error) { if (error.status !== 404) throw error; workbookRules = [] }
    const rules = mergeContractVehicleRules(workbookRules)
    const vehicles = evidence.details.map(detail => {
      const dates = detail.period_of_performance || {}
      return {
        'Record ID': `${uei}:${detail.generated_unique_award_id}`, 'Partner UEI': uei,
        'Vehicle Name': resolveContractVehicle(detail.piid, rules).vehicleName || '', PIID: detail.piid,
        Relationship: 'Direct award recipient',
        'Current End Date': String(dates.end_date || '').slice(0, 10),
        'Potential End Date': String(dates.potential_end_date || '').slice(0, 10),
        'Last Date to Order': String(dates.last_date_to_order || detail.last_date_to_order || detail.latest_transaction_contract_data?.last_date_to_order || '').slice(0, 10),
        'Source Link': `https://www.usaspending.gov/award/${encodeURIComponent(detail.generated_unique_award_id)}`,
        'Last Seen': evidence.checkedAt, Status: 'Reported; ordering eligibility not verified',
      }
    })
    onProgress('Saving to workbook…')
    await savePartnerResearch({ ...evidence, vehicles })
    await publishCacheUpdate(['PartnersTable', 'PartnerVehiclesTable'])
    return getPartnerEnrichment(uei)
  }
  // One tab performs publication at a time. Quarterly eligibility is re-read
  // after acquiring the lock so another tab's completed refresh is respected.
  const promise = (globalThis.navigator?.locks
    ? navigator.locks.request('tag-partner-research', run)
    : run()).finally(() => refreshes.delete(uei))
  refreshes.set(uei, promise)
  return promise
}

export function createPartnerFolder(uei) {
  return workerJson(`/partner-workspaces/${encodeURIComponent(uei)}/folder`, { method: 'POST' })
}

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
