import { workerJson } from '@/services/workerClient'
import { getPartnerResearch, savePartnerResearch, getSheetRows, invalidateTables } from '@/services/graphService'
import { publishCacheUpdate } from '@/services/dataCache'
import { fetchPartnerAwardEvidence } from './usaSpendingService.js'
import { partnerRefreshDue, partnerRefreshEnabled, partnerRefreshQueue } from '../utils/partnerGroups.js'
import { mergeContractVehicleRules, resolveContractVehicle } from '../../workers/tag-pipeline-api/src/lib/contractVehicleResolver.js'

const autoAttempts = new Map()
let samReferencesPromise = null
let samReferencesAt = 0

function cachedSAMContracts() {
  if (!samReferencesPromise || Date.now() - samReferencesAt > 300_000) {
    samReferencesAt = Date.now()
    // Read saved discovery only. Never start a SAM pull or request enrichment.
    samReferencesPromise = workerJson('/sam/expiring-contracts/results?range=all&includeHidden=1')
      .then(result => result.contracts || [])
      .catch(error => { samReferencesPromise = null; throw error })
  }
  return samReferencesPromise
}

export async function getPartnerEnrichment(uei) {
  const result = await getPartnerResearch(uei)
  return { ...result, uei }
}

export function refreshPartnerEnrichment(uei, { automatic = false, name = '', partnerId = '' } = {}) {
  uei = String(uei || '').trim().toUpperCase()
  return partnerRefreshQueue.enqueue(uei, name, async onProgress => {
  const run = async () => {
    const saved = await getPartnerEnrichment(uei)
    if (partnerId && saved.partner['Partner ID'] !== partnerId) throw new Error('Partner UEI changed while queued. Refresh the current partner instead.')
    if (!partnerRefreshEnabled(saved.partner)) return { ...saved, skipped: true }
    if (automatic && (!partnerRefreshDue(saved.partner) || Date.now() - (autoAttempts.get(uei) || 0) < 3600_000)) return { ...saved, skipped: true }
    autoAttempts.set(uei, Date.now())
    onProgress('Reading USAspending…')
    const evidence = await fetchPartnerAwardEvidence(uei, { onProgress })
    const cachedContracts = await cachedSAMContracts()
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
    const references = [...(evidence.references || []), ...cachedContracts
      .filter(contract => String(contract.incumbentUEI || '').trim().toUpperCase() === uei && contract.referencedIdvPiid)
      .map(contract => ({ piid: contract.referencedIdvPiid, agency: contract.referencedIdvAgencyCode || '', source: 'Cached SAM', sourceAwardId: contract.familyKey }))]
    const seen = new Set()
    for (const ref of references) {
      const key = `${ref.agency}:${ref.piid}`
      if (seen.has(key)) continue
      seen.add(key)
      const direct = evidence.details.filter(detail => detail.piid === ref.piid && (!ref.agency || detail.generated_unique_award_id.endsWith(`_${ref.agency}`)))
      if (direct.length === 1) continue
      vehicles.push({
        'Record ID': `${uei}:REF:${key}`, 'Partner UEI': uei,
        'Vehicle Name': resolveContractVehicle(ref.piid, rules).vehicleName || '', PIID: ref.piid,
        Relationship: `Referenced by partner award (${ref.source})`,
        'Current End Date': '', 'Potential End Date': '', 'Last Date to Order': '',
        'Source Link': ref.source === 'USAspending' ? `https://www.usaspending.gov/award/${encodeURIComponent(ref.sourceAwardId)}` : '',
        'Last Seen': evidence.checkedAt, Status: 'Parent reference only; direct holding and ordering eligibility not verified',
      })
    }
    onProgress('Saving to workbook…')
    await savePartnerResearch({ ...evidence, partnerId: saved.partner['Partner ID'], vehicles })
    await publishCacheUpdate(['PartnersTable', 'PartnerVehiclesTable'])
    return getPartnerEnrichment(uei)
  }
  // One tab performs publication at a time. Quarterly eligibility is re-read
  // after acquiring the lock so another tab's completed refresh is respected.
  return globalThis.navigator?.locks
    ? navigator.locks.request('tag-partner-research', run)
    : run()
  }, partnerId)
}

export function refreshAllPartnerEnrichment(partners) {
  const unique = new Map(partners.filter(partner => partnerRefreshEnabled(partner) && /^[A-Z0-9]{12}$/.test(String(partner['UEI Number'] || '').trim().toUpperCase())).map(partner => [String(partner['UEI Number']).trim().toUpperCase(), partner]))
  // All jobs enter synchronously; failures are visible in the shared queue.
  return Promise.allSettled([...unique].map(([uei, partner]) => refreshPartnerEnrichment(uei, { name: partner['Partner Name'], partnerId: partner['Partner ID'] })))
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
