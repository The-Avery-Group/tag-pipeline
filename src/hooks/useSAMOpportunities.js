import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  getSAMOpportunities, updateSAMOpportunity,
  getContacts, addContact, addOpportunity,
  getSAMNAICS, getSAMSettings,
  getToken,
} from '@/services/graphService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

// How often to poll /sam/run-status while a pull is actively running.
const POLL_MS = 3000
// A run still reporting status: 'running' after this long is presumed
// stalled — most likely the Worker's background task hit a Cloudflare
// execution-time limit mid-run and was killed before it could write a
// final success/error log. Chosen generously so a legitimately slow but
// still-progressing run isn't mistaken for a stuck one.
const STALL_THRESHOLD_MS = 3 * 60 * 1000

// Module-level (not per-hook-instance) so a stalled-run auto-resume is only
// attempted once per browser session, even if the Opportunities page is
// visited/remounted multiple times — avoids repeatedly re-triggering a pull
// that's stuck for a persistent reason (bad secret, expired key, etc).
let _resumeAttemptedThisSession = false

// Pulls are initiated from both Settings and the New Opportunities tab. Keep
// run state outside individual hook instances so navigation (and a second app
// tab) can immediately render the same Worker-backed progress.
let _sharedPullProgress = null
let _sharedPollTimer = null
let _sharedPollInFlight = false
const _pullProgressListeners = new Set()
const PULL_ORIGIN_STORAGE_KEY = 'tag_sam_pull_origin'

function readStoredPullOrigin() {
  try {
    const origin = JSON.parse(localStorage.getItem(PULL_ORIGIN_STORAGE_KEY) || 'null')
    // A source marker is only meaningful for a current, bounded pull. Ignore
    // an abandoned browser marker rather than mislabelling a later run.
    return origin?.startedAt && Date.now() - origin.startedAt < 15 * 60 * 1000 ? origin : null
  } catch {
    return null
  }
}

let _sharedPullOrigin = typeof window === 'undefined' ? null : readStoredPullOrigin()

function setSharedPullOrigin(origin) {
  _sharedPullOrigin = origin
  try {
    if (origin) localStorage.setItem(PULL_ORIGIN_STORAGE_KEY, JSON.stringify(origin))
    else localStorage.removeItem(PULL_ORIGIN_STORAGE_KEY)
  } catch {}
}

function publishPullProgress(status) {
  if (status?.status === 'success' || status?.status === 'error') setSharedPullOrigin(null)
  _sharedPullProgress = status
  _pullProgressListeners.forEach((listener) => listener(status))
}

function subscribeToPullProgress(listener) {
  _pullProgressListeners.add(listener)
  return () => _pullProgressListeners.delete(listener)
}

function stopSharedPullPolling() {
  if (_sharedPollTimer) {
    clearInterval(_sharedPollTimer)
    _sharedPollTimer = null
  }
}

async function refreshSharedPullProgress() {
  if (_sharedPollInFlight) return
  _sharedPollInFlight = true
  try {
    const status = await getSAMRunStatus()
    publishPullProgress(status)
    if (status?.status === 'success' || status?.status === 'error' || status?.status === 'partial') {
      stopSharedPullPolling()
      await invalidateCache()
    }
  } finally {
    _sharedPollInFlight = false
  }
}

function startSharedPullPolling() {
  if (_sharedPollTimer) return
  _sharedPollTimer = setInterval(refreshSharedPullProgress, POLL_MS)
}

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
  const [failedStatuses, setFailedStatuses] = useState({})

  // Tracks status changes that have been written locally but not yet
  // confirmed by a server read. Without this, the background poll (or any
  // other hook's invalidateCache() call anywhere in the app) can land
  // mid-flight with stale data and clobber the optimistic state — causing
  // a dismissed row to flicker: vanish, reappear, then vanish again once
  // the real write is finally reflected. Keyed by _rowIndex -> Status.
  const pendingStatus = useRef(new Map())

  // ── Pull progress — polling infrastructure ──────────────────────────
  // Live status of an in-progress SAM.gov pull, sourced from the Worker's
  // /sam/run-status endpoint. null when no pull is currently being tracked
  // by this hook instance. Shape: { status: 'running'|'success'|'error',
  // phase: 'fetching'|'writing', naicsProcessed, naicsTotal, toWrite, written, ... }
  const [pullProgress, setPullProgress] = useState(() => _sharedPullProgress)
  const [pullOrigin, setPullOrigin] = useState(() => _sharedPullOrigin)
  const continuingRef = useRef(false)
  // A defensive guard for a bad/legacy Worker status: never keep resuming
  // the exact same cursor after it has twice reported a partial run with no
  // writes. A healthy bounded pull either writes a chunk or moves its cursor.
  const zeroWritePartialsRef = useRef(new Map())

  // Subscribe every mounted consumer to the single shared run state. The
  // poll intentionally survives page navigation, because a Worker pull keeps
  // running after the page that triggered it is left.
  useEffect(() => subscribeToPullProgress((status) => {
    setPullProgress(status)
    setPullOrigin(_sharedPullOrigin)
  }), [])

  // The module-level state covers same-tab navigation. This listener extends
  // the source label to other tabs in the same browser without claiming that
  // an unknown remote run belongs to the current user.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== PULL_ORIGIN_STORAGE_KEY) return
      _sharedPullOrigin = readStoredPullOrigin()
      setPullOrigin(_sharedPullOrigin)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const load = useCallback(async ({ keepVisible = false } = {}) => {
    // A background workbook refresh must not replace the discovery table with
    // a skeleton. Keeping the existing rows mounted preserves scroll position
    // while the latest SAM rows load in behind them.
    if (!keepVisible) setLoading(true)
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
      if (!keepVisible) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => onCacheRefresh(() => load({ keepVisible: true })), [load])

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
      setFailedStatuses((previous) => {
        if (!previous[rowIndex]) return previous
        const next = { ...previous }
        delete next[rowIndex]
        return next
      })
      debouncedInvalidate()
    } catch (err) {
      // No visual rollback — visual state stays changed for smooth UX.
      // The pending override is intentionally NOT cleared here: it keeps
      // reconciling to the optimistic value until a future refresh shows
      // the server genuinely agrees (e.g. after a manual retry), consistent
      // with the "no rollback on failure" behavior this hook already had.
      setFailedStatuses((previous) => ({
        ...previous,
        [rowIndex]: { status, message: err.message || 'Could not save this status' },
      }))
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
      'Submission Date (Response Date)*':        row['Response Date']        || '',
      'Other Links*':                            row['SAM.gov URL']          || '',
    })

    await updateStatus(row._rowIndex, outlook === 'Tracking' ? 'tracked' : 'added_to_pipeline')
  }, [resolveContact, updateStatus])

  // ── Trigger SAM pull ─────────────────────────────────────────────────
  // force=true bypasses the 12h throttle (used by Settings page force pull)
  const triggerPull = useCallback(async ({ force = false, resumeFrom = 0, source = 'opportunities' } = {}) => {
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
        resumeFrom,
      }),
    })

    const data = await res.json()

    if (!res.ok) throw new Error(data.error || `Worker returned ${res.status}`)

    // If throttled, return the throttle info so the UI can show the message
    if (data.throttled) return { throttled: true, message: data.message, lastRun: data.lastRun }

    // Pull started in the background on the Worker. Poll /sam/run-status so
    // the UI can show live progress and know exactly when it's actually
    // done — replaces a previous blind 5s timeout, which had no way to
    // tell whether the pull had finished, was still running, or had
    // silently gotten stuck.
    setSharedPullOrigin({
      source: resumeFrom ? 'recovery' : source,
      startedAt: Date.now(),
    })
    publishPullProgress({ status: 'running', phase: 'fetching', naicsProcessed: resumeFrom, naicsTotal: null })
    startSharedPullPolling()

    return { throttled: false, message: data.message }
  }, [])

  // ── Auto-resume a stalled run ─────────────────────────────────────────
  // If a previous pull got killed mid-run (most likely a Cloudflare
  // execution-time limit) without writing a final success/error status,
  // /sam/run-status is left showing status: 'running' forever with no
  // natural way for the user to know or recover — this is the "continue
  // pulling even if timeout occurs" ask. Checked once per browser session
  // when the Opportunities page first mounts.
  useEffect(() => {
    if (_resumeAttemptedThisSession) return
    _resumeAttemptedThisSession = true
    ;(async () => {
      const status = await getSAMRunStatus()
      if (status) publishPullProgress(status)
      if (status?.status === 'running' || status?.status === 'partial') {
        startSharedPullPolling()
      }
      // A partial status is handled by the continuation effect below. A
      // running status may need a recovery trigger if the Worker stopped
      // updating it before completing.
      if (status?.status === 'running' && status?.startedAt) {
        const age = Date.now() - new Date(status.startedAt).getTime()
        if (age > STALL_THRESHOLD_MS) {
          console.log('[SAM] Detected a stalled pull — auto-resuming')
          try {
            await triggerPull({ force: true, resumeFrom: status.nextNaicsIndex || 0, source: 'recovery' })
          } catch (err) {
            console.warn('[SAM] Auto-resume of a stalled pull failed:', err.message)
            publishPullProgress(null)
          }
        }
      }
    })()
  }, [triggerPull])

  // Each Worker invocation writes a bounded chunk to stay under execution
  // limits. Continue partial chunks automatically while the app is open,
  // rather than requiring the user to refresh and press Pull again.
  useEffect(() => {
    if (pullProgress?.status !== 'partial' || continuingRef.current) return
    const resumeFrom = Number(pullProgress.nextNaicsIndex) || 0
    const written = Number(pullProgress.written) || 0

    if (written === 0) {
      const previousZeroWritePartials = zeroWritePartialsRef.current.get(resumeFrom) || 0
      if (previousZeroWritePartials >= 1) {
        const error = 'Pull stopped to avoid repeating a zero-opportunity continuation. Please refresh after the deployed Worker update.'
        console.warn('[SAM]', error, { resumeFrom, pullProgress })
        publishPullProgress({ ...pullProgress, status: 'error', error })
        return
      }
      zeroWritePartialsRef.current.set(resumeFrom, previousZeroWritePartials + 1)
    } else {
      // A successful write means a repeated cursor is normal: the Worker
      // deliberately resumes the same NAICS code to process the next chunk.
      zeroWritePartialsRef.current.delete(resumeFrom)
    }

    continuingRef.current = true
    ;(async () => {
      try {
        await triggerPull({ resumeFrom, source: 'recovery' })
      } catch (err) {
        console.warn('[SAM] Automatic continuation failed:', err.message)
        publishPullProgress({ ...pullProgress, status: 'error', error: err.message })
      } finally {
        continuingRef.current = false
      }
    })()
  }, [pullProgress, triggerPull])

  const dismiss   = useCallback((rowIndex) => updateStatus(rowIndex, 'dismissed'), [updateStatus])
  const undismiss = useCallback((rowIndex) => updateStatus(rowIndex, 'new'),       [updateStatus])
  const retryStatus = useCallback((rowIndex) => {
    const failed = failedStatuses[rowIndex]
    if (!failed) return Promise.resolve()
    return updateStatus(rowIndex, failed.status)
  }, [failedStatuses, updateStatus])

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
    failedStatuses,
    retryStatus,
    triggerPull,
    pullProgress,
    pullOrigin,
  }
}
