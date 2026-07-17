import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const WORKER_URL = import.meta.env.VITE_API_BASE_URL
const DAILY_MS = 24 * 60 * 60 * 1000

function eligible(opportunity) {
  return ['new', 'tracked', 'added_to_pipeline'].includes(String(opportunity.Status || '').toLowerCase())
}

function payload(opportunity) {
  return {
    _rowIndex: opportunity._rowIndex,
    'Notice ID': opportunity['Notice ID'],
    'Solicitation Number': opportunity['Solicitation Number'],
    Title: opportunity.Title,
    Agency: opportunity.Agency,
    Department: opportunity.Department,
    Status: opportunity.Status || 'new',
    'SAM.gov URL': opportunity['SAM.gov URL'],
    'Date Added': opportunity['Date Added'],
  }
}

export function useSAMChangeMonitor(opportunities) {
  const [changesByRow, setChangesByRow] = useState({})
  const [run, setRun] = useState(null)
  const [checking, setChecking] = useState(false)
  const [progress, setProgress] = useState(null)
  const [checkError, setCheckError] = useState(null)
  const lastSyncFingerprint = useRef('')
  const automaticallyChecked = useRef(false)

  const monitored = useMemo(() => (opportunities || []).filter(eligible), [opportunities])

  const loadStatus = useCallback(async () => {
    if (!WORKER_URL) return null
    const response = await fetch(`${WORKER_URL}/sam/changes/status`)
    if (!response.ok) throw new Error('Could not load SAM change status')
    const data = await response.json()
    const next = {}
    ;(data.watches || []).forEach((watch) => { next[watch.rowIndex] = watch })
    setChangesByRow(next)
    setRun(data.run || null)
    return data
  }, [])

  const synchronize = useCallback(async () => {
    if (!WORKER_URL || monitored.length === 0) return
    const response = await fetch(`${WORKER_URL}/sam/changes/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opportunities: monitored.map(payload) }),
    })
    if (!response.ok) throw new Error('Could not synchronize SAM monitoring')
  }, [monitored])

  const checkChanges = useCallback(async () => {
    if (!WORKER_URL || checking || monitored.length === 0) return
    setChecking(true); setCheckError(null); setProgress({ checked: 0, total: monitored.length })
    try {
      await synchronize()
      let cursor = 0
      do {
        const response = await fetch(`${WORKER_URL}/sam/changes/check`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cursor }),
        })
        if (!response.ok) throw new Error('SAM change check failed')
        const result = await response.json()
        if (result.errors?.length) {
          setCheckError(`${result.errors.length} opportunit${result.errors.length === 1 ? 'y' : 'ies'} could not be checked. Try again later.`)
        }
        setProgress({ checked: Math.min(result.checked || 0, result.total || monitored.length), total: result.total || monitored.length })
        setRun(result)
        cursor = result.nextCursor
      } while (cursor !== null && cursor !== undefined)
      await loadStatus()
    } catch (error) {
      setCheckError(error.message || 'SAM change check failed')
      throw error
    } finally {
      setChecking(false)
    }
  }, [checking, loadStatus, monitored.length, synchronize])

  const markReviewed = useCallback(async (opportunity) => {
    if (!WORKER_URL) return
    const response = await fetch(`${WORKER_URL}/sam/changes/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(opportunity)),
    })
    if (!response.ok) throw new Error('Could not mark this SAM update as reviewed')
    await loadStatus()
  }, [loadStatus])

  // Sync exactly when the monitored list changes. New rows are not marked as
  // changed until a later SAM response differs from their first baseline.
  useEffect(() => {
    if (!WORKER_URL || monitored.length === 0) return
    const fingerprint = monitored.map((item) => `${item._rowIndex}:${item.Status}:${item['Notice ID']}:${item['Solicitation Number']}`).join('|')
    if (fingerprint === lastSyncFingerprint.current) return
    lastSyncFingerprint.current = fingerprint
    synchronize().then(loadStatus).catch(() => {})
  }, [loadStatus, monitored, synchronize])

  // Daily while the application is in use. The on-demand button remains
  // available for immediate verification without triggering a discovery pull.
  useEffect(() => {
    if (automaticallyChecked.current || !monitored.length || !WORKER_URL) return
    automaticallyChecked.current = true
    loadStatus().then((data) => {
      const checkedAt = data?.run?.checkedAt ? new Date(data.run.checkedAt).getTime() : 0
      if (!checkedAt || Date.now() - checkedAt >= DAILY_MS) checkChanges().catch(() => {})
    }).catch(() => {})
  }, [checkChanges, loadStatus, monitored.length])

  return { changesByRow, checking, progress, checkError, run, checkChanges, markReviewed, loadStatus }
}
