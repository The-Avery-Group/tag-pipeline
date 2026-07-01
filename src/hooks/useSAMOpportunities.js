import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  getSAMOpportunities, updateSAMOpportunity,
  getContacts, addContact, addOpportunity,
  getSAMNAICS, getSAMSettings,
  getToken,
} from '@/services/graphService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

async function retryThrice(fn) {
  let lastErr
  for (let i = 0; i < 3; i++) {
    try { return await fn() } catch (err) { lastErr = err }
  }
  throw lastErr
}

// ── POC parser ────────────────────────────────────────────────────────────
function parsePOC(pocStr) {
  if (!pocStr) return { name: '', email: '', phone: '' }
  const parts = String(pocStr).split('|').map((s) => s.trim())
  return { name: parts[0] || '', email: parts[1] || '', phone: parts[2] || '' }
}

// ── Worker status checks ──────────────────────────────────────────────────
export async function checkSAMKeyExpired() {
  if (!WORKER_URL) return false
  try {
    const res = await fetch(`${WORKER_URL}/sam/key-status`)
    if (!res.ok) return false
    return (await res.json()).expired === true
  } catch { return false }
}

export async function getSAMRunStatus() {
  if (!WORKER_URL) return null
  try {
    const res = await fetch(`${WORKER_URL}/sam/run-status`)
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

// ── Hook ──────────────────────────────────────────────────────────────────
export function useSAMOpportunities() {
  const [opportunities, setOpportunities] = useState([])
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState(null)

  // Tracks status changes that have been written locally but not yet
  // confirmed by a server read. Without this, the background poll (or any
  // other hook's invalidateCache() call anywhere in the app) can land
  // mid-flight with stale data and clobber the optimistic state — causing
  // a dismissed row to flicker: vanish, reappear, then vanish again once
  // the real write is finally reflected. Keyed by _rowIndex -> Status.
  const pendingStatus = useRef(new Map())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await getSAMOpportunities()
      const reconciled = rows.map((row) => {
        const pending = pendingStatus.current.get(row._rowIndex)
        if (pending === undefined) return row
        if (row.Status === pending) {
          // Server has caught up with the optimistic change — stop tracking it
          pendingStatus.current.delete(row._rowIndex)
          return row
        }
        // Server hasn't caught up yet — keep showing the optimistic status
        return { ...row, Status: pending }
      })
      setOpportunities(reconciled)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => onCacheRefresh(load), [load])

  // ── Contact lookup or create ─────────────────────────────────────────
  const resolveContact = useCallback(async (poc, agency, department) => {
    if (!poc.name && !poc.email) return null
    const allContacts = await getContacts()

    // 1. Email match
    if (poc.email) {
      const byEmail = allContacts.find(
        (c) => c.Email && c.Email.trim().toLowerCase() === poc.email.toLowerCase()
      )
      if (byEmail) return byEmail.Name
    }

    // 2. Name match
    if (poc.name) {
      const byName = allContacts.find(
        (c) => c.Name && c.Name.trim().toLowerCase() === poc.name.toLowerCase()
      )
      if (byName) return byName.Name
    }

    // 3. Create new contact
    await addContact({
      Name:         poc.name  || poc.email || 'Unknown',
      Email:        poc.email || '',
      Phone:        poc.phone || '',
      Agency:       agency     || '',
      Organization: department || '',
      Type:         'Government',
      Title:        '',
      Notes:        '',
    })
    return poc.name || poc.email || 'Unknown'
  }, [])

  // ── Debounced cache invalidation ────────────────────────────────────
  // Prevents rapid-fire dismissals from each triggering a full cache reload,
  // which causes visible table flicker. The cache is refreshed once, 800ms
  // after the last status update in a burst.
  const invalidateRef = useRef(null)
  const debouncedInvalidate = useCallback(() => {
    if (invalidateRef.current) clearTimeout(invalidateRef.current)
    invalidateRef.current = setTimeout(() => {
      invalidateCache().catch(() => {})
      invalidateRef.current = null
    }, 800)
  }, [])

  // ── Optimistic status update ─────────────────────────────────────────
  // No rollback on failure — visual state stays changed for smooth UX.
  // Retries 3 times silently; throws after that so caller can toast.
  const updateStatus = useCallback(async (rowIndex, status) => {
    pendingStatus.current.set(rowIndex, status)
    setOpportunities((prev) =>
      prev.map((o) => o._rowIndex === rowIndex ? { ...o, Status: status } : o)
    )
    try {
      await retryThrice(() => updateSAMOpportunity(rowIndex, { Status: status }))
      debouncedInvalidate()
    } catch (err) {
      // No visual rollback — visual state stays changed for smooth UX.
      // The pending override is intentionally NOT cleared here: it keeps
      // reconciling to the optimistic value until a future refresh shows
      // the server genuinely agrees (e.g. after a manual retry), consistent
      // with the "no rollback on failure" behavior this hook already had.
      throw err
    }
  }, [debouncedInvalidate])

  // ── Add to pipeline ──────────────────────────────────────────────────
  const addToPipeline = useCallback(async (row, outlook = 'New') => {
    const poc = parsePOC(row['Point of Contact'])
    const contactName = await resolveContact(poc, row['Agency'], row['Department'])

    await addOpportunity({
      'TAG Opportunity Phase':                   'Identified',
      'Opportunity Outlook':                     outlook,
      'Contract Number / Notice ID':             row['Solicitation Number'] || row['Notice ID'] || '',
      'Project Title / Description*':            row['Title']               || '',
      'Solicitation Number':                     row['Solicitation Number'] || '',
      'Set- Aside*':                             row['Set-Aside Type']      || '',
      'Department*':                             row['Department']          || '',
      'Agency*':                                 row['Agency']              || '',
      'Office*':                                 row['Office']              || '',
      'NAICS Code*':                             row['NAICS Code']          || '',
      'Contracting Officer / Specialist (POC)*': contactName                || '',
    })

    await updateStatus(row._rowIndex, outlook === 'Tracking' ? 'tracked' : 'added_to_pipeline')
  }, [resolveContact, updateStatus])

  // ── Trigger SAM pull ─────────────────────────────────────────────────
  // force=true bypasses the 12h throttle (used by Settings page force pull)
  const triggerPull = useCallback(async ({ force = false } = {}) => {
    if (!WORKER_URL) throw new Error('VITE_API_BASE_URL not set')
    const secret = import.meta.env.VITE_SAM_TRIGGER_SECRET
    if (!secret) throw new Error('VITE_SAM_TRIGGER_SECRET not set')

    // Get the user's current MSAL token
    const token = await getToken()

    // Read SAM config from the workbook (frontend already has access)
    const [naicsCodes, settings] = await Promise.all([getSAMNAICS(), getSAMSettings()])

    if (!naicsCodes.length) throw new Error('No NAICS codes found in SAMNAICSTable')

    const res = await fetch(`${WORKER_URL}/sam/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Trigger-Secret': secret,
      },
      body: JSON.stringify({
        token,
        config: {
          naicsCodes,
          skipDays:   settings.skipDays,
          windowDays: settings.windowDays,
        },
        force,
      }),
    })

    const data = await res.json()

    if (!res.ok) throw new Error(data.error || `Worker returned ${res.status}`)

    // If throttled, return the throttle info so the UI can show the message
    if (data.throttled) return { throttled: true, message: data.message, lastRun: data.lastRun }

    // Pull started in background — reload opportunities after a short delay
    // so the user sees updated data without having to refresh manually
    setTimeout(async () => {
      await invalidateCache()
    }, 5000)

    return { throttled: false, message: data.message }
  }, [])

  const dismiss   = useCallback((rowIndex) => updateStatus(rowIndex, 'dismissed'), [updateStatus])
  const undismiss = useCallback((rowIndex) => updateStatus(rowIndex, 'new'),       [updateStatus])

  // Stable reference — only changes when data actually changes.
  // Prevents parent components from re-rendering (and scroll containers
  // from resetting) when unrelated state like selectedRows changes.
  const stableOpportunities = useMemo(() => opportunities, [opportunities])

  return {
    opportunities: stableOpportunities,
    loading,
    error,
    refresh: load,
    addToPipeline,
    dismiss,
    undismiss,
    updateStatus,
    triggerPull,
  }
}
