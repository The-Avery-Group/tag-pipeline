// Explicit workbook grouping, never inferred from similar names or UEIs.
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
    snapshot = [...jobs.values()].map(({ uei, name, status, progress, error }) => ({ uei, name, status, progress, error }))
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    clearFinished: () => { for (const [uei, job] of jobs) if (!['queued', 'running'].includes(job.status)) jobs.delete(uei); emit() },
    enqueue(uei, name, operation) {
      uei = String(uei || '').trim().toUpperCase()
      if (!/^[A-Z0-9]{12}$/.test(uei)) return Promise.reject(new Error('A valid 12-character UEI is required'))
      const existing = jobs.get(uei)
      if (existing && ['queued', 'running'].includes(existing.status)) return existing.promise
      const job = { uei, name: name || uei, status: 'queued', progress: 'Waiting to refresh', error: '' }
      jobs.set(uei, job)
      const execute = async () => {
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
  return group ? `group:${group.toLocaleLowerCase()}` : `entity:${partner?.['UEI Number'] || partner?._rowIndex}`
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
  return `/partners?partner=${encodeURIComponent(String(partner['UEI Number'] || '').trim())}`
}

export function sharedPartnerWorkspace(members) {
  const linked = members.filter(p => String(p['Link to Partner Folder'] || '').trim())
  const links = new Set(linked.map(p => String(p['Link to Partner Folder']).trim().replace(/\/$/, '')))
  // Conflicting folders are deliberately not merged or silently reassigned.
  return { partner: links.size === 1 ? linked[0] : null, conflict: links.size > 1 }
}
