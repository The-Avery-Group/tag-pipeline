import { dateOnly } from './opportunityDates.js'

// The partner refresh timestamp records a successful check of the snapshot.
// Do not rewrite every vehicle just to advance its observation timestamp.
export function partnerVehicleNeedsUpdate(existing, incoming) {
  return Object.entries(incoming).some(([key, value]) => {
    if (key === 'Last Seen') return false
    const previous = existing[key]
    if (['Current End Date', 'Potential End Date', 'Last Date to Order'].includes(key)) {
      return dateOnly(previous) !== dateOnly(value)
    }
    return String(previous ?? '') !== String(value ?? '')
  })
}

export function partnerVehicleHasEnded(vehicle, today = dateOnly(new Date())) {
  return ['Ordering Period End Date', 'Last Date to Order', 'Current End Date'].some(field => {
    const value = vehicle[field]
    if (value === null || value === undefined || String(value).trim() === '') return false
    const date = dateOnly(value)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
    const parsed = new Date(`${date}T00:00:00Z`)
    // Ignore invalid dates instead of silently rolling them into another month.
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date && date < today
  })
}

// Exact contract distinctions verified against the cited published records.
// Do not extend these to adjacent PIIDs or infer pools from arbitrary digits.
const CONTRACT_DISTINCTIONS = {
  GS00Q14OADU101: ['OASIS', 'Unrestricted · Pool 1', 'https://downloads.regulations.gov/FNS-2021-0038-0022/attachment_1.pdf'],
  GS00Q14OADU202: ['OASIS', 'Unrestricted · Pool 2', 'https://downloads.regulations.gov/FNS-2021-0038-0022/attachment_1.pdf'],
  GS00Q14OADU301: ['OASIS', 'Unrestricted · Pool 3', 'https://downloads.regulations.gov/FNS-2021-0038-0022/attachment_1.pdf'],
  '47QFCA22D0067': ['ASTRO', 'Mission Operations Pool', 'https://aas.gsa.gov/assets/pdf_docs/contractors/LinQuest%20Corporation.pdf'],
  '47QFCA22D0422': ['ASTRO', 'Support Pool', 'https://aas.gsa.gov/assets/pdf_docs/contractors/LinQuest%20Corporation.pdf'],
}

export function partnerVehicleDistinction(vehicle, resolution) {
  if (resolution?.status !== 'RESOLVED') return { label: '', source: '' }
  const name = String(resolution.vehicleName || '').trim().toLowerCase()
  if (name !== String(vehicle['Vehicle Name'] || '').trim().toLowerCase()) return { label: '', source: '' }
  const exact = CONTRACT_DISTINCTIONS[String(vehicle.PIID || '').toUpperCase().replace(/[^A-Z0-9]/g, '')]
  if (exact && exact[0].toLowerCase() === name) return { label: exact[1], source: exact[2] }
  return { label: String(resolution.vehicleVariant || '').trim(), source: resolution.source || '' }
}

// Explicit workbook grouping, never inferred from similar names or UEIs.
export function groupPartnerVehicles(vehicles = []) {
  const groups = new Map()
  for (const vehicle of vehicles) {
    const name = String(vehicle['Vehicle Name'] || '').trim().replace(/\s+/g, ' ')
    const resolved = name && name.toLowerCase() !== 'unresolved vehicle'
    const key = resolved ? `name:${name.toLowerCase()}` : `unresolved:${vehicle.PIID || vehicle['Record ID']}`
    if (!groups.has(key)) groups.set(key, { key, name: resolved ? name : 'Unresolved vehicle', vehicles: [] })
    groups.get(key).vehicles.push(vehicle)
  }
  return [...groups.values()]
}

export function partnerRefreshEnabled(partner) {
  return ['', 'yes'].includes(String(partner?.['USAspending Enabled'] || '').trim().toLowerCase())
}

export function partnerRefreshDue(partner, now = new Date()) {
  if (!partnerRefreshEnabled(partner) || !/^[A-Z0-9]{12}$/.test(String(partner?.['UEI Number'] || '').trim().toUpperCase())) return false
  const last = new Date(partner?.['USAspending Refreshed At'] || '')
  const quarterStart = Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1)
  return !Number.isFinite(last.getTime()) || last.getTime() < quarterStart
}

// Browser-session queue. It belongs to the app, not a mounted partner page.
export function createPartnerRefreshQueue() {
  const jobs = new Map(); const listeners = new Set()
  let snapshot = []; let tail = Promise.resolve()
  const emit = () => {
    snapshot = [...jobs.values()].map(({ uei, partnerId, name, status, progress, error }) => ({ uei, partnerId, name, status, progress, error }))
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    remove(key) {
      const job = jobs.get(key)
      if (!job || job.status !== 'queued') return false
      job.status = 'cancelled'; job.progress = 'Removed from queue'
      emit()
      return true
    },
    removeWaiting() {
      for (const job of jobs.values()) if (job.status === 'queued') {
        job.status = 'cancelled'; job.progress = 'Removed from queue'
      }
      emit()
    },
    clearFinished: () => { for (const [uei, job] of jobs) if (!['queued', 'running'].includes(job.status)) jobs.delete(uei); emit() },
    enqueue(uei, name, operation, partnerId = '') {
      uei = String(uei || '').trim().toUpperCase()
      if (!/^[A-Z0-9]{12}$/.test(uei)) return Promise.reject(new Error('A valid 12-character UEI is required'))
      const key = partnerId || uei
      const existing = jobs.get(key)
      if (existing && ['queued', 'running'].includes(existing.status)) return existing.promise
      const job = { uei, partnerId, name: name || uei, status: 'queued', progress: 'Waiting to refresh', error: '' }
      jobs.set(key, job)
      const execute = async () => {
        if (job.status === 'cancelled') return { skipped: true, cancelled: true }
        job.status = 'running'; job.progress = 'Checking saved information…'; emit()
        try {
          const result = await operation(message => { job.progress = message; emit() })
          job.status = result?.skipped ? 'skipped' : 'complete'
          job.progress = result?.skipped ? 'No refresh needed' : 'Saved to workbook'
          return result
        } catch (error) {
          job.status = 'failed'; job.error = error.message; job.progress = 'Needs attention'
          throw error
        } finally { emit() }
      }
      job.promise = tail.then(execute)
      // A failure must not reject the queue tail or block the next partner.
      tail = job.promise.catch(() => {})
      emit()
      return job.promise
    },
  }
}

export const partnerRefreshQueue = createPartnerRefreshQueue()

export function partnerGroupKey(partner) {
  const group = String(partner?.['Partner Group'] || '').trim()
  return group ? `group:${group.toLocaleLowerCase()}` : `entity:${partner?.['Partner ID'] || partner?.['UEI Number'] || ''}`
}

export function groupPartners(partners) {
  const groups = new Map()
  for (const partner of partners) {
    const key = partnerGroupKey(partner)
    if (!groups.has(key)) groups.set(key, { key, name: String(partner['Partner Group'] || partner['Partner Name'] || '').trim(), members: [] })
    groups.get(key).members.push(partner)
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function partnerProfilePath(partner) {
  return `/partners?partner=${encodeURIComponent(String(partner['Partner ID'] || partner['UEI Number'] || '').trim())}`
}

export function sharedPartnerWorkspace(members) {
  const linked = members.filter(p => String(p['Link to Partner Folder'] || '').trim())
  const links = new Set(linked.map(p => String(p['Link to Partner Folder']).trim().replace(/\/$/, '')))
  // Conflicting folders are deliberately not merged or silently reassigned.
  return { partner: links.size === 1 ? linked[0] : null, conflict: links.size > 1 }
}
